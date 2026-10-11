// @vitest-environment jsdom
/**
 * UI tests for `WorldView` / the page shell's world wiring.
 *
 * These tests mount real components in a DOM (so effects, event listeners, and
 * re-renders actually run). They consume only the Organizer-facing API
 * (`organizer/index.ts`) plus its test-only fetch hook, `setWorldFetch`; they
 * never import Protocol, backend, or Node modules, and they never call `fetch`
 * themselves.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

const VALID_PLAYER = {
  id: 'player-1',
  name: 'Alex',
  position: { x: 3, y: 4 },
};

const VALID_SNAPSHOT = {
  size: { width: 10, height: 8 },
  player: VALID_PLAYER,
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

const VALID_GAME_INFO_RESPONSE = {
  gameInfo: {
    gameName: 'Starvalley',
    serverVersion: '0.1.0',
    protocolVersion: 1,
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

/** Build a valid `MovePlayerResponse` body. */
function moveResponse(position: { x: number; y: number }, moved = true): unknown {
  return {
    result: {
      player: { ...VALID_PLAYER, position },
      moved,
      serverTime: SERVER_TIME,
    },
  };
}

interface CapturedRequest {
  url: string;
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
  setWorldFetch(async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return fakeResponse(moveResponse({ x: 4, y: 4 }));
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
  it('renders the grid with the Organizer dimensions and the marker on the player tile', async () => {
    await loadValidWorld();

    render(<WorldView />);

    const grid = screen.getByTestId('world-grid');
    expect(grid.getAttribute('data-width')).toBe('10');
    expect(grid.getAttribute('data-height')).toBe('8');

    const marker = screen.getByTestId('player');
    expect(marker.getAttribute('data-x')).toBe('3');
    expect(marker.getAttribute('data-y')).toBe('4');

    // The player's name and tile coordinates are exposed to the user.
    const info = screen.getByTestId('player-info');
    expect(within(info).getByText('Alex')).toBeTruthy();
    expect(info.textContent).toContain('(3, 4)');
  });

  it('renders a loading indication before the world is ready', () => {
    render(<WorldView />);

    const panel = screen.getByTestId('world-panel');
    expect(panel.getAttribute('data-status')).toBe('idle');
    expect(within(panel).getByText(/Loading world/i)).toBeTruthy();
    expect(screen.queryByTestId('world-grid')).toBeNull();
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

  it('issues exactly one move for the clicked direction, built from the loaded player', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);
    fireEvent.click(screen.getByTestId('move-east'));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/api/player/move');
    expect(requests[0].body).toEqual({ playerId: 'player-1', direction: 'east' });

    // And exactly one: no duplicate dispatch on top of the click.
    await Promise.resolve();
    expect(requests).toHaveLength(1);
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
    expect(requests[0].body).toEqual({ playerId: 'player-1', direction: 'east' });

    // A repeat event is the same physical press held down; it must not move again.
    pressKey('ArrowRight', { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
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
    expect(screen.queryByTestId('world-grid')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await screen.findByTestId('world-grid');
    expect(worldCalls).toBe(2);
    expect(within(panel).getByTestId('world-grid').getAttribute('data-width')).toBe('10');
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
    // stays `idle` and the grid never appears.
    expect(getWorldState().status).not.toBe('idle');

    await screen.findByTestId('world-grid');
    expect(worldCalls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });
});
