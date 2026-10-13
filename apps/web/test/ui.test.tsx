import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getGameInfoState,
  loadGameInfo,
  resetGameInfoFetch,
  resetGameInfoState,
  setGameInfoFetch,
} from '../src/organizer/index.ts';
import { GameInfoPanel } from '../src/ui/GameInfoPanel.tsx';

/**
 * SSR smoke tests. `renderToStaticMarkup` runs no effects, so each case drives
 * the Organizer store directly (via its exported test hook) and then renders the
 * resulting state. No DOM, no jsdom, no testing-library.
 */

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

const VALID_RESPONSE = {
  gameInfo: VALID_GAME_INFO,
  blockKinds: [
    { kind: 'grass', orientable: false },
    { kind: 'stone', orientable: true },
  ],
  entityKinds: [
    {
      kind: 'tree',
      footprintX: 1,
      footprintZ: 1,
      height: 2,
      allowedYawSteps: [0],
      pivot: 'center',
    },
  ],
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

function renderPanel(): string {
  return renderToStaticMarkup(createElement(GameInfoPanel));
}

beforeEach(() => {
  resetGameInfoState();
  resetGameInfoFetch();
});

afterEach(() => {
  resetGameInfoState();
  resetGameInfoFetch();
});

describe('GameInfoPanel', () => {
  it('renders without throwing and exposes data-status="idle" initially', () => {
    const html = renderPanel();

    expect(html).toContain('data-testid="game-info-panel"');
    expect(html).toContain('data-status="idle"');
    expect(html).toContain('Contacting server');
  });

  it('renders the game name and server version once the organizer is connected', async () => {
    setGameInfoFetch(async () => fakeResponse(VALID_RESPONSE));
    await loadGameInfo();

    expect(getGameInfoState().status).toBe('connected');

    const html = renderPanel();
    expect(html).toContain('data-status="connected"');
    expect(html).toContain(VALID_GAME_INFO.gameName);
    expect(html).toContain(VALID_GAME_INFO.serverVersion);
    expect(html).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('renders the organizer error message and a Retry control', async () => {
    setGameInfoFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await loadGameInfo();

    const state = getGameInfoState();
    const error = state.error;
    expect(state.status).toBe('error');
    expect(error).toBeTruthy();
    if (error === null) {
      throw new Error('expected the organizer to expose an error message');
    }

    const html = renderPanel();
    expect(html).toContain('data-status="error"');
    expect(html).toContain(error);
    expect(html).toContain('Retry');
  });
});
