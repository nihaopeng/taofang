/**
 * Organizer unit tests for the Phase-7 continuous-3D world feature.
 *
 * Focuses on the client-application contract: the snapshot request lifecycle,
 * canonical Protocol validation, derivation of tile world positions from the
 * grid, realtime stream adoption/retry, authoritative-event reconciliation,
 * derived (never predicted) movement, and deterministic intent serialization.
 * Both transports are injected: `setWorldFetch` for HTTP and
 * `setWorldEventSource` for the SSE stream. Nothing here touches a real network.
 *
 * The client is authoritative-only: a snapshot and a stream `events` frame are the
 * only things that move an entity; `setMovementIntent` sends a direction and
 * changes no client position. There is no prediction and no interpolation.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_PATH, STREAM_PATH } from '@starvalley/protocol';
import type { GameEvent } from '@starvalley/protocol';

import {
  getWorldState,
  loadWorld,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setMovementIntent,
  setWorldEventSource,
  setWorldFetch,
  subscribeWorld,
  useWorld,
} from '../src/organizer/index.ts';
import type { WorldState } from '../src/organizer/index.ts';
// Internal seam (not re-exported by the public organizer index); see the test
// below for why the applier's defensive tolerance is only observable here.
import { applyEvents } from '../src/organizer/world-store.ts';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';
const WORLD_ID = 'world-main';

// A non-trivial grid origin/cellSize proves the frozen derivation is used and
// that nothing hardcodes 1-unit cells or a world-origin-bound grid.
const GRID = {
  origin: { x: 10, y: 0.5, z: -4 },
  width: 3,
  depth: 2,
  cellSize: 2,
};

const BOUNDS = {
  min: { x: 8, y: 0, z: -6 },
  max: { x: 16, y: 4, z: 1 },
};

const ENTITY_A = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: {
    position: { x: 3, y: 0, z: 4 },
    rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
  },
  visible: true,
};

const ENTITY_B = {
  entityId: 'entity-b',
  actorId: null,
  kind: 'tree',
  transform: {
    position: { x: 1, y: 0, z: 2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  visible: true,
};

const ENTITY_C = {
  entityId: 'entity-c',
  actorId: null,
  kind: 'tree',
  transform: {
    position: { x: 7, y: 0, z: 7 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  visible: false,
};

// Deliberately scrambled wire order: the deterministic mapper must re-sort by
// `cellZ` then `cellX` so the snapshot's tile array does not depend on iteration
// order. The derived positions use `origin + (cell + 0.5) * cellSize`.
const TILE_PATH = { cell: { x: 1, z: 0 }, terrain: 'path' };
const TILE_BLOCKED = { cell: { x: 0, z: 1 }, terrain: 'blocked' };
const TILE_GRASS = { cell: { x: 0, z: 0 }, terrain: 'grass' };

const TILE_GRASS_VM = {
  cellX: 0,
  cellZ: 0,
  position: { x: 11, y: 0.5, z: -3 },
  terrain: 'grass',
};
const TILE_PATH_VM = {
  cellX: 1,
  cellZ: 0,
  position: { x: 13, y: 0.5, z: -3 },
  terrain: 'path',
};
const TILE_BLOCKED_VM = {
  cellX: 0,
  cellZ: 1,
  position: { x: 11, y: 0.5, z: -1 },
  terrain: 'blocked',
};
const ORDERED_TILES = [TILE_GRASS_VM, TILE_PATH_VM, TILE_BLOCKED_VM];

const ENTITY_A_VM = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  position: { x: 3, y: 0, z: 4 },
  rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
  visible: true,
};

const ENTITY_B_VM = {
  entityId: 'entity-b',
  actorId: null,
  kind: 'tree',
  position: { x: 1, y: 0, z: 2 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  visible: true,
};

const SNAPSHOT = {
  worldId: WORLD_ID,
  bounds: BOUNDS,
  grid: GRID,
  tiles: [TILE_PATH, TILE_BLOCKED, TILE_GRASS],
  entities: [ENTITY_A, ENTITY_B],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const WORLD_RESPONSE = { world: SNAPSHOT };

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

/** Build a valid `GameEventBatch` body from a list of events. */
function commandResponse(events: unknown[]): unknown {
  return { events, serverTime: SERVER_TIME };
}

/** Build a valid `WorldSnapshot` envelope with field overrides. */
function snapshotWith(overrides: Record<string, unknown>): unknown {
  return { world: { ...SNAPSHOT, ...overrides } };
}

function transformChanged(
  entityId: string,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 },
): unknown {
  return { type: 'transform.changed', entityId, transform: { position, rotation } };
}

function entitySpawned(entity: unknown): unknown {
  return { type: 'entity.spawned', entity };
}

function entityRemoved(entityId: string): unknown {
  return { type: 'entity.removed', entityId };
}

/** A `WorldStreamMessage` carrying an `events` batch. */
function eventsFrame(events: unknown[]): unknown {
  return { type: 'events', batch: commandResponse(events) };
}

/** A `WorldStreamMessage` carrying a full snapshot. */
function snapshotFrame(snapshot: unknown): unknown {
  return { type: 'snapshot', snapshot };
}

/** Test double for `EventSource`, driven synchronously by the test. */
class FakeEventSource {
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closeCalls = 0;
  private readonly messageListeners: Array<(event: { data: string }) => void> = [];

  constructor(readonly url: string) {}

  addEventListener(type: 'message', listener: (event: { data: string }) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener);
    }
  }

  close(): void {
    this.closeCalls += 1;
  }

  open(): void {
    this.onopen?.(undefined);
  }

  fail(): void {
    this.onerror?.(undefined);
  }

  message(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }
}

/** Stream connections created since the last `beforeEach`. */
let streamSources: FakeEventSource[] = [];

/** Find an entity view model by id (throws if absent). */
function entity(state: WorldState, entityId: string) {
  const found = state.entities.find((candidate) => candidate.entityId === entityId);
  if (found === undefined) {
    throw new Error(`entity ${entityId} not present`);
  }
  return found;
}

/** Load a valid world (with an injected stream) so feature tests start `ready`. */
async function loadValidWorld(): Promise<void> {
  setWorldFetch(async () => fakeResponse(WORLD_RESPONSE));
  await loadWorld();
}

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  streamSources = [];
  setWorldEventSource((url) => {
    const source = new FakeEventSource(url);
    streamSources.push(source);
    return source;
  });
});

afterEach(() => {
  // Ensure a deferred/stubbed transport or a pending retry can never leak.
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  vi.useRealTimers();
});

describe('loadWorld snapshot mapping', () => {
  it('maps worldId/bounds/grid/tiles/entities/controlledActorId into ready state', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(WORLD_RESPONSE);
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(calls).toBe(1);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe(WORLD_ID);
    expect(state.bounds).toEqual(BOUNDS);
    expect(state.grid).toEqual(GRID);
    expect(state.tiles).toEqual(ORDERED_TILES);
    expect(state.entities).toEqual([ENTITY_A_VM, ENTITY_B_VM]);
    expect(state.controlledActorId).toBe('actor-1');
  });

  it('derives each tile world position with origin + (cell + 0.5) * cellSize', async () => {
    await loadValidWorld();

    const tiles = getWorldState().tiles;
    const at = (cellX: number, cellZ: number) =>
      tiles.find((tile) => tile.cellX === cellX && tile.cellZ === cellZ);

    expect(at(0, 0)?.position).toEqual({ x: 11, y: 0.5, z: -3 });
    expect(at(1, 0)?.position).toEqual({ x: 13, y: 0.5, z: -3 });
    expect(at(0, 1)?.position).toEqual({ x: 11, y: 0.5, z: -1 });
  });

  it('orders tiles deterministically by cellZ then cellX regardless of wire order', async () => {
    await loadValidWorld();

    expect(getWorldState().tiles.map((tile) => [tile.cellX, tile.cellZ])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
  });

  it('maps full 3D entity position and rotation and orders by entityId', async () => {
    setWorldFetch(async () => fakeResponse(snapshotWith({ entities: [ENTITY_B, ENTITY_A] })));

    await loadWorld();

    expect(getWorldState().entities).toEqual([ENTITY_A_VM, ENTITY_B_VM]);
    expect(entity(getWorldState(), 'entity-a').rotation).toEqual({ x: 0, y: 0.5, z: 0, w: 0.866 });
    expect(entity(getWorldState(), 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
  });

  it('maps an uncontrolled actor as controlledActorId === null', async () => {
    setWorldFetch(async () => fakeResponse(snapshotWith({ controlledActorId: null })));

    await loadWorld();

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().controlledActorId).toBeNull();
  });

  it('maps a network rejection to an error state with no partial data', async () => {
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.bounds).toBeNull();
    expect(state.grid).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
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
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.error).toContain('503');
  });

  it('rejects a snapshot whose tile carries a transform (grid holds no position)', async () => {
    // The phase-7 regression guard: a `transform` on a tile must fail validation
    // rather than be silently ignored.
    setWorldFetch(async () =>
      fakeResponse(snapshotWith({ tiles: [{ cell: { x: 0, z: 0 }, terrain: 'grass', transform: { x: 0, y: 0 } }] })),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.tiles).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a phase-6-shaped snapshot (size + tiles with transform) with no partial data', async () => {
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          worldId: WORLD_ID,
          size: { width: 10, height: 8 },
          tiles: [{ transform: { x: 0, y: 0 }, terrain: 'grass' }],
          entities: [ENTITY_A],
          controlledActorId: 'actor-1',
          serverTime: SERVER_TIME,
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a snapshot carrying an unknown extra tile key (no partial data)', async () => {
    setWorldFetch(async () =>
      fakeResponse(
        snapshotWith({ tiles: [{ cell: { x: 0, z: 0 }, terrain: 'grass', walkable: true }] }),
      ),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.tiles).toEqual([]);
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

    deferred.resolve(fakeResponse(WORLD_RESPONSE));
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });

  it('notifies subscribers synchronously across loading -> ready -> connecting', async () => {
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(`${next.status}/${next.streamStatus}`);
    });

    const settled = loadWorld();
    expect(seen).toEqual(['loading/idle']);

    deferred.resolve(fakeResponse(WORLD_RESPONSE));
    await settled;
    // The stream is opened immediately after the snapshot settles, so the
    // snapshot `ready` is followed by a `connecting` stream transition.
    expect(seen).toEqual(['loading/idle', 'ready/idle', 'ready/connecting']);
    expect(getWorldState().streamStatus).toBe('connecting');

    unsubscribe();
  });

  it('keeps the world fetch hook independent from the game-info hook', async () => {
    setGameInfoFetch(async () => {
      throw new Error('game-info transport must not be used for the world');
    });

    await loadValidWorld();

    expect(getWorldState().status).toBe('ready');
  });
});

describe('realtime stream lifecycle', () => {
  it('opens exactly one stream on STREAM_PATH after the snapshot', async () => {
    await loadValidWorld();

    expect(streamSources).toHaveLength(1);
    expect(streamSources[0].url).toBe(STREAM_PATH);
    expect(getWorldState().streamStatus).toBe('connecting');
  });

  it('transitions connecting -> live when the stream opens', async () => {
    await loadValidWorld();

    streamSources[0].open();

    expect(getWorldState().streamStatus).toBe('live');
  });

  it('is idempotent while the stream is live: no refetch and no second connection', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(WORLD_RESPONSE);
    });

    await loadWorld();
    streamSources[0].open();

    await loadWorld();
    await loadWorld();

    expect(calls).toBe(1);
    expect(streamSources).toHaveLength(1);
  });

  it('replaces client state wholesale when a snapshot frame arrives', async () => {
    await loadValidWorld();
    streamSources[0].open();

    const nextSnapshot = {
      worldId: 'world-next',
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      grid: { origin: { x: 0, y: 0, z: 0 }, width: 1, depth: 1, cellSize: 1 },
      tiles: [{ cell: { x: 0, z: 0 }, terrain: 'water' }],
      entities: [ENTITY_C],
      controlledActorId: null,
      serverTime: SERVER_TIME,
    };

    streamSources[0].message(snapshotFrame(nextSnapshot));

    const state = getWorldState();
    expect(state.worldId).toBe('world-next');
    expect(state.controlledActorId).toBeNull();
    expect(state.tiles).toEqual([
      { cellX: 0, cellZ: 0, position: { x: 0.5, y: 0, z: 0.5 }, terrain: 'water' },
    ]);
    expect(state.entities.map((candidate) => candidate.entityId)).toEqual(['entity-c']);
    expect(state.streamStatus).toBe('live');
  });

  it('an events frame updates only entities and keeps tiles/grid/bounds reference-identical', async () => {
    await loadValidWorld();
    const before = getWorldState();

    streamSources[0].message(eventsFrame([transformChanged('entity-a', { x: 5, y: 0, z: 6 })]));

    const after = getWorldState();
    expect(after).not.toBe(before);
    expect(after.entities).not.toBe(before.entities);
    expect(after.tiles).toBe(before.tiles);
    expect(after.grid).toBe(before.grid);
    expect(after.bounds).toBe(before.bounds);
    expect(entity(after, 'entity-a').position).toEqual({ x: 5, y: 0, z: 6 });
    expect(entity(after, 'entity-b').position).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('applies spawn and remove events from the stream', async () => {
    await loadValidWorld();

    streamSources[0].message(eventsFrame([entitySpawned(ENTITY_C), entityRemoved('entity-b')]));

    const state = getWorldState();
    expect(state.entities.map((candidate) => candidate.entityId)).toEqual([
      'entity-a',
      'entity-c',
    ]);
  });

  it('ignores a transform.changed frame for an unknown entity (creates nothing)', async () => {
    await loadValidWorld();
    const before = getWorldState();

    streamSources[0].message(eventsFrame([transformChanged('entity-missing', { x: 9, y: 0, z: 9 })]));

    expect(getWorldState()).toBe(before);
  });

  it('ignores malformed frames without corrupting state', async () => {
    await loadValidWorld();
    streamSources[0].open();
    const before = getWorldState();

    streamSources[0].message('not json');
    streamSources[0].message({ type: 'nonsense' });
    streamSources[0].message({ type: 'snapshot', snapshot: { worldId: 'x' } });
    streamSources[0].message({ type: 'events', batch: { events: 'nope', serverTime: SERVER_TIME } });
    streamSources[0].message({ type: 'events', batch: { events: [], serverTime: 'not-a-date' } });

    expect(getWorldState()).toBe(before);
    expect(getWorldState().streamStatus).toBe('live');
  });

  it('retries with bounded backoff and then stays in error (no reconnect storm)', async () => {
    vi.useFakeTimers();
    await loadValidWorld();
    expect(streamSources).toHaveLength(1);
    expect(getWorldState().streamStatus).toBe('connecting');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      streamSources[streamSources.length - 1].fail();
      expect(getWorldState().streamStatus).toBe('error');
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // 1 initial connection + 3 bounded reconnects; the 4th failure exhausts the
    // budget and leaves the stream in `error`.
    expect(streamSources).toHaveLength(4);
    expect(getWorldState().streamStatus).toBe('error');

    // A long wait must not produce an unbounded reconnect storm.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(streamSources).toHaveLength(4);
  });

  it('a successful reopen resets the attempt budget and returns to live', async () => {
    vi.useFakeTimers();
    await loadValidWorld();

    streamSources[0].fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamSources).toHaveLength(2);

    streamSources[1].open();
    expect(getWorldState().streamStatus).toBe('live');

    streamSources[1].fail();
    await vi.advanceTimersByTimeAsync(60_000);
    // The counter restarted, so a fresh reconnect is still scheduled.
    expect(streamSources).toHaveLength(3);
  });

  it('resetWorldState closes the stream and returns to idle', async () => {
    await loadValidWorld();
    streamSources[0].open();
    expect(getWorldState().streamStatus).toBe('live');

    resetWorldState();

    expect(streamSources[0].closeCalls).toBe(1);
    const state = getWorldState();
    expect(state.status).toBe('idle');
    expect(state.streamStatus).toBe('idle');
    expect(state.worldId).toBeNull();
    expect(state.bounds).toBeNull();
    expect(state.grid).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toBeNull();
  });

  it('resetWorldState cancels a pending reconnect', async () => {
    vi.useFakeTimers();
    await loadValidWorld();

    streamSources[0].fail(); // schedules a reconnect
    resetWorldState();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(streamSources).toHaveLength(1);
    expect(getWorldState().streamStatus).toBe('idle');
  });
});

describe('setMovementIntent', () => {
  it('posts exactly { type, movement } to COMMAND_PATH with no actor or position', async () => {
    await loadValidWorld();

    const requests: Array<{
      url: string;
      method: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    setWorldFetch(async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return fakeResponse(commandResponse([]));
    });

    await setMovementIntent({ x: 0.5, z: -0.25 });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(COMMAND_PATH);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({
      type: 'actor.moveIntent',
      movement: { x: 0.5, z: -0.25 },
    });
    expect(Object.keys(requests[0].body)).toEqual(['type', 'movement']);
    expect(Object.keys(requests[0].body.movement as object)).toEqual(['x', 'z']);
    expect('actorId' in requests[0].body).toBe(false);
    expect('playerId' in requests[0].body).toBe(false);
    expect('x' in requests[0].body).toBe(false);
    expect('z' in requests[0].body).toBe(false);
    expect('position' in requests[0].body).toBe(false);
  });

  it('does not move anything locally while the intent is in flight', async () => {
    await loadValidWorld();
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const pending = setMovementIntent({ x: 1, z: 0 });

    expect(entity(getWorldState(), 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
    expect(getWorldState().status).toBe('ready');

    deferred.resolve(fakeResponse(commandResponse([])));
    await pending;

    // Even after settling, an empty ack changes nothing.
    expect(entity(getWorldState(), 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
    expect(getWorldState().status).toBe('ready');
  });

  it('adopts authoritative events from the command ack', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(commandResponse([transformChanged('entity-a', { x: 4, y: 0, z: 4 })])),
    );

    await setMovementIntent({ x: 1, z: 0 });

    expect(entity(getWorldState(), 'entity-a').position).toEqual({ x: 4, y: 0, z: 4 });
  });

  it('treats an empty events array (a refused intent) as a no-op with no error', async () => {
    await loadValidWorld();
    const before = getWorldState();
    setWorldFetch(async () => fakeResponse(commandResponse([])));

    await setMovementIntent({ x: 0, z: 0 });

    expect(getWorldState()).toBe(before);
    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().error).toBeNull();
  });

  it('is a safe no-op before any world is loaded', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await expect(setMovementIntent({ x: 1, z: 0 })).resolves.toBeUndefined();

    expect(calls).toBe(0);
    expect(getWorldState().status).toBe('idle');
  });

  it('never rejects on a network failure and surfaces a user message', async () => {
    await loadValidWorld();
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(setMovementIntent({ x: 1, z: 0 })).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
    // The last authoritative state is preserved on a command failure.
    expect(entity(state, 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
  });

  it('maps a 404 command response to a user-presentable actor-not-found error', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(
        { error: { code: 'NOT_FOUND', message: 'unknown actor' } },
        { ok: false, status: 404 },
      ),
    );

    await expect(setMovementIntent({ x: 1, z: 0 })).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error?.toLowerCase()).toContain('actor');
    expect(state.error).not.toContain('404');
  });

  it('maps a malformed command response to a contract error', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse({ result: { moved: true } }));

    await setMovementIntent({ x: 1, z: 0 });

    expect(getWorldState().status).toBe('error');
    expect(getWorldState().error).toBeTruthy();
  });

  it('serializes intents with a single in-flight slot and latest wins', async () => {
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

    const first = setMovementIntent({ x: 1, z: 0 });
    const second = setMovementIntent({ x: 0, z: 1 });
    const third = setMovementIntent({ x: -1, z: 0 });

    expect(calls).toBe(1);
    expect(bodies).toEqual([{ type: 'actor.moveIntent', movement: { x: 1, z: 0 } }]);

    deferreds[0].resolve(fakeResponse(commandResponse([])));
    await first;

    // Once the first settles, exactly one more request is sent, with the latest
    // queued movement only.
    expect(calls).toBe(2);
    expect(bodies).toEqual([
      { type: 'actor.moveIntent', movement: { x: 1, z: 0 } },
      { type: 'actor.moveIntent', movement: { x: -1, z: 0 } },
    ]);

    deferreds[1].resolve(fakeResponse(commandResponse([])));
    await Promise.all([second, third]);
  });

  it('settles every intent promise when a reset supersedes an in-flight loop', async () => {
    await loadValidWorld();
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const inFlight = setMovementIntent({ x: 1, z: 0 });
    const queued = setMovementIntent({ x: 0, z: 1 });

    resetWorldState();

    deferred.resolve(fakeResponse(commandResponse([])));
    await expect(Promise.all([inFlight, queued])).resolves.toEqual([undefined, undefined]);
    expect(getWorldState().status).toBe('idle');
  });
});

describe('event applier seam', () => {
  it('ignores an unknown event type at runtime without throwing or changing state', async () => {
    // The transport's Protocol guard rejects an unknown event `type` before it
    // reaches the applier, so this exercises the applier's `default` branch
    // directly. The object is cast through `unknown` only here, in the test:
    // production code must never fabricate a union member.
    await loadValidWorld();

    const unknownEvent = {
      type: 'entity.teleported',
      entityId: 'entity-a',
      transform: {
        position: { x: 9, y: 0, z: 9 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    } as unknown as GameEvent;

    const before = getWorldState();

    // The `never` assignment in the applier's `default` branch is a COMPILE
    // error when a fourth `GameEvent` member is added until it is handled. At
    // runtime an unknown event is tolerated: no throw, no observable change.
    expect(() => {
      applyEvents([unknownEvent]);
    }).not.toThrow();

    expect(getWorldState()).toBe(before);
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

  it('exposes the frozen state shape and has no legacy fields', () => {
    const state: WorldState = getWorldState();

    // @ts-expect-error WorldState has no `world` field after the 3D migration.
    expect(state.world).toBeUndefined();
    // @ts-expect-error WorldState has no `controlledActor` field.
    expect(state.controlledActor).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state, 'world')).toBe(false);
    expect(state.streamStatus).toBe('idle');
    expect(state.worldId).toBeNull();
    expect(state.bounds).toBeNull();
    expect(state.grid).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
  });

  it('unsubscribe stops notifications', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next.status);
    });
    unsubscribe();

    await loadValidWorld();

    expect(seen).toEqual([]);
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
