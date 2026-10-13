/**
 * Main-owned integration test for the phase-7 primitive path:
 * continuous 3D world-space movement through the realtime transport.
 *
 * The chain under test, with nothing mocked:
 *   UI intent -> organizer.setMovementIntent -> POST /api/command (MoveIntentCommand)
 *   -> Manager (intent stored, level-triggered)
 *   -> authoritative tick: world-space collision -> Transform
 *   -> GameEvent { transform.changed } -> SSE /api/stream
 *   -> organizer applies the event -> world state
 *
 * Node has no global `EventSource`, so this file implements a minimal but REAL SSE
 * client over `fetch`'s streaming body. That is test infrastructure, not a mock of
 * the system under test: the wire format, the HTTP stream, the Manager's collision
 * and the Organizer's guards are all the production ones.
 *
 * The tick is DRIVEN BY THE TEST (`world.step(50)` + fan-out) instead of a real
 * interval, so assertions are deterministic and fast. The real 20 Hz interval in
 * `apps/server` is exercised separately by a live curl run.
 *
 * Frozen map geometry used below (grid origin (-5,0,-5), cellSize 1, 10x10, so cell
 * (x,z) centre = (x-4.5, 0, z-4.5)): actor spawns at the centre cell (5,5) -> (0.5,0,0.5);
 * water at cells (3,3)(4,3)(3,4)(4,4) -> the block x in [-2,0], z in [-2,0];
 * tree-1 at cell (6,4) -> (1.5,0,-0.5) with half-extents 0.4; blocked rock at (2,8)(3,8).
 *
 * Phase 15 moved the world to a BLOCK-SPATIAL KERNEL: the authoritative topology is
 * a sparse store of integer-cell `BlockState`s over a `blockGrid { origin, cellSize }`,
 * and entities keep CONTINUOUS transforms. The retired phase-14 topology
 * (`tiles`/`grid`/`surfaces`/`colliders`) no longer exists anywhere.
 *
 * Frozen default world used below (packages/manager/src/default-world.ts): the block
 * grid origin is (-6,0,-6) with cellSize 1, so cell (i) spans [origin+i, origin+i+1)
 * and its centre is origin+i+0.5; the grass layer lives in cell y=0, so the GROUND
 * TOP FACE is y=1 and the actor spawns at (-0.5, 1, -0.5) (the centre of the 12x12
 * block bounding box, cell (5,5)). Obstacles: a half slab at (2,1,2), non-solid water,
 * a staircase at z=9, a full stone barrier at (7..10, 1, 4) (too high to step), a
 * raised platform, and a bridge deck at cell y=3 / z=7 reached by a ramp run, with a
 * walkable clearance underneath. Authored placeables: tree-1 (on the slab, so y=1.5),
 * rock-1, chest-1 and a 2x2 building-1.
 *
 * The tick is DRIVEN BY THE TEST (`world.step(50)` + fan-out) instead of a real
 * interval, so assertions are deterministic and fast.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import {
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  TICK_RATE_HZ,
  createGameInfoManager,
  createWorldManager,
  supportHeightAt,
} from '@starvalley/manager';
import type { WorldManager } from '@starvalley/manager';
import { COMMAND_PATH, PROTOCOL_VERSION, WORLD_PATH, parseActorId } from '@starvalley/protocol';
import type { ActorId, GameEventBatch } from '@starvalley/protocol';
import { createRequestListener } from '@starvalley/router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  setMovementIntent,
  setWorldEventSource,
  setWorldFetch,
  validatePlacement,
} from '../../apps/web/src/organizer';
import type { EventSourceLike } from '../../apps/web/src/organizer';

const ACTOR_ID = parseActorId('actor-1');
const TICK_MS = 1000 / TICK_RATE_HZ;
const STEP_UNITS = DEFAULT_ACTOR_SPEED * (TICK_MS / 1000); // 0.15

let server: Server;
let baseUrl: string;

let currentWorld: WorldManager;
const world: WorldManager = {
  getSnapshot: (input) => currentWorld.getSnapshot(input),
  submitIntent: (input) => currentWorld.submitIntent(input),
  step: (dtMs) => currentWorld.step(dtMs),
  getOccupancy: () => currentWorld.getOccupancy(),
};

/** The composition root's fan-out port, driven by the test's tick helper. */
const subscribers = new Set<(batch: GameEventBatch) => void>();
const worldStream = {
  subscribe(listener: (batch: GameEventBatch) => void): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  },
};

let currentActorId: ActorId;
/** The last batches the tick produced, so tests can assert on empty ones too. */
let lastBatches: GameEventBatch[];

beforeEach(() => {
  currentWorld = createWorldManager();
  currentActorId = ACTOR_ID;
  subscribers.clear();
  lastBatches = [];
});

beforeAll(async () => {
  server = createServer(
    createRequestListener({
      gameInfo: createGameInfoManager(),
      world,
      resolveActorId: () => currentActorId,
      worldStream,
    }),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('integration server did not bind to a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
});

afterEach(() => {
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
});

/**
 * A real (minimal) SSE client over fetch's streaming body: it opens the URL,
 * reads `data: ` frames, and dispatches them like the default `message` event.
 */
function createNodeEventSource(url: string): EventSourceLike {
  const listeners: Array<(event: { data: string }) => void> = [];
  const abort = new AbortController();
  let closed = false;
  const source: EventSourceLike = {
    onopen: null,
    onerror: null,
    addEventListener(type, listener) {
      if (type === 'message') {
        listeners.push(listener);
      }
    },
    close() {
      closed = true;
      abort.abort();
    },
  };

  void (async () => {
    try {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok || response.body === null) {
        source.onerror?.(new Error(`stream HTTP ${response.status}`));
        return;
      }
      source.onopen?.(undefined);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              const data = line.slice('data: '.length);
              for (const listener of listeners) {
                listener({ data });
              }
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!closed) {
        source.onerror?.(error);
      }
    }
  })();

  return source;
}

function useRealServer(): void {
  setWorldFetch((input, init) => fetch(new URL(input, baseUrl), init));
  setWorldEventSource((url) => createNodeEventSource(new URL(url, baseUrl).toString()));
}

/** Drive authoritative ticks and fan the batches out, exactly like the server does. */
async function tick(count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const batch = world.step(TICK_MS);
    lastBatches.push(batch);
    for (const listener of subscribers) {
      listener(batch);
    }
  }
  await settle();
}

/** Wait for the Organizer to reflect an async transport round trip. */
async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function actorPosition(): { x: number; y: number; z: number } {
  const { entities, controlledActorId } = getWorldState();
  const entity = entities.find((candidate) => candidate.actorId === controlledActorId);
  if (entity === undefined) {
    throw new Error('expected a controlled actor entity');
  }
  return entity.position;
}

function approx(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) < tolerance;
}

/**
 * The default authored block world (packages/manager/src/default-world.ts), so
 * the expectations below are derived rather than sprinkled as magic numbers:
 * a 12x12 grass layer at cell y=0 (its top face is y=1), the spawn at the
 * bounding-box centre cell (5,5), a half slab at (2,1,2), a non-solid water
 * patch, a staircase at z=9, a full stone barrier at (7..10,1,4), a raised
 * platform, and a bridge deck at cell y=3 / z=7 reached by a ramp run, with a
 * walkable clearance underneath.
 */
const GRID_ORIGIN = { x: -6, y: 0, z: -6 };
const GROUND_TOP = 1;
const SPAWN = { x: -0.5, y: GROUND_TOP, z: -0.5 };
const cellCentreX = (cellX: number): number => GRID_ORIGIN.x + cellX + 0.5;
const cellCentreZ = (cellZ: number): number => GRID_ORIGIN.z + cellZ + 0.5;

/** Drive one authoritative tick and fan it out, WITHOUT waiting for the client round trip. */
function stepWithoutSettle(): void {
  const batch = world.step(TICK_MS);
  lastBatches.push(batch);
  for (const listener of subscribers) {
    listener(batch);
  }
}

/** The authoritative actor position straight from the Manager (server truth). */
function authoritativeActorPosition(): { x: number; y: number; z: number } {
  const snapshot = currentWorld.getSnapshot({ actorId: ACTOR_ID });
  const entity = snapshot.entities.find((candidate) => candidate.actorId === ACTOR_ID);
  if (entity === undefined) {
    throw new Error('expected a controlled actor entity');
  }
  return entity.transform.position;
}

describe('vertical slice: the v9 block-spatial world over the realtime stream', () => {
  it('loads the authoritative BLOCK world: blockGrid + sparse blocks, and no retired topology', async () => {
    useRealServer();
    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe('world-1');
    expect(state.bounds).not.toBeNull();

    // The grid is now the BLOCK grid: origin + cellSize only (no width/depth), and
    // `cellSize` is configuration that no algorithm may assume is 1.
    expect(state.blockGrid).toEqual({ origin: GRID_ORIGIN, cellSize: 1 });

    // Blocks are SPARSE: non-air only, unique absolute cells.
    expect(state.blocks.length).toBeGreaterThan(0);
    const keys = state.blocks.map((b) => `${b.coord.x},${b.coord.y},${b.coord.z}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(state.blocks.every((b) => b.kind !== 'air')).toBe(true);

    // Retired topology must be gone from the client state entirely.
    const retired = state as unknown as Record<string, unknown>;
    for (const gone of ['tiles', 'grid', 'surfaces', 'colliders']) {
      expect(retired[gone]).toBeUndefined();
    }

    // Entities keep CONTINUOUS transforms; the actor spawns at the centre cell's world centre.
    expect(actorPosition()).toEqual(SPAWN);
    expect(getWorldState().entities.some((e) => e.kind === 'tree')).toBe(true);
    expect(getWorldState().entities.some((e) => e.kind === 'chest')).toBe(true);

    await waitFor(() => getWorldState().streamStatus === 'live');
    expect(getWorldState().streamStatus).toBe('live');
  });

  it('anchors every authored placeable entity EXACTLY on its support top (continuous y)', async () => {
    useRealServer();
    await loadWorld();

    const snapshot = currentWorld.getSnapshot({ actorId: ACTOR_ID });
    const grid = snapshot.blockGrid;
    const placeables = snapshot.entities.filter((e) => e.actorId === null);
    expect(placeables.length).toBeGreaterThan(0);
    for (const entity of placeables) {
      const p = entity.transform.position;
      const cellX = Math.floor((p.x - grid.origin.x) / grid.cellSize);
      const cellZ = Math.floor((p.z - grid.origin.z) / grid.cellSize);
      const localX = (p.x - grid.origin.x) / grid.cellSize - cellX;
      const localZ = (p.z - grid.origin.z) / grid.cellSize - cellZ;
      let top: number | null = null;
      for (const block of snapshot.blocks) {
        if (block.coord.x !== cellX || block.coord.z !== cellZ) continue;
        const localTop = supportHeightAt(block, localX, localZ);
        if (localTop === null) continue;
        const worldTop = grid.origin.y + (block.coord.y + localTop) * grid.cellSize;
        if (worldTop <= p.y + 1e-6 && (top === null || worldTop > top)) top = worldTop;
      }
      // y is the SUPPORT TOP FACE, not a cell boundary: a tree on the half slab
      // sits at 1.5 while a tree on the full grass layer sits at 1.0.
      expect(top).not.toBeNull();
      expect(Math.abs(p.y - (top as number))).toBeLessThan(1e-9);
    }
    const tree = snapshot.entities.find((e) => e.kind === 'tree')!;
    expect(tree.transform.position.y).toBe(1.5);
  });

  it('moves continuously on flat ground: speed x dt, no teleports, y stays on the surface', async () => {
    useRealServer();
    await loadWorld();

    await setMovementIntent({ x: 1, z: 0 });
    await tick(1);

    const afterOne = actorPosition();
    expect(approx(afterOne.x, SPAWN.x + STEP_UNITS)).toBe(true);
    expect(approx(afterOne.y, GROUND_TOP)).toBe(true);
    expect(approx(afterOne.z, SPAWN.z)).toBe(true);

    await tick(3);
    expect(approx(actorPosition().x, SPAWN.x + 4 * STEP_UNITS)).toBe(true);
  });

  it('applies a changed intent immediately, and a zero intent stops it and emits nothing', async () => {
    useRealServer();
    await loadWorld();

    await setMovementIntent({ x: 0, z: 1 });
    await tick(2);
    expect(approx(actorPosition().z, SPAWN.z + 2 * STEP_UNITS)).toBe(true);

    await setMovementIntent({ x: 0, z: 0 });
    const stopped = actorPosition();
    const batchesBefore = lastBatches.length;
    await tick(3);
    expect(actorPosition()).toEqual(stopped);
    expect(lastBatches.slice(batchesBefore).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('is blocked by a full cube block (its side is higher than the step height)', async () => {
    useRealServer();
    await loadWorld();

    // Walk north-east to the barrier row (cells 7..10 at cell y=1, z=4): its west
    // face is world x = 1. Approach along z = 4.5 first.
    await moveTo({ x: cellCentreX(7), y: GROUND_TOP, z: cellCentreZ(4) });
    await tick(80);
    const approach = actorPosition();
    expect(approx(approach.z, cellCentreZ(4), 0.2)).toBe(true);
    expect(approx(approach.y, GROUND_TOP)).toBe(true);

    // Now push east into the barrier: the actor must stop outside it, never inside.
    await setMovementIntent({ x: 1, z: 0 });
    await tick(30);
    const blocked = actorPosition();
    const westFace = cellCentreX(7) - 0.5; // x = 1
    expect(blocked.x).toBeLessThanOrEqual(westFace - DEFAULT_ACTOR_RADIUS + 1e-6);
    expect(blocked.x).toBeGreaterThan(westFace - DEFAULT_ACTOR_RADIUS - STEP_UNITS - 1e-6);
    // A full cube is 1.0 high: more than the step height, so y did NOT climb it.
    expect(approx(blocked.y, GROUND_TOP)).toBe(true);

    const batchesBefore = lastBatches.length;
    await tick(5);
    expect(actorPosition()).toEqual(blocked);
    expect(lastBatches.slice(batchesBefore).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('auto-steps up the RAMP and reaches the bridge deck: y is continuous, never a jump', async () => {
    useRealServer();
    await loadWorld();

    // Reach the ramp foot (cells (3,1..3,4..6), rising toward +Z from y=1).
    await moveTo({ x: cellCentreX(3), y: GROUND_TOP, z: cellCentreZ(4) - 0.4 });
    await tick(90);
    // Still on the LOW part of the ramp (its top there is barely above the ground).
    expect(actorPosition().y).toBeLessThan(1.6);

    // Climb: sample every authoritative tick so continuity is observable.
    await setMovementIntent({ x: 0, z: 1 });
    const ys: number[] = [];
    // From the ramp foot to the deck top is ~3.4 world units = ~23 ticks at 3 u/s;
    // walking further would carry the actor off the far edge of the deck.
    for (let i = 0; i < 24; i += 1) {
      stepWithoutSettle();
      ys.push(authoritativeActorPosition().y);
    }
    await settle();

    let maxRise = 0;
    for (let i = 1; i < ys.length; i += 1) maxRise = Math.max(maxRise, ys[i]! - ys[i - 1]!);
    // The ramp rises smoothly; nothing may teleport the actor up.
    expect(maxRise).toBeLessThan(0.35);
    // It reached the deck top (y = 4) by climbing, not by being placed there.
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(3.9);
  });

  it('walks UNDER the bridge deck: the clearance is walkable at ground level', async () => {
    useRealServer();
    await loadWorld();

    // The deck spans cells 3..9 at cell y=3, z=7, with pillars only at its ends;
    // between them the ground under it is free.
    await moveTo({ x: cellCentreX(5), y: GROUND_TOP, z: cellCentreZ(7) });
    await tick(120);

    const under = actorPosition();
    expect(approx(under.y, GROUND_TOP)).toBe(true);       // stayed on the ground
    expect(approx(under.z, cellCentreZ(7), 0.2)).toBe(true); // reached the deck's footprint
    expect(under.x).toBeGreaterThan(cellCentreX(4));       // and walked into it
  });

  it('jumps: the actor leaves the ground and lands back on it', async () => {
    useRealServer();
    await loadWorld();
    expect(approx(actorPosition().y, GROUND_TOP)).toBe(true);

    await jump();
    const ys: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      stepWithoutSettle();
      ys.push(authoritativeActorPosition().y);
    }
    await settle();

    expect(Math.max(...ys)).toBeGreaterThan(GROUND_TOP + 0.2);
    expect(ys[ys.length - 1]).toBeCloseTo(GROUND_TOP, 6);
  });

  it('serves the v9 snapshot shape, and no legacy endpoints', async () => {
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    const payload = (await response.json()) as Record<string, unknown>;
    const snapshot = payload['world'] as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      'blockGrid',
      'blocks',
      'bounds',
      'controlledActorId',
      'entities',
      'serverTime',
      'worldId',
    ]);
    expect(Array.isArray(snapshot['blocks'])).toBe(true);

    const info = await fetch(new URL('/api/game-info', baseUrl));
    const gameInfo = (await info.json()) as {
      gameInfo: { protocolVersion: number };
      blockKinds: unknown[];
      entityKinds: unknown[];
    };
    expect(gameInfo.gameInfo.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(gameInfo.blockKinds.length).toBeGreaterThan(0);
    expect(gameInfo.entityKinds.length).toBeGreaterThan(0);

    for (const path of ['/api/actor/move', '/api/player/move']) {
      const legacy = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ movement: { x: 1, z: 0 } }),
      });
      expect(legacy.status).toBe(404);
    }
  });

  it('surfaces an unknown actor as an error without moving anything', async () => {
    useRealServer();
    await loadWorld();
    const before = actorPosition();

    currentActorId = parseActorId('ghost-actor');
    await setMovementIntent({ x: 1, z: 0 });
    await tick(3);

    currentActorId = ACTOR_ID;
    expect(actorPosition()).toEqual(before);
  });

  it('closes the stream on reset and returns to idle', async () => {
    useRealServer();
    await loadWorld();
    await waitFor(() => getWorldState().streamStatus === 'live');

    resetWorldState();

    expect(getWorldState().status).toBe('idle');
    expect(getWorldState().streamStatus).toBe('idle');
    expect(getWorldState().blocks).toHaveLength(0);
    expect(getWorldState().entities).toHaveLength(0);
  });
});

describe('phase 15: editing blocks and placing entities over the real chain', () => {
  it('sets and removes a block, and applies block.changed incrementally', async () => {
    useRealServer();
    await loadWorld();

    const coord = { x: 5, y: 1, z: 5 };
    const before = getWorldState().blocks.length;
    await setBlock(coord, 'stone', 0);

    // Incremental: the block appears with NO refetch, and an event was emitted.
    const added = getWorldState().blocks.find(
      (b) => b.coord.x === coord.x && b.coord.y === coord.y && b.coord.z === coord.z,
    );
    expect(added?.kind).toBe('stone');
    expect(getWorldState().blocks.length).toBe(before + 1);

    await removeBlock(coord);
    const stillThere = getWorldState().blocks.some(
      (b) => b.coord.x === coord.x && b.coord.y === coord.y && b.coord.z === coord.z,
    );
    expect(stillThere).toBe(false);
    expect(getWorldState().blocks.length).toBe(before);
  });

  it('previews a placement, then places, rotates and removes the entity', async () => {
    useRealServer();
    await loadWorld();

    // Preview first: the server is the only judge, and the preview must not mutate.
    const position = { x: cellCentreX(5), y: GROUND_TOP, z: cellCentreZ(5) };
    const before = getWorldState().entities.length;
    const verdict = await validatePlacement('chest', position, 0);
    expect(verdict).not.toBeNull();
    expect(getWorldState().entities.length).toBe(before); // pure query

    await placeEntity('chest', position, 0);
    await waitFor(() => getWorldState().entities.length === before + 1);
    const placed = getWorldState().entities.find(
      (e) => e.kind === 'chest' && Math.abs(e.position.x - position.x) < 1e-9,
    );
    expect(placed).toBeDefined();

    // Rotate it: 1x1 is parity-invariant, so the committed position must not move.
    const p0 = { ...placed!.position };
    await rotateEntity(placed!.entityId, 90);
    await waitFor(() => {
      const now = getWorldState().entities.find((e) => e.entityId === placed!.entityId);
      return now !== undefined && Math.abs(now.rotation.y) > 0.01;
    });
    const rotated = getWorldState().entities.find((e) => e.entityId === placed!.entityId)!;
    expect(rotated.position).toEqual(p0);

    await removeEntity(placed!.entityId);
    await waitFor(() => getWorldState().entities.length === before);
    expect(getWorldState().entities.some((e) => e.entityId === placed!.entityId)).toBe(false);
  });

  it('refuses a placement the server rejects, and never mutates from a preview', async () => {
    useRealServer();
    await loadWorld();

    const before = getWorldState().entities.length;
    // Outside the authored 12x12 grid there is no support block at all, so the
    // server must refuse the placement. The CLIENT never decides this: it only
    // reports the verdict it was given.
    const unsupported = { x: cellCentreX(14), y: GROUND_TOP, z: cellCentreZ(5) };
    const verdict = await validatePlacement('chest', unsupported, 0);
    expect(verdict === null || verdict.valid === false).toBe(true);
    expect(getWorldState().entities.length).toBe(before);
  });

  it('refuses a placement whose BODY would intersect a solid block, with the `blocked` reason', async () => {
    useRealServer();
    await loadWorld();

    // Free grass cell next to the spawn, then fill the cell the chest would occupy.
    const position = { x: cellCentreX(6), y: GROUND_TOP, z: cellCentreZ(5) };
    await setBlock({ x: 6, y: 1, z: 5 }, 'stone', 0);

    const response = await fetch(new URL(COMMAND_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entity.place', kind: 'chest', position, yawDegrees: 0 }),
    });

    // The server is the authority: the same rule the authoring guard applies.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('no room');
  });

  it('maps a REFUSED placement to 409 CONFLICT with a player-facing reason (not a 500)', async () => {
    useRealServer();
    await loadWorld();

    // Straight at the router: the editor sends `entity.place` unconditionally, so a
    // refusal is routine on the real user path and must NOT surface as a 500.
    const response = await fetch(new URL(COMMAND_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'entity.place',
        kind: 'chest',
        // Outside the authored grid: nothing to rest on.
        position: { x: cellCentreX(14), y: GROUND_TOP, z: cellCentreZ(5) },
        yawDegrees: 0,
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { message?: string } };
    // The client renders this message verbatim, so it is player-facing text - and it
    // must be the placement reason, not the generic transport failure.
    expect(body.error?.message).toContain('rest on');
  });
});

describe('phase 8: mouse-first intents (moveTo / interact) over the real chain', () => {
  it('walks to a clicked world point and STOPS there (moveTo is a steering goal)', async () => {
    useRealServer();
    await loadWorld();

    const target = { x: cellCentreX(2), y: GROUND_TOP, z: cellCentreZ(0) };
    await moveTo(target);
    await tick(60);

    const arrived = actorPosition();
    expect(approx(arrived.x, target.x, 1e-6)).toBe(true);
    expect(approx(arrived.z, target.z, 1e-6)).toBe(true);
    expect(approx(arrived.y, GROUND_TOP)).toBe(true);

    const before = lastBatches.length;
    await tick(5);
    expect(lastBatches.slice(before).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('does not teleport: an unreachable goal stops against the obstacle', async () => {
    useRealServer();
    await loadWorld();

    // The barrier occupies cells 7..10 at cell z=4, i.e. world x in [1,5) and z in
    // [-2,-1). Aim at a point INSIDE it from the spawn: the actor must never arrive.
    const goal = { x: cellCentreX(9), y: GROUND_TOP, z: cellCentreZ(4) };
    await moveTo(goal);
    await tick(120);

    const stopped = actorPosition();
    // never inside the barrier footprint...
    const insideBarrier = stopped.x > 1 && stopped.x < 5 && stopped.z > -2 && stopped.z < -1;
    expect(insideBarrier).toBe(false);
    // ...and it did NOT reach the goal.
    expect(Math.hypot(stopped.x - goal.x, stopped.z - goal.z)).toBeGreaterThan(1);
  });

  it('interacts with an in-range entity over the real chain', async () => {
    useRealServer();
    await loadWorld();

    // Place a chest one cell east of the spawn (free grass, supported by the
    // ground layer) so the actor starts inside the interaction reach. This also
    // exercises the placement chain.
    const spot = { x: cellCentreX(6), y: GROUND_TOP, z: cellCentreZ(5) };
    await placeEntity('chest', spot, 0);
    const chest = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const found = getWorldState().entities.find(
          (e) => e.kind === 'chest' && Math.abs(e.position.x - spot.x) < 1e-9,
        );
        if (found !== undefined) return found;
        await settle(20);
      }
      throw new Error('the placed chest never arrived');
    })();

    const actor = currentWorld
      .getSnapshot({ actorId: ACTOR_ID })
      .entities.find((e) => e.actorId === ACTOR_ID)!.transform.position;
    expect(Math.hypot(actor.x - spot.x, actor.z - spot.z)).toBeLessThan(1.5);

    // The Manager resolves the interaction authoritatively: the actor is turned to
    // face the target (+X here), which is observable in its authoritative rotation.
    // `lastBatches` only records `step()` output, so assert the state, not the batch.
    const beforeRotation = currentWorld
      .getSnapshot({ actorId: ACTOR_ID })
      .entities.find((e) => e.actorId === ACTOR_ID)!.transform.rotation;
    const beforeForwardX = 2 * beforeRotation.w * beforeRotation.y;

    await interact(String(chest.entityId));
    await tick(1);

    const after = currentWorld
      .getSnapshot({ actorId: ACTOR_ID })
      .entities.find((e) => e.actorId === ACTOR_ID)!.transform.rotation;
    // forward = rotate((0,0,1), q); for a yaw-only quaternion forward.x = 2*w*y.
    const forwardX = 2 * after.w * after.y;
    expect(beforeForwardX).toBeLessThan(0.5); // it was NOT already facing +X
    expect(forwardX).toBeGreaterThan(0.9);    // now it faces the chest (+X)
  });

  it('keeps presentation data off the wire: a command carrying camera/NDC fields is a 400', async () => {
    useRealServer();
    const post = (body: unknown) =>
      fetch(new URL(COMMAND_PATH, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await post({ type: 'actor.jump', cameraYaw: 10 })).status).toBe(400);
    expect((await post({ type: 'actor.moveIntent', movement: { x: 1, z: 1 } })).status).toBe(400);
    expect(
      (await post({ type: 'actor.moveIntent', movement: { x: 1, z: 0 }, actorId: 'ghost' })).status,
    ).toBe(400);
    expect((await post({ type: 'actor.teleport', movement: { x: 0, z: 0 } })).status).toBe(400);
    expect((await post({ type: 'block.set', coord: { x: 1, y: 1, z: 1 } })).status).toBe(400);
  });
});
