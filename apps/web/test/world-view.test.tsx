// @vitest-environment jsdom
/**
 * UI tests for `WorldView` / the page shell's world wiring.
 *
 * These mount real components in a DOM (so effects, event listeners, and
 * re-renders actually run). They consume only the Organizer-facing API
 * (`organizer/index.ts`) plus its test-only fetch hook, `setWorldFetch`; they
 * never import Protocol, backend, or Node modules, and they never call `fetch`
 * themselves.
 *
 * The world itself is rendered by Three.js through the Render ISA, which needs a
 * real WebGL context. The runtime module is therefore mocked with a recording
 * responder for this file: these tests cover the HUD (controls, keyboard, status,
 * retry, mount) while `scene-view.test.tsx` covers the bridge/runtime wiring.
 *
 * After the Phase-4 primitive migration the client controls an **actor** named by
 * `controlledActorId`. The move command carries only a direction: the client
 * cannot name the actor it acts as, so the request body must not contain an
 * actor/player id.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getWorldState,
  loadWorld,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setWorldFetch,
} from '../src/organizer/index.ts';
import { App } from '../src/ui/App.tsx';
import { WorldView } from '../src/ui/WorldView.tsx';
import type { RenderFrame } from '../src/render/bridge.ts';

/** Shared recorder for the mocked Three.js runtime (hoisted for `vi.mock`). */
const mockRuntime = vi.hoisted(() => ({
  frames: [] as RenderFrame[],
  mountCalls: 0,
}));

// Replace the WebGL runtime with a recording no-op so mounting `<App />` /
// `<WorldView />` under jsdom never needs a canvas or WebGL context.
vi.mock('../src/render/three/runtime.ts', () => ({
  createThreeRuntime: () => ({
    mount: () => {
      mockRuntime.mountCalls += 1;
    },
    apply: (frame: RenderFrame) => {
      mockRuntime.frames.push(frame);
    },
    update: () => {},
    inspect: () => ({
      mounted: false,
      lights: 0,
      ground: false,
      camera: { left: 0, right: 0, top: 0, bottom: 0 },
      nodes: [],
      buckets: [],
    }),
    dispose: () => {},
  }),
}));

/** Does any recorded frame contain a command of `type`? */
function hasCommand(frames: readonly RenderFrame[], type: RenderFrame[number]['type']): boolean {
  return frames.some((frame) => frame.some((command) => command.type === type));
}

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

// Arbitrary: the protocol guard accepts any finite integer, the UI never reads
// this field, and a real client-side version gate belongs in the Organizer
// using the contract constant. It is only here to shape a valid fixture.
const ARBITRARY_PROTOCOL_VERSION = 1;

const VALID_ENTITY = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: { x: 3, y: 4 },
  visible: true,
};

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  size: { width: 10, height: 8 },
  tiles: [
    { transform: { x: 0, y: 0 }, terrain: 'grass' },
    { transform: { x: 3, y: 4 }, terrain: 'path' },
  ],
  entities: [VALID_ENTITY],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

const VALID_GAME_INFO_RESPONSE = {
  gameInfo: {
    gameName: 'Starvalley',
    serverVersion: '0.1.0',
    protocolVersion: ARBITRARY_PROTOCOL_VERSION,
    serverTime: SERVER_TIME,
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

/** Build a valid `SubmitCommandResponse` body from a transformed entity. */
function moveResponse(x: number, y: number): unknown {
  return {
    events: [{ type: 'transform.changed', entityId: 'entity-a', transform: { x, y } }],
    serverTime: SERVER_TIME,
  };
}

interface CapturedRequest {
  method: string | undefined;
  body: unknown;
}

/** Load a valid world snapshot so world-dependent tests start from `ready`. */
async function loadValidWorld(): Promise<void> {
  setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
  await loadWorld();
}

/** Record move requests made through the Organizer's injectable fetch. */
function captureMoves(requests: CapturedRequest[]): void {
  setWorldFetch(async (_url, init) => {
    requests.push({
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return fakeResponse(moveResponse(4, 4));
  });
}

/** Dispatch a real, cancelable keydown so `defaultPrevented` is observable. */
function pressKey(key: string, init: KeyboardEventInit = {}): boolean {
  let prevented = false;
  act(() => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

beforeEach(() => {
  mockRuntime.frames.length = 0;
  mockRuntime.mountCalls = 0;
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
});

afterEach(() => {
  cleanup();
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
});

describe('WorldView rendering', () => {
  it('renders the scene canvas and the controlled actor tile coordinates', async () => {
    await loadValidWorld();

    render(<WorldView />);

    const canvas = screen.getByTestId('scene-canvas');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.getAttribute('class')).toBe('scene-view__canvas');

    // The recorder proves the bridge actually fed the runtime a create command,
    // rather than the assertions merely querying the DOM that always mounts.
    await waitFor(() => {
      expect(mockRuntime.mountCalls).toBe(1);
      expect(hasCommand(mockRuntime.frames, 'node.create')).toBe(true);
    });

    const info = screen.getByTestId('controlled-actor-info');
    expect(info.textContent).toContain('(3, 4)');

    // The DOM grid and player marker are gone: the scene is the renderer.
    expect(screen.queryByTestId('world-grid')).toBeNull();
    expect(screen.queryByTestId('controlled-actor')).toBeNull();
  });

  it('renders a loading indication before the world is ready', () => {
    render(<WorldView />);

    const panel = screen.getByTestId('world-panel');
    expect(panel.getAttribute('data-status')).toBe('idle');
    const loading = within(panel).getByText(/Loading world/i);
    expect(loading.tagName).toBe('P');
    expect(loading.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('controlled-actor-info')).toBeNull();
    // No world snapshot -> no runtime is created, but the canvas still renders.
    expect(screen.getByTestId('scene-canvas').tagName).toBe('CANVAS');
  });
});

describe('WorldView direction controls', () => {
  it('disables every direction control before the world is ready', () => {
    render(<WorldView />);

    for (const direction of ['north', 'south', 'east', 'west']) {
      const button = screen.getByTestId(`move-${direction}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
  });

  it('issues exactly one direction-only move for the clicked direction', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);
    fireEvent.click(screen.getByTestId('move-east'));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // The UI's intent is the direction alone: the server resolves which actor
    // the caller controls, so the client must not be able to name one.
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ type: 'actor.move', direction: 'east' });
    expect(requests[0].body).not.toHaveProperty('actorId');
    expect(requests[0].body).not.toHaveProperty('playerId');

    // And exactly one: no duplicate dispatch on top of the click.
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    // The move also reached the render runtime as an interpolation target.
    await waitFor(() => {
      expect(hasCommand(mockRuntime.frames, 'transform.setTarget')).toBe(true);
    });
  });
});

describe('WorldView keyboard input', () => {
  it('maps ArrowRight to an east move, prevents default, and ignores auto-repeat', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);

    const prevented = pressKey('ArrowRight');
    expect(prevented).toBe(true);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({ type: 'actor.move', direction: 'east' });

    // A repeat event is the same physical press held down; it must not move again.
    pressKey('ArrowRight', { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
  });

  it('ignores modifier-key presses but still moves on the unmodified press', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);

    // Ctrl/Cmd/Alt chords are browser/OS shortcuts, not movement intent.
    pressKey('ArrowRight', { ctrlKey: true });
    pressKey('ArrowRight', { metaKey: true });
    pressKey('ArrowRight', { altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);

    // The bare press still produces exactly the one move the guard let through.
    pressKey('ArrowRight');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({ type: 'actor.move', direction: 'east' });
  });
});

describe('WorldView load failure', () => {
  it('renders the Organizer message and recovers through Retry', async () => {
    let worldCalls = 0;
    setWorldFetch(async () => {
      worldCalls += 1;
      if (worldCalls === 1) {
        throw new TypeError('Failed to fetch');
      }
      return fakeResponse(VALID_WORLD_RESPONSE);
    });
    setGameInfoFetch(async () => fakeResponse(VALID_GAME_INFO_RESPONSE));

    render(<App />);

    const panel = screen.getByTestId('world-panel');
    const alert = await within(panel).findByRole('alert');

    const message = getWorldState().error;
    expect(message).toBeTruthy();
    if (message === null) {
      throw new Error('expected the organizer to expose an error message');
    }
    expect(alert.textContent).toContain(message);
    expect(screen.queryByTestId('controlled-actor-info')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await screen.findByTestId('controlled-actor-info');
    expect(worldCalls).toBe(2);
    expect(screen.getByTestId('controlled-actor-info').textContent).toContain('(3, 4)');
  });
});

describe('App mount', () => {
  it('starts the world load on mount', async () => {
    let worldCalls = 0;
    setWorldFetch(async () => {
      worldCalls += 1;
      return fakeResponse(VALID_WORLD_RESPONSE);
    });
    setGameInfoFetch(async () => fakeResponse(VALID_GAME_INFO_RESPONSE));

    render(<App />);

    // The mount effect has already driven the store out of `idle`. Remove the
    // `useEffect(() => void loadWorld(), [])` in App and this fails: the store
    // stays `idle` and the controlled actor never appears.
    expect(getWorldState().status).not.toBe('idle');

    await screen.findByTestId('controlled-actor-info');
    expect(worldCalls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });
});
