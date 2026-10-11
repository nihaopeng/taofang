/**
 * Organizer unit tests for the Phase-2 world / player / movement feature.
 *
 * Focuses on the client-application contract: request lifecycle, protocol
 * validation, no-optimism reconciliation, and deterministic move serialization.
 * Transport mechanics are injected through `setWorldFetch`.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getWorldState,
  loadWorld,
  movePlayer,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setWorldFetch,
  subscribeWorld,
  useWorld,
} from '../src/organizer/index.ts';
import type { WorldState } from '../src/organizer/index.ts';

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

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
}

/** Minimal `Response` stand-in: the organizer only reads `ok`, `status`, `json`. */
function fakeResponse(body: unknown, init: FakeResponseInit = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

/** A promise whose settlement the test controls explicitly (no timers/sleeps). */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Load a valid world so move tests start from a `ready` state. */
async function loadValidWorld(): Promise<void> {
  setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
  await loadWorld();
}

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
});

afterEach(() => {
  // Ensure a deferred/stubbed fetch can never leak into the next test.
  resetWorldFetch();
  resetWorldState();
});

describe('loadWorld', () => {
  it('maps a valid Protocol snapshot into ready state', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(VALID_WORLD_RESPONSE);
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(calls).toBe(1);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.world).toEqual({ width: 10, height: 8 });
    expect(state.player).toEqual({ id: 'player-1', name: 'Alex', x: 3, y: 4 });
  });

  it('maps a network rejection to an error state with no partial data', async () => {
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.world).toBeNull();
    expect(state.player).toBeNull();
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
    expect(state.error).not.toContain('fetch');
  });

  it('maps a non-2xx response to an error that mentions the status', async () => {
    setWorldFetch(async () =>
      fakeResponse(
        { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        { ok: false, status: 503 },
      ),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.world).toBeNull();
    expect(state.player).toBeNull();
    expect(state.error).toContain('503');
  });

  it('rejects the superseded nested-snapshot payload and keeps no partial data', async () => {
    // Old contract shape (`world.size` nested under an outer `world` key). It is
    // structurally invalid for the current `WorldSnapshot`, so the guard must
    // reject it rather than silently reading a missing field.
    setWorldFetch(async () =>
      fakeResponse({
        world: { world: { size: { width: 10, height: 8 } }, player: VALID_PLAYER, serverTime: SERVER_TIME },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.world).toBeNull();
    expect(state.player).toBeNull();
    expect(state.error).toBeTruthy();
  });

  it('treats unparseable JSON as a contract failure', async () => {
    const badBody = {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    };
    setWorldFetch(async () => badBody as unknown as Response);

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('SyntaxError');
  });

  it('dedupes concurrent loads into a single fetch', async () => {
    let calls = 0;
    const deferred = createDeferred<Response>();
    setWorldFetch(() => {
      calls += 1;
      return deferred.promise;
    });

    const first = loadWorld();
    const second = loadWorld();

    expect(calls).toBe(1);
    expect(first).toBe(second);

    deferred.resolve(fakeResponse(VALID_WORLD_RESPONSE));
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });

  it('notifies subscribers synchronously across the lifecycle', async () => {
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next.status);
    });

    const settled = loadWorld();
    expect(seen).toEqual(['loading']);

    deferred.resolve(fakeResponse(VALID_WORLD_RESPONSE));
    await settled;
    expect(seen).toEqual(['loading', 'ready']);

    unsubscribe();
  });
});

describe('movePlayer', () => {
  it('updates the position to the server-returned position on success', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(moveResponse({ x: 4, y: 4 })));

    await movePlayer('east');

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.player).toMatchObject({ x: 4, y: 4 });
  });

  it('sends the command built from the loaded playerId and direction', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    setWorldFetch(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return fakeResponse(moveResponse({ x: 4, y: 4 }));
    });

    await movePlayer('east');

    expect(bodies).toEqual([{ playerId: 'player-1', direction: 'east' }]);
  });

  it('does not move optimistically while the request is in flight', async () => {
    await loadValidWorld();
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const pending = movePlayer('east');

    // Position must still be the old authoritative one before the response.
    expect(getWorldState().player).toMatchObject({ x: 3, y: 4 });
    expect(getWorldState().status).toBe('ready');

    deferred.resolve(fakeResponse(moveResponse({ x: 4, y: 4 })));
    await pending;

    expect(getWorldState().player).toMatchObject({ x: 4, y: 4 });
  });

  it('leaves the position unchanged and reports no error on a refused step', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(moveResponse({ x: 3, y: 4 }, false)));

    await movePlayer('west');

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.player).toMatchObject({ x: 3, y: 4 });
  });

  it('serializes moves with a single in-flight slot and latest wins', async () => {
    await loadValidWorld();

    const bodies: Array<Record<string, unknown>> = [];
    const deferreds = [createDeferred<Response>(), createDeferred<Response>()];
    let calls = 0;
    setWorldFetch((_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      const deferred = deferreds[calls];
      calls += 1;
      return deferred.promise;
    });

    const first = movePlayer('east');
    const second = movePlayer('south');
    const third = movePlayer('west');

    // Only the first request is in flight; `south` was superseded by `west`.
    expect(calls).toBe(1);
    expect(bodies).toEqual([{ playerId: 'player-1', direction: 'east' }]);

    deferreds[0].resolve(fakeResponse(moveResponse({ x: 4, y: 4 })));
    await first;

    // Once the first settles, exactly one more request is sent, with the latest
    // queued direction.
    expect(calls).toBe(2);
    expect(bodies).toEqual([
      { playerId: 'player-1', direction: 'east' },
      { playerId: 'player-1', direction: 'west' },
    ]);
    expect(getWorldState().player).toMatchObject({ x: 4, y: 4 });

    deferreds[1].resolve(fakeResponse(moveResponse({ x: 3, y: 4 })));
    await Promise.all([second, third]);

    expect(calls).toBe(2);
    expect(getWorldState().player).toMatchObject({ x: 3, y: 4 });
  });

  it('is a safe no-op before any world is loaded', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(moveResponse({ x: 4, y: 4 }));
    });

    await expect(movePlayer('east')).resolves.toBeUndefined();

    expect(calls).toBe(0);
    const state = getWorldState();
    expect(state.status).toBe('idle');
    expect(state.player).toBeNull();
  });

  it('maps a 404 move response to a user-presentable error', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(
        { error: { code: 'NOT_FOUND', message: 'unknown player' } },
        { ok: false, status: 404 },
      ),
    );

    await expect(movePlayer('east')).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('404');
    expect(state.error?.toLowerCase()).toContain('player');
  });

  it('maps a network failure during a move to an error state', async () => {
    await loadValidWorld();
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await movePlayer('east');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
  });

  it('maps a malformed move payload to a contract error', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse({ result: { moved: true } }));

    await movePlayer('east');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
  });
});

describe('world store identity and subscription', () => {
  it('returns a stable state reference while nothing changes', () => {
    const first = getWorldState();
    expect(getWorldState()).toBe(first);

    const unsubscribe = subscribeWorld(() => {});
    expect(getWorldState()).toBe(first);
    unsubscribe();
  });

  it('resetWorldState returns to idle and drains queued moves', async () => {
    await loadValidWorld();

    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const inFlight = movePlayer('east');
    const queued = movePlayer('south');

    const seen: WorldState[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next);
    });

    resetWorldState();

    const state = getWorldState();
    expect(state.status).toBe('idle');
    expect(state.world).toBeNull();
    expect(state.player).toBeNull();
    expect(seen).toHaveLength(1);

    unsubscribe();
    resetWorldState();
    expect(seen).toHaveLength(1);

    // The queued caller must not hang after the reset.
    deferred.resolve(fakeResponse(moveResponse({ x: 4, y: 4 })));
    await Promise.all([inFlight, queued]);
    expect(getWorldState().status).toBe('idle');
  });

  it('unsubscribe stops notifications', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next.status);
    });
    unsubscribe();

    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await loadWorld();

    expect(seen).toEqual([]);
  });
});

describe('resource isolation', () => {
  it('keeps the world fetch hook independent from the game-info hook', async () => {
    setGameInfoFetch(async () => {
      throw new Error('game-info transport must not be used for the world');
    });
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));

    await loadWorld();

    expect(getWorldState().status).toBe('ready');
  });
});

describe('useWorld', () => {
  function StatusProbe() {
    const state = useWorld();
    return createElement('span', null, state.status);
  }

  it('renders through getServerSnapshot for SSR', () => {
    resetWorldState();
    expect(renderToStaticMarkup(createElement(StatusProbe))).toContain('idle');
  });
});
