/**
 * Organizer unit tests for the phase-15 block-spatial world feature.
 *
 * Focuses on the client-application contract: the snapshot request lifecycle,
 * canonical Protocol v9 validation, derivation of block world positions from the
 * `blockGrid`, realtime stream adoption/retry, authoritative block/entity event
 * reconciliation (including incremental `block.changed`), derived (never
 * predicted) movement, the thin command actions, and the non-authoritative
 * placement preview. Both transports are injected: `setWorldFetch` for HTTP and
 * `setWorldEventSource` for the SSE stream. Nothing here touches a real network.
 *
 * The client is authoritative-only: a snapshot, a stream `events` frame, or a
 * command ack are the only things that change state. There is no prediction and
 * no interpolation, and `validatePlacement` caches nothing.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_PATH, STREAM_PATH } from '@starvalley/protocol';
import type { GameEvent } from '@starvalley/protocol';

import {
  getWorldState,
  interact,
  jump,
  loadWorld,
  moveTo,
  placeEntity,
  removeBlock,
  removeEntity,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  rotateEntity,
  setBlock,
  setGameInfoFetch,
  setMovementIntent,
  setWorldEventSource,
  setWorldFetch,
  subscribeWorld,
  useWorld,
  validatePlacement,
} from '../src/organizer/index.ts';
import type { WorldState } from '../src/organizer/index.ts';
// Internal seam (not re-exported by the public organizer index); see the test
// below for why the applier's defensive tolerance is only observable here.
import { applyEvents } from '../src/organizer/world-store.ts';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';
const WORLD_ID = 'world-main';

// A non-trivial grid origin/cellSize proves the frozen derivation is used and
// that nothing hardcodes 1-unit cells or a world-origin-bound grid.
const BLOCK_GRID = {
  origin: { x: 10, y: 0.5, z: -4 },
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
  kind: 'rock',
  transform: {
    position: { x: 7, y: 0, z: 7 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  visible: false,
};

// Sparse, non-air blocks with absolute integer cells. Wire order is deliberately
// scrambled so the deterministic mapper must re-sort by layer (`y`), then row
// (`z`), then column (`x`). Derived centres use `origin + (cell + 0.5) * cellSize`.
const BLOCK_GRASS = { coord: { x: 0, y: 0, z: 0 }, kind: 'grass', orientation: 0 };
const BLOCK_STONE = { coord: { x: 1, y: 0, z: 0 }, kind: 'stone', orientation: 90 };
const BLOCK_RAMP = { coord: { x: 0, y: 1, z: 1 }, kind: 'ramp', orientation: 180 };

const BLOCK_GRASS_VM = {
  coord: { x: 0, y: 0, z: 0 },
  position: { x: 11, y: 1.5, z: -3 },
  kind: 'grass',
  orientation: 0,
};
const BLOCK_STONE_VM = {
  coord: { x: 1, y: 0, z: 0 },
  position: { x: 13, y: 1.5, z: -3 },
  kind: 'stone',
  orientation: 90,
};
const BLOCK_RAMP_VM = {
  coord: { x: 0, y: 1, z: 1 },
  position: { x: 11, y: 3.5, z: -1 },
  kind: 'ramp',
  orientation: 180,
};
const ORDERED_BLOCKS = [BLOCK_GRASS_VM, BLOCK_STONE_VM, BLOCK_RAMP_VM];

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
  blockGrid: BLOCK_GRID,
  blocks: [BLOCK_STONE, BLOCK_RAMP, BLOCK_GRASS],
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

/** Build a valid `ValidatePlacementResponse` body with field overrides. */
function placementResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    valid: true,
    reason: null,
    occupiedCells: [{ x: 1, y: 0, z: 2 }],
    resolvedTransform: {
      position: { x: 3, y: 0.5, z: 4 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
    ...overrides,
  };
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

function blockChanged(
  coord: { x: number; y: number; z: number },
  kind: string,
  orientation = 0,
): unknown {
  return { type: 'block.changed', coord, kind, orientation };
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

/** Find a block view model by coord key (throws if absent). */
function blockAt(state: WorldState, x: number, y: number, z: number) {
  const found = state.blocks.find(
    (candidate) => candidate.coord.x === x && candidate.coord.y === y && candidate.coord.z === z,
  );
  if (found === undefined) {
    throw new Error(`block ${x},${y},${z} not present`);
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
  it('maps worldId/bounds/blockGrid/blocks/entities/controlledActorId into ready state', async () => {
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
    expect(state.blockGrid).toEqual(BLOCK_GRID);
    expect(state.blocks).toEqual(ORDERED_BLOCKS);
    expect(state.entities).toEqual([ENTITY_A_VM, ENTITY_B_VM]);
    expect(state.controlledActorId).toBe('actor-1');
  });

  it('derives each block world position with origin + (cell + 0.5) * cellSize', async () => {
    await loadValidWorld();

    const blocks = getWorldState().blocks;
    const at = (x: number, y: number, z: number) =>
      blocks.find(
        (block) =>
          block.coord.x === x && block.coord.y === y && block.coord.z === z,
      );

    expect(at(0, 0, 0)?.position).toEqual({ x: 11, y: 1.5, z: -3 });
    expect(at(1, 0, 0)?.position).toEqual({ x: 13, y: 1.5, z: -3 });
    expect(at(0, 1, 1)?.position).toEqual({ x: 11, y: 3.5, z: -1 });
  });

  it('orders blocks deterministically by layer, row, column regardless of wire order', async () => {
    await loadValidWorld();

    expect(
      getWorldState().blocks.map((block) => [block.coord.y, block.coord.z, block.coord.x]),
    ).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [1, 1, 0],
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
    expect(state.blockGrid).toBeNull();
    expect(state.blocks).toEqual([]);
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
    expect(state.blocks).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.error).toContain('503');
  });

  it('rejects a snapshot whose sparse blocks carry an explicit air entry', async () => {
    // `air` is absence: a snapshot that names it is malformed and must be
    // rejected wholesale, not silently treated as a removal.
    setWorldFetch(async () =>
      fakeResponse(snapshotWith({ blocks: [{ ...BLOCK_GRASS, kind: 'air' }] })),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.blocks).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a snapshot whose sparse blocks repeat an absolute coord', async () => {
    setWorldFetch(async () =>
      fakeResponse(
        snapshotWith({
          blocks: [BLOCK_GRASS, { ...BLOCK_STONE, coord: { ...BLOCK_GRASS.coord } }],
        }),
      ),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.blocks).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a block carrying an unknown extra key (no partial data)', async () => {
    setWorldFetch(async () =>
      fakeResponse(snapshotWith({ blocks: [{ ...BLOCK_GRASS, walkable: true }] })),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.blocks).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a blockGrid with a non-positive cellSize', async () => {
    setWorldFetch(async () =>
      fakeResponse(snapshotWith({ blockGrid: { origin: { x: 0, y: 0, z: 0 }, cellSize: 0 } })),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.blockGrid).toBeNull();
    expect(state.error).toBeTruthy();
  });

  it('rejects a phase-14-shaped snapshot (grid + tiles + surfaces) with no partial data', async () => {
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          worldId: WORLD_ID,
          bounds: BOUNDS,
          grid: { origin: { x: 0, y: 0, z: 0 }, width: 3, depth: 2, cellSize: 1 },
          tiles: [{ cell: { x: 0, z: 0 }, terrain: 'grass' }],
          surfaces: [],
          colliders: [],
          entities: [ENTITY_A],
          controlledActorId: 'actor-1',
          serverTime: SERVER_TIME,
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.blocks).toEqual([]);
    expect(state.blockGrid).toBeNull();
    expect(state.entities).toEqual([]);
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
      blockGrid: { origin: { x: 0, y: 0, z: 0 }, cellSize: 1 },
      blocks: [{ coord: { x: 0, y: 0, z: 0 }, kind: 'water', orientation: 0 }],
      entities: [ENTITY_C],
      controlledActorId: null,
      serverTime: SERVER_TIME,
    };

    streamSources[0].message(snapshotFrame(nextSnapshot));

    const state = getWorldState();
    expect(state.worldId).toBe('world-next');
    expect(state.controlledActorId).toBeNull();
    expect(state.blockGrid).toEqual({ origin: { x: 0, y: 0, z: 0 }, cellSize: 1 });
    expect(state.blocks).toEqual([
      {
        coord: { x: 0, y: 0, z: 0 },
        position: { x: 0.5, y: 0.5, z: 0.5 },
        kind: 'water',
        orientation: 0,
      },
    ]);
    expect(state.entities.map((candidate) => candidate.entityId)).toEqual(['entity-c']);
    expect(state.streamStatus).toBe('live');
  });

  it('an events frame updates only entities and keeps blocks/blockGrid/bounds reference-identical', async () => {
    await loadValidWorld();
    const before = getWorldState();

    streamSources[0].message(eventsFrame([transformChanged('entity-a', { x: 5, y: 0, z: 6 })]));

    const after = getWorldState();
    expect(after).not.toBe(before);
    expect(after.entities).not.toBe(before.entities);
    expect(after.blocks).toBe(before.blocks);
    expect(after.blockGrid).toBe(before.blockGrid);
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

  it('adds a new block incrementally from a block.changed frame without refetching', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(WORLD_RESPONSE);
    });
    await loadWorld();
    expect(calls).toBe(1);
    const before = getWorldState();

    streamSources[0].message(
      eventsFrame([blockChanged({ x: 2, y: 0, z: 0 }, 'water', 0)]),
    );

    const after = getWorldState();
    expect(calls).toBe(1);
    expect(after.blocks).toHaveLength(4);
    expect(blockAt(after, 2, 0, 0).kind).toBe('water');
    expect(blockAt(after, 2, 0, 0).position).toEqual({ x: 15, y: 1.5, z: -3 });
    // Static grid/bounds survive reference-identically.
    expect(after.blockGrid).toBe(before.blockGrid);
    expect(after.bounds).toBe(before.bounds);
  });

  it('replaces an existing block in place when a block.changed frame carries a new kind', async () => {
    await loadValidWorld();

    streamSources[0].message(eventsFrame([blockChanged({ x: 0, y: 0, z: 0 }, 'soil', 90)]));

    const after = getWorldState();
    expect(after.blocks).toHaveLength(ORDERED_BLOCKS.length);
    const replaced = blockAt(after, 0, 0, 0);
    expect(replaced.kind).toBe('soil');
    expect(replaced.orientation).toBe(90);
    expect(replaced.position).toEqual(BLOCK_GRASS_VM.position);
  });

  it('removes a block when a block.changed frame carries kind air', async () => {
    await loadValidWorld();

    streamSources[0].message(eventsFrame([blockChanged({ x: 1, y: 0, z: 0 }, 'air')]));

    const after = getWorldState();
    expect(after.blocks).toHaveLength(ORDERED_BLOCKS.length - 1);
    expect(
      after.blocks.some(
        (block) => block.coord.x === 1 && block.coord.y === 0 && block.coord.z === 0,
      ),
    ).toBe(false);
  });

  it('a no-op block.changed frame keeps the state reference stable', async () => {
    await loadValidWorld();
    const before = getWorldState();

    streamSources[0].message(eventsFrame([blockChanged({ x: 0, y: 0, z: 0 }, 'grass', 0)]));

    expect(getWorldState()).toBe(before);
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
    streamSources[0].message(
      eventsFrame([{ type: 'block.changed', coord: { x: 0, y: 0 }, kind: 'grass', orientation: 0 }]),
    );

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
    expect(state.blockGrid).toBeNull();
    expect(state.blocks).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toBeNull();
    expect(state.notice).toBeNull();
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

describe('moveTo / interact / jump intents', () => {
  const rejected = (status: number, code: string, message = 'refused'): Response =>
    fakeResponse({ error: { code, message } }, { ok: false, status });

  it('moveTo posts exactly { type, target } with no extra keys and moves nothing locally', async () => {
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

    await expect(moveTo({ x: 4.5, y: 0, z: -2.25 })).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(COMMAND_PATH);
    expect(requests[0].method).toBe('POST');
    // Deep-equal and exactly two top-level keys: no actor id, no extra field.
    expect(requests[0].body).toEqual({
      type: 'actor.moveTo',
      target: { x: 4.5, y: 0, z: -2.25 },
    });
    expect(Object.keys(requests[0].body)).toEqual(['type', 'target']);
    expect(Object.keys(requests[0].body.target as object)).toEqual(['x', 'y', 'z']);
    for (const forbidden of [
      'actorId',
      'playerId',
      'position',
      'camera',
      'ndcX',
      'ndcY',
      'screenX',
      'screenY',
      'pointer',
      'ray',
    ]) {
      expect(forbidden in requests[0].body).toBe(false);
    }
    // No prediction: an empty ack (the server accepted but nothing moved) leaves
    // the authoritative position untouched.
    expect(entity(getWorldState(), 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
    expect(getWorldState().notice).toBeNull();
  });

  it('interact posts exactly { type, targetEntityId } with no extra keys and changes nothing locally', async () => {
    await loadValidWorld();

    const requests: Array<{ url: string; method: string | undefined; body: Record<string, unknown> }> =
      [];
    setWorldFetch(async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return fakeResponse(commandResponse([]));
    });

    await expect(interact('entity-b')).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(COMMAND_PATH);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ type: 'actor.interact', targetEntityId: 'entity-b' });
    expect(Object.keys(requests[0].body)).toEqual(['type', 'targetEntityId']);
    expect('actorId' in requests[0].body).toBe(false);
    expect('playerId' in requests[0].body).toBe(false);
    expect(entity(getWorldState(), 'entity-b').position).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('jump posts exactly { type: actor.jump } with no payload', async () => {
    await loadValidWorld();

    const requests: Array<Record<string, unknown>> = [];
    setWorldFetch(async (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return fakeResponse(commandResponse([]));
    });

    await expect(jump()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ type: 'actor.jump' });
    expect(Object.keys(requests[0])).toEqual(['type']);
    expect('actorId' in requests[0]).toBe(false);
  });

  it('jump is a safe no-op before a controlled actor exists', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await expect(jump()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(getWorldState().status).toBe('idle');
  });

  it('a 409 CONFLICT rejection sets a short notice and does NOT flip status to error', async () => {
    await loadValidWorld();
    expect(getWorldState().status).toBe('ready');
    setWorldFetch(async () => rejected(409, 'CONFLICT', 'Too far away.'));

    await moveTo({ x: 100, y: 0, z: 100 });

    const state = getWorldState();
    expect(state.notice).toBe('Too far away.');
    expect(state.notice).not.toBeNull();
    // A rejected intent is not a broken world: the previous status is preserved.
    expect(state.status).toBe('ready');
    expect(state.status).not.toBe('error');
    expect(state.error).toBeNull();
    // And no entity moved locally.
    expect(entity(state, 'entity-a').position).toEqual({ x: 3, y: 0, z: 4 });
  });

  it('a 409 whose body carries a non-interactable reason surfaces THAT message', async () => {
    await loadValidWorld();
    setWorldFetch(async () => rejected(409, 'CONFLICT', 'That cannot be interacted with.'));

    await interact('entity-a');

    const state = getWorldState();
    expect(state.notice).toBe('That cannot be interacted with.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('a 409 with an unparseable/absent error body falls back to a generic notice', async () => {
    await loadValidWorld();
    const unparseable = {
      ok: false,
      status: 409,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    };
    setWorldFetch(async () => unparseable as unknown as Response);

    await moveTo({ x: 100, y: 0, z: 100 });

    const state = getWorldState();
    expect(state.notice).toBe('Could not do that.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('a 404 NOT_FOUND rejection sets a "gone" notice with status unchanged', async () => {
    await loadValidWorld();
    setWorldFetch(async () => rejected(404, 'NOT_FOUND'));

    await interact('entity-b');

    const state = getWorldState();
    expect(state.notice).toBe('That is gone.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(entity(state, 'entity-b').position).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('maps any other failure to a generic notice without touching status/error', async () => {
    await loadValidWorld();
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await interact('entity-b');

    const state = getWorldState();
    expect(state.notice).toBe('Could not do that.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('a following successful intent clears the notice', async () => {
    await loadValidWorld();
    setWorldFetch(async () => rejected(409, 'CONFLICT', 'Too far away.'));
    await moveTo({ x: 100, y: 0, z: 100 });
    expect(getWorldState().notice).toBe('Too far away.');

    setWorldFetch(async () =>
      fakeResponse(commandResponse([transformChanged('entity-a', { x: 5, y: 0, z: 5 })])),
    );
    await moveTo({ x: 5, y: 0, z: 5 });

    const state = getWorldState();
    expect(state.notice).toBeNull();
    expect(entity(state, 'entity-a').position).toEqual({ x: 5, y: 0, z: 5 });
  });

  it('a successful movement intent also clears the notice', async () => {
    await loadValidWorld();
    setWorldFetch(async () => rejected(409, 'CONFLICT', 'Too far away.'));
    await interact('entity-b');
    expect(getWorldState().notice).toBe('Too far away.');

    setWorldFetch(async () => fakeResponse(commandResponse([])));
    await setMovementIntent({ x: 0, z: 0 });

    expect(getWorldState().notice).toBeNull();
  });

  it('resetWorldState clears a pending notice', async () => {
    await loadValidWorld();
    setWorldFetch(async () => rejected(409, 'CONFLICT', 'Too far away.'));
    await moveTo({ x: 100, y: 0, z: 100 });
    expect(getWorldState().notice).toBe('Too far away.');

    resetWorldState();

    expect(getWorldState().notice).toBeNull();
    expect(getWorldState().status).toBe('idle');
  });

  it('is a safe no-op before any world is loaded', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await expect(moveTo({ x: 1, y: 0, z: 1 })).resolves.toBeUndefined();
    await expect(interact('entity-b')).resolves.toBeUndefined();

    expect(calls).toBe(0);
    expect(getWorldState().status).toBe('idle');
  });

  it('rejects an empty interact target locally without a request', async () => {
    await loadValidWorld();
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await expect(interact('')).resolves.toBeUndefined();

    expect(calls).toBe(0);
    expect(getWorldState().notice).toBe('Could not do that.');
    expect(getWorldState().status).toBe('ready');
  });
});

describe('block / entity edit intents', () => {
  /** Record the POST bodies an edit action sends. */
  function captureCommands(bodies: Array<Record<string, unknown>>, response: unknown): void {
    setWorldFetch(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return fakeResponse(response);
    });
  }

  it('setBlock posts exactly { type, coord, kind, orientation } with no actor', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    captureCommands(bodies, commandResponse([]));

    await setBlock({ x: 2, y: 0, z: 3 }, 'stone', 90);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      type: 'block.set',
      coord: { x: 2, y: 0, z: 3 },
      kind: 'stone',
      orientation: 90,
    });
    expect(Object.keys(bodies[0])).toEqual(['type', 'coord', 'kind', 'orientation']);
    expect('actorId' in bodies[0]).toBe(false);
    expect('playerId' in bodies[0]).toBe(false);
  });

  it('setBlock adopts the block.changed event from the ack', async () => {
    await loadValidWorld();
    captureCommands(
      [],
      commandResponse([blockChanged({ x: 2, y: 0, z: 3 }, 'stone', 90)]),
    );

    await setBlock({ x: 2, y: 0, z: 3 }, 'stone', 90);

    const placed = blockAt(getWorldState(), 2, 0, 3);
    expect(placed.kind).toBe('stone');
    expect(placed.orientation).toBe(90);
  });

  it('removeBlock posts exactly { type, coord } and adopts the air event', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    captureCommands(bodies, commandResponse([blockChanged({ x: 0, y: 0, z: 0 }, 'air')]));

    await removeBlock({ x: 0, y: 0, z: 0 });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ type: 'block.remove', coord: { x: 0, y: 0, z: 0 } });
    expect(
      getWorldState().blocks.some(
        (block) => block.coord.x === 0 && block.coord.y === 0 && block.coord.z === 0,
      ),
    ).toBe(false);
  });

  it('placeEntity posts exactly { type, kind, position, yawDegrees } and adopts the spawn', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    captureCommands(bodies, commandResponse([entitySpawned(ENTITY_C)]));

    await placeEntity('rock', { x: 7.5, y: 0, z: 7.5 }, 0);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      type: 'entity.place',
      kind: 'rock',
      position: { x: 7.5, y: 0, z: 7.5 },
      yawDegrees: 0,
    });
    expect(Object.keys(bodies[0])).toEqual(['type', 'kind', 'position', 'yawDegrees']);
    expect('actorId' in bodies[0]).toBe(false);
    expect(getWorldState().entities.map((candidate) => candidate.entityId)).toEqual([
      'entity-a',
      'entity-b',
      'entity-c',
    ]);
  });

  it('rotateEntity posts exactly { type, entityId, yawDegrees } and adopts the transform', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    captureCommands(
      bodies,
      commandResponse([
        transformChanged('entity-a', { x: 3, y: 0, z: 4 }, { x: 0, y: 1, z: 0, w: 0 }),
      ]),
    );

    await rotateEntity('entity-a', 180);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ type: 'entity.rotate', entityId: 'entity-a', yawDegrees: 180 });
    expect(entity(getWorldState(), 'entity-a').rotation).toEqual({ x: 0, y: 1, z: 0, w: 0 });
  });

  it('removeEntity posts exactly { type, entityId } and adopts the removal', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    captureCommands(bodies, commandResponse([entityRemoved('entity-b')]));

    await removeEntity('entity-b');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ type: 'entity.remove', entityId: 'entity-b' });
    expect(getWorldState().entities.map((candidate) => candidate.entityId)).toEqual(['entity-a']);
  });

  it('every edit is a safe no-op before any world is loaded', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await setBlock({ x: 0, y: 0, z: 0 }, 'grass', 0);
    await removeBlock({ x: 0, y: 0, z: 0 });
    await placeEntity('tree', { x: 0, y: 0, z: 0 }, 0);
    await rotateEntity('entity-a', 90);
    await removeEntity('entity-a');

    expect(calls).toBe(0);
    expect(getWorldState().status).toBe('idle');
  });

  it('a rejected edit sets a short notice without flipping status to error', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse({ error: { code: 'CONFLICT', message: 'You cannot build there.' } }, {
        ok: false,
        status: 409,
      }),
    );

    await setBlock({ x: 2, y: 0, z: 3 }, 'stone', 0);

    const state = getWorldState();
    expect(state.notice).toBe('You cannot build there.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('a malformed local block kind is rejected without a request', async () => {
    await loadValidWorld();
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([]));
    });

    await setBlock({ x: 0, y: 0, z: 0 }, 'lava', 0);

    expect(calls).toBe(0);
    expect(getWorldState().notice).toBe('Could not do that.');
  });
});

describe('validatePlacement preview', () => {
  it('posts exactly { type, kind, position, yawDegrees } to COMMAND_PATH', async () => {
    await loadValidWorld();
    const bodies: Array<Record<string, unknown>> = [];
    setWorldFetch(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return fakeResponse(placementResponse());
    });

    await validatePlacement('tree', { x: 1.5, y: 0, z: 2.5 }, 90);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      type: 'entity.validatePlacement',
      kind: 'tree',
      position: { x: 1.5, y: 0, z: 2.5 },
      yawDegrees: 90,
    });
    expect(Object.keys(bodies[0])).toEqual(['type', 'kind', 'position', 'yawDegrees']);
    expect('actorId' in bodies[0]).toBe(false);
  });

  it('returns the server verdict mapped to plain view-model data (valid)', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(placementResponse()));

    const verdict = await validatePlacement('tree', { x: 1.5, y: 0, z: 2.5 }, 0);

    expect(verdict).toEqual({
      valid: true,
      reason: null,
      occupiedCells: [{ x: 1, y: 0, z: 2 }],
      resolvedTransform: {
        position: { x: 3, y: 0.5, z: 4 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
  });

  it('returns an invalid verdict with its reason and a null resolved transform', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(
        placementResponse({
          valid: false,
          reason: 'occupied',
          occupiedCells: [{ x: 4, y: 0, z: 5 }],
          resolvedTransform: null,
        }),
      ),
    );

    const verdict = await validatePlacement('tree', { x: 1.5, y: 0, z: 2.5 }, 0);

    expect(verdict).toEqual({
      valid: false,
      reason: 'occupied',
      occupiedCells: [{ x: 4, y: 0, z: 5 }],
      resolvedTransform: null,
    });
  });

  it('caches nothing and leaves the world state reference-identical', async () => {
    await loadValidWorld();
    const before = getWorldState();
    setWorldFetch(async () => fakeResponse(placementResponse()));

    await validatePlacement('tree', { x: 1.5, y: 0, z: 2.5 }, 0);

    expect(getWorldState()).toBe(before);
  });

  it('returns null before any world is loaded and sends nothing', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(placementResponse());
    });

    await expect(validatePlacement('tree', { x: 0, y: 0, z: 0 }, 0)).resolves.toBeNull();

    expect(calls).toBe(0);
    expect(getWorldState().status).toBe('idle');
  });

  it('returns null on a transport failure without touching status/error/notice', async () => {
    await loadValidWorld();
    const before = getWorldState();
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(validatePlacement('tree', { x: 1, y: 0, z: 1 }, 0)).resolves.toBeNull();

    const after = getWorldState();
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(after.notice).toBeNull();
    expect(after).toBe(before);
  });

  it('returns null when the server answers a validate query with an event batch', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(commandResponse([entitySpawned(ENTITY_C)])));

    await expect(validatePlacement('tree', { x: 1, y: 0, z: 1 }, 0)).resolves.toBeNull();
    expect(getWorldState().entities.map((candidate) => candidate.entityId)).toEqual([
      'entity-a',
      'entity-b',
    ]);
  });

  it('returns null for a malformed local entity kind without a request', async () => {
    await loadValidWorld();
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(placementResponse());
    });

    await expect(validatePlacement('dragon', { x: 0, y: 0, z: 0 }, 0)).resolves.toBeNull();

    expect(calls).toBe(0);
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
    // @ts-expect-error WorldState has no `grid` field after the block kernel.
    expect(state.grid).toBeUndefined();
    // @ts-expect-error WorldState has no `tiles` field after the block kernel.
    expect(state.tiles).toBeUndefined();
    // @ts-expect-error WorldState has no `surfaces` field after the block kernel.
    expect(state.surfaces).toBeUndefined();
    // @ts-expect-error WorldState has no `colliders` field after the block kernel.
    expect(state.colliders).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state, 'grid')).toBe(false);
    expect(state.streamStatus).toBe('idle');
    expect(state.worldId).toBeNull();
    expect(state.bounds).toBeNull();
    expect(state.blockGrid).toBeNull();
    expect(state.blocks).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.notice).toBeNull();
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
