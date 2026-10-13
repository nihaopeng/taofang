// @vitest-environment jsdom
/**
 * Startup-path tests for the page shell.
 *
 * Unlike `ui.test.tsx` (which renders `GameInfoPanel` with
 * `renderToStaticMarkup` and therefore never runs effects), these tests mount
 * the real `<App />` in a DOM. That is the only way to prove that the mount
 * effect in `App.tsx` actually starts the Organizer load: if
 * `useEffect(() => void loadGameInfo(), [])` were deleted, the store would stay
 * `idle`, the fake fetch would never be called, and the "game name" assertion
 * below would time out.
 *
 * The tests consume only the Organizer-facing API (`organizer/index.ts`). They
 * never import Protocol, backend, or Node modules.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getGameInfoState,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setWorldFetch,
} from '../src/organizer/index.ts';
import { App } from '../src/ui/App.tsx';

// `<App />` now embeds the Three.js `<SceneView />`. This file is about the
// page-shell startup path, not rendering, so the WebGL runtime is replaced with
// a no-op and the world fetch is stubbed to keep the test hermetic.
vi.mock('../src/render/three/runtime.ts', () => ({
  RENDER_CAMERA: {
    pitchDegrees: 35,
    minPitchDegrees: 25,
    maxPitchDegrees: 75,
    fovDegrees: 28,
    minNear: 0.5,
    nearClearance: 1,
    verticalHeadroom: 1,
    framingMargin: 1.2,
    minZoom: 0.25,
    maxZoom: 8,
  },
  createThreeRuntime: () => ({
    mount: () => {},
    apply: () => {},
    update: () => {},
    setFollowTarget: () => {},
    getCameraState: () => ({
      pitchDegrees: 35,
      yawDegrees: 0,
      zoom: 1,
      focus: { x: 0, y: 0, z: 0 },
    }),
    setCameraOrientation: () => {},
    setCameraPitch: () => {},
    setZoom: () => {},
    setGridOverlayVisible: () => {},
    setHighlightedCell: () => {},
    pick: () => null,
    inspect: () => ({
      mounted: false,
      lights: 0,
      ground: false,
      background: null,
      groups: 0,
      shadow: null,
      camera: {
        fovDegrees: 28,
        near: 0.1,
        far: 100,
        aspect: 1,
        pitchDegrees: 35,
        yawDegrees: 0,
        zoom: 1,
        focus: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
      },
      nodes: [],
      buckets: [],
      gridOverlay: {
        visible: false,
        highlightedCell: null,
        lineObjectCount: 1,
        highlightMarkerCount: 1,
      },
    }),
    dispose: () => {},
  }),
}));

// Arbitrary: the protocol guard accepts any finite integer, the UI never reads
// this field, and a real client-side version gate belongs in the Organizer
// using the contract constant. It is only here to shape a valid fixture.
const ARBITRARY_PROTOCOL_VERSION = 1;

const VALID_GAME_INFO = {
  gameName: 'Starvalley',
  serverVersion: '0.1.0',
  protocolVersion: ARBITRARY_PROTOCOL_VERSION,
  serverTime: '2025-01-02T03:04:05.000Z',
};

const VALID_RESPONSE = { gameInfo: VALID_GAME_INFO };

// A minimal valid world so `<App />`'s world load settles without network access.
const VALID_WORLD_RESPONSE = {
  world: {
    worldId: 'world-1',
    bounds: { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } },
    grid: { origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 },
    tiles: [{ cell: { x: 0, z: 0 }, terrain: 'grass' }],
    entities: [],
    controlledActorId: null,
    serverTime: VALID_GAME_INFO.serverTime,
  },
};

/** Minimal `Response` stand-in: the organizer only reads `ok`, `status`, `json`. */
function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

beforeEach(() => {
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
  setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
});

afterEach(() => {
  cleanup();
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
});

describe('App mount', () => {
  it('starts the game-info load on mount and renders the loaded game name', async () => {
    let calls = 0;
    setGameInfoFetch(async () => {
      calls += 1;
      return fakeResponse(VALID_RESPONSE);
    });

    render(<App />);

    const panel = screen.getByTestId('game-info-panel');
    // This query only succeeds once the mount effect has driven the Organizer
    // through `idle -> connecting -> connected` and the panel has re-rendered.
    // Remove the effect and this rejects, so the assertion genuinely depends on it.
    const gameNameNode = await within(panel).findByText(VALID_GAME_INFO.gameName);
    expect(gameNameNode.textContent).toBe(VALID_GAME_INFO.gameName);

    expect(calls).toBe(1);
    expect(getGameInfoState().status).toBe('connected');
    expect(getGameInfoState().status).not.toBe('idle');
    expect(panel.getAttribute('data-status')).toBe('connected');
    expect(within(panel).getByText(VALID_GAME_INFO.serverVersion)).toBeTruthy();
  });

  it('retries after an error and recovers to connected', async () => {
    let calls = 0;
    setGameInfoFetch(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('Failed to fetch');
      }
      return fakeResponse(VALID_RESPONSE);
    });

    render(<App />);

    const panel = screen.getByTestId('game-info-panel');
    // The first (mount-driven) fetch rejects, so the retry control appears.
    const retryButton = await within(panel).findByRole('button', { name: 'Retry' });
    expect(calls).toBe(1);
    expect(getGameInfoState().status).toBe('error');
    expect(panel.getAttribute('data-status')).toBe('error');

    // A real interaction must issue a second Organizer intent.
    fireEvent.click(retryButton);

    await within(panel).findByText(VALID_GAME_INFO.gameName);
    expect(calls).toBe(2);
    expect(getGameInfoState().status).toBe('connected');
    expect(panel.getAttribute('data-status')).toBe('connected');
  });
});
