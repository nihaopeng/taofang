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
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import {
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  TICK_RATE_HZ,
  createGameInfoManager,
  createWorldManager,
} from '@starvalley/manager';
import type { WorldManager } from '@starvalley/manager';
import { COMMAND_PATH, PROTOCOL_VERSION, WORLD_PATH, parseActorId } from '@starvalley/protocol';
import type { ActorId, GameEventBatch } from '@starvalley/protocol';
import { createRequestListener } from '@starvalley/router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getWorldState,
  interact,
  loadWorld,
  moveTo,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  setMovementIntent,
  setWorldEventSource,
  setWorldFetch,
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

describe('vertical slice: continuous 3D movement over the realtime stream', () => {
  it('loads the authoritative world with 3D state: bounds, grid and world positions', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe('world-1');

    // bounds are the WORLD's box; the grid is a separate concept with an explicit origin
    expect(state.bounds).not.toBeNull();
    expect(state.grid).not.toBeNull();
    expect(state.grid?.cellSize).toBe(1);
    expect(state.grid?.origin).toEqual({ x: -5, y: 0, z: -5 });

    // cells are NOT bound to the world origin, and tile view models carry world positions
    const origin = state.tiles.find((tile) => tile.cellX === 0 && tile.cellZ === 0);
    expect(origin?.position).toEqual({ x: -4.5, y: 0, z: -4.5 });
    expect(state.tiles).toHaveLength(100);
    expect(new Set(state.tiles.map((tile) => tile.terrain))).toEqual(
      new Set(['grass', 'path', 'water', 'blocked']),
    );

    // entities are 3D and the actor spawns at the centre cell's world centre
    expect(state.entities).toHaveLength(3);
    expect(actorPosition()).toEqual({ x: 0.5, y: 0, z: 0.5 });

    await waitFor(() => getWorldState().streamStatus === 'live');
    expect(getWorldState().streamStatus).toBe('live');
  });

  it('moves continuously: speed x dt, not tile-to-tile teleports', async () => {
    useRealServer();
    await loadWorld();

    await setMovementIntent({ x: 1, z: 0 });
    await tick(1);

    // 3 units/second at 20 Hz = 0.15 per tick, and the position is NOT a cell centre
    const afterOne = actorPosition();
    expect(approx(afterOne.x, 0.5 + STEP_UNITS)).toBe(true);
    expect(afterOne.x).not.toBe(Math.round(afterOne.x - 0.5) + 0.5);
    expect(afterOne.y).toBe(0);
    expect(afterOne.z).toBe(0.5);

    await tick(3);
    expect(approx(actorPosition().x, 0.5 + 4 * STEP_UNITS)).toBe(true);
  });

  it('applies a changed intent immediately and stops on a zero intent', async () => {
    useRealServer();
    await loadWorld();

    await setMovementIntent({ x: 0, z: 1 });
    await tick(2);
    expect(approx(actorPosition().z, 0.5 + 2 * STEP_UNITS)).toBe(true);

    await setMovementIntent({ x: 0, z: 0 });
    const stopped = actorPosition();
    const batchesBefore = lastBatches.length;
    await tick(3);
    expect(actorPosition()).toEqual(stopped);
    // a stopped actor emits nothing at all
    expect(lastBatches.slice(batchesBefore).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('resolves a blocked cell in WORLD space: the actor stops outside it and never enters', async () => {
    useRealServer();
    await loadWorld();

    // go north to z = -0.7, inside the water block's z band [-2, 0] while x = 0.5 is clear
    await setMovementIntent({ x: 0, z: -1 });
    await tick(8);
    expect(approx(actorPosition().z, 0.5 - 8 * STEP_UNITS)).toBe(true);

    // now drive west into the water: its east face is x = 0, so the circle stops at 0 + radius
    await setMovementIntent({ x: -1, z: 0 });
    await tick(20);
    const blocked = actorPosition();
    // never inside the collider...
    expect(blocked.x).toBeGreaterThanOrEqual(DEFAULT_ACTOR_RADIUS - 1e-6);
    // ...it did move...
    expect(blocked.x).toBeLessThan(0.5);
    // ...and it stopped within one step of the surface (this is a discrete-step sim: contact is
    // approached to within one integrated step, not to the exact contact point)
    expect(blocked.x).toBeLessThanOrEqual(DEFAULT_ACTOR_RADIUS + STEP_UNITS + 1e-6);
    expect(approx(blocked.z, -0.7, 1e-6)).toBe(true);

    // and it is stuck: further ticks move nothing and emit nothing
    const batchesBefore = lastBatches.length;
    await tick(5);
    expect(actorPosition()).toEqual(blocked);
    expect(lastBatches.slice(batchesBefore).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('slides along a blocked surface instead of sticking (axis-separated resolution)', async () => {
    useRealServer();
    await loadWorld();

    await setMovementIntent({ x: 0, z: -1 });
    await tick(8);
    await setMovementIntent({ x: -1, z: 0 });
    await tick(20);
    const atWall = actorPosition();
    expect(atWall.x).toBeGreaterThanOrEqual(DEFAULT_ACTOR_RADIUS - 1e-6);

    // diagonal north-west: x is blocked by the water, z is free, so the actor keeps sliding north
    const diagonal = 1 / Math.SQRT2;
    await setMovementIntent({ x: -diagonal, z: -diagonal });
    await tick(4);
    const slid = actorPosition();
    expect(slid.z).toBeLessThan(atWall.z);
    expect(approx(slid.x, atWall.x, 1e-9)).toBe(true);
  });

  it('collides with a world object (a tree collider), not with a cell', async () => {
    useRealServer();
    await loadWorld();

    // north to z = -0.55, inside tree-1's z band [-0.9, -0.1] (tree at (1.5, -0.5), half 0.4)
    await setMovementIntent({ x: 0, z: -1 });
    await tick(7);
    expect(approx(actorPosition().z, 0.5 - 7 * STEP_UNITS)).toBe(true);

    // east into the tree: its west face is 1.5 - 0.4 = 1.1, so the circle cannot pass 1.1 - 0.35
    await setMovementIntent({ x: 1, z: 0 });
    await tick(20);
    const stopped = actorPosition();
    const contact = 1.5 - 0.4 - DEFAULT_ACTOR_RADIUS; // 0.75
    expect(stopped.x).toBeLessThanOrEqual(contact + 1e-6); // never penetrate the tree collider
    expect(stopped.x).toBeGreaterThan(contact - STEP_UNITS - 1e-6); // but it did approach it
    expect(stopped.x).toBeLessThan(1.5);

    // and it is held there: further east ticks emit nothing
    const batchesBefore = lastBatches.length;
    await tick(3);
    expect(actorPosition()).toEqual(stopped);
    expect(lastBatches.slice(batchesBefore).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('rejects a movement intent that a client must not be able to send', async () => {
    useRealServer();
    await loadWorld();

    const post = (body: unknown) =>
      fetch(new URL(COMMAND_PATH, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // magnitude > 1, a client-named actor, a destination, or a missing movement are all 400
    expect((await post({ type: 'actor.moveIntent', movement: { x: 1, z: 1 } })).status).toBe(400);
    expect(
      (await post({ type: 'actor.moveIntent', movement: { x: 1, z: 0 }, actorId: 'ghost' })).status,
    ).toBe(400);
    expect(
      (await post({ type: 'actor.moveIntent', movement: { x: 1, z: 0 }, position: { x: 9, y: 0, z: 9 } }))
        .status,
    ).toBe(400);
    expect((await post({ type: 'actor.moveIntent' })).status).toBe(400);
    expect((await post({ type: 'actor.teleport', movement: { x: 0, z: 0 } })).status).toBe(400);
  });

  it('surfaces an unknown actor as an error without moving anything', async () => {
    useRealServer();
    await loadWorld();
    const before = actorPosition();

    currentActorId = parseActorId('ghost-actor');
    await setMovementIntent({ x: 1, z: 0 });
    await settle();

    expect(getWorldState().status).toBe('error');
    expect(getWorldState().error).not.toBeNull();
    // the last authoritative world is retained for rendering
    expect(getWorldState().grid?.cellSize).toBe(1);
    expect(actorPosition()).toEqual(before);
  });

  it('closes the stream on reset and returns to idle', async () => {
    useRealServer();
    await loadWorld();
    await waitFor(() => getWorldState().streamStatus === 'live');

    resetWorldState();

    expect(getWorldState().status).toBe('idle');
    expect(getWorldState().streamStatus).toBe('idle');
    expect(getWorldState().tiles).toHaveLength(0);
    expect(getWorldState().entities).toHaveLength(0);
  });

  it('serves the 3D world snapshot and the current protocol version, and no legacy endpoints', async () => {
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    const payload = (await response.json()) as Record<string, unknown>;
    const snapshot = payload['world'] as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      'bounds',
      'controlledActorId',
      'entities',
      'grid',
      'serverTime',
      'tiles',
      'worldId',
    ]);
    expect(snapshot['bounds']).toBeDefined();
    expect(snapshot['grid']).toBeDefined();

    const info = await fetch(new URL('/api/game-info', baseUrl));
    const gameInfo = (await info.json()) as { gameInfo: { protocolVersion: number } };
    expect(gameInfo.gameInfo.protocolVersion).toBe(PROTOCOL_VERSION);

    for (const path of ['/api/actor/move', '/api/player/move']) {
      const legacy = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'east' }),
      });
      expect(legacy.status).toBe(404);
    }
  });
});

describe('phase 8: mouse-first intents (moveTo / interact) over the real chain', () => {
  it('walks to a clicked world point and STOPS there (moveTo is a steering goal)', async () => {
    useRealServer();
    await loadWorld();

    // A goal on a clear straight line west/north of the spawn (the water block and
    // tree-2's AABB are both avoided).
    const target = { x: -2, y: 0, z: 2 };
    await moveTo(target);
    await tick(40);

    const arrived = actorPosition();
    expect(approx(arrived.x, target.x)).toBe(true);
    expect(approx(arrived.z, target.z)).toBe(true);
    expect(arrived.y).toBe(0);

    // Arrival clears the goal: further ticks emit nothing at all.
    const before = lastBatches.length;
    await tick(5);
    expect(lastBatches.slice(before).every((batch) => batch.events.length === 0)).toBe(true);
  });

  it('does not teleport: an unreachable goal stops against the obstacle', async () => {
    useRealServer();
    await loadWorld();

    // The water block spans x in [-2,0], z in [-2,0]; aim at its centre from the east.
    await moveTo({ x: -1, y: 0, z: -1 });
    await tick(60);

    const stopped = actorPosition();
    // Never inside the water AABB: the circle must stay clear of x <= 0 / z <= 0.
    expect(stopped.x).toBeGreaterThanOrEqual(-0.35 - 1e-9);
    expect(stopped.z).toBeGreaterThanOrEqual(-0.35 - 1e-9);
    // ...and it did NOT arrive at the goal centre.
    expect(Math.hypot(stopped.x - -1, stopped.z - -1)).toBeGreaterThan(0.7);
  });

  it('faces an in-range entity it is asked to interact with, and reports a rejection for a far one', async () => {
    useRealServer();
    await loadWorld();

    // tree-1 sits at (1.5, 0, -0.5); the spawn is (0.5, 0, 0.5) -> distance ~1.414 < INTERACTION_RANGE (1.5)
    await interact('tree-1');
    await settle();

    let state = getWorldState();
    expect(state.notice).toBeNull();
    const rotation = state.entities.find((e) => e.actorId === state.controlledActorId)?.rotation;
    expect(rotation).toBeDefined();
    // facing = atan2(dx, dz) with dz < 0 and dx > 0 -> a positive yaw of 3*PI/4
    const yaw = 2 * Math.atan2(rotation?.y ?? 0, rotation?.w ?? 1);
    expect(approx(yaw, (3 * Math.PI) / 4, 1e-6)).toBe(true);
    // the interaction does not move the actor
    expect(actorPosition()).toEqual({ x: 0.5, y: 0, z: 0.5 });

    // tree-2 is ~2.236 away -> out of range -> the server rejects with 409 and the
    // client surfaces a NOTICE; a rejected intent must not become a broken world.
    await interact('tree-2');
    await settle();
    state = getWorldState();
    expect(state.notice).toBe('Too far away.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();

    // an unknown target is a 404 and reads as "gone", still without breaking the world
    await interact('ghost-entity');
    await settle();
    state = getWorldState();
    expect(state.notice).toBe('That is gone.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();

    // Regression the review caught: clicking the controlled actor's OWN node is a
    // `not-interactable` rejection at distance 0. The notice must come from the server's
    // reason-carrying message, NOT from blanket-mapping every 409 to the out-of-range text.
    await interact('entity-1');
    await settle();
    state = getWorldState();
    expect(state.notice).toBe('Nothing to do with that.');
    expect(state.notice).not.toBe('Too far away.');
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();

    // a later successful intent clears the notice
    await setMovementIntent({ x: 1, z: 0 });
    await settle();
    expect(getWorldState().notice).toBeNull();
  });

  it('rejects a rejectable interact at the transport level with 409 CONFLICT', async () => {
    const response = await fetch(new URL(COMMAND_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'actor.interact', targetEntityId: 'tree-2' }),
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('CONFLICT');
    // The 409 message is player-facing contract text (the client displays it verbatim), so it is
    // the frozen phrase, NOT the raw reason token.
    expect(payload.error.message).toBe('Too far away.');

    // ...and the other rejection reason has its own phrase, so the UI can never show
    // "too far away" for a target that is zero units away.
    const own = await fetch(new URL(COMMAND_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'actor.interact', targetEntityId: 'entity-1' }),
    });
    expect(own.status).toBe(409);
    const ownPayload = (await own.json()) as { error: { code: string; message: string } };
    expect(ownPayload.error.code).toBe('CONFLICT');
    expect(ownPayload.error.message).toBe('Nothing to do with that.');

    const missing = await fetch(new URL(COMMAND_PATH, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'actor.interact', targetEntityId: 'ghost-entity' }),
    });
    expect(missing.status).toBe(404);
  });

  it('keeps presentation data off the wire: a command carrying camera/NDC fields is a 400', async () => {
    for (const body of [
      { type: 'actor.moveTo', target: { x: 1, y: 0, z: 1 }, camera: { yaw: 30 } },
      { type: 'actor.moveTo', target: { x: 1, y: 0, z: 1 }, ndc: [0.1, -0.2] },
      { type: 'actor.moveTo', target: { x: 1, y: 0, z: 1 }, screen: { x: 120, y: 80 } },
      { type: 'actor.interact', targetEntityId: 'tree-1', ray: { origin: [0, 0, 0] } },
      { type: 'actor.interact', targetEntityId: 'tree-1', viewport: { width: 800, height: 300 } },
    ]) {
      const response = await fetch(new URL(COMMAND_PATH, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});
