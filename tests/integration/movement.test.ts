/**
 * Main-owned integration test for the phase-5 primitive path:
 * World + Tile + authoritative collision + movement, over the phase-4 primitives.
 *
 * Movement is asserted as a COMPOSITION OF PRIMITIVES, not as a bespoke endpoint:
 *   UI intent -> GameCommand { type: 'actor.move' } -> POST COMMAND_PATH
 *   -> Manager: bounds AND terrain walkability -> GameEvent { type: 'transform.changed' }
 *   -> Organizer entity state
 *
 * It boots the real Router/Manager over `node:http` and drives the real Organizer
 * against it over an HTTP loopback, so the whole
 * `UI -> Organizer -> Protocol -> Router -> Manager -> Organizer` chain is exercised
 * with nothing mocked. Importing a client module together with backend modules is
 * forbidden inside module code (AGENTS.md) and is the point here.
 *
 * The default 10x10 map (see `@starvalley/manager`) is used as-is, so the collision
 * assertions below are anchored to real terrain:
 *   row 3 = 'gg###ggggg'  => (2,3) (3,3) (4,3) blocked
 *   row 4 = 'gg#ggggggg'  => (2,4) blocked
 *   row 6 = 'gggggppggg'  => (5,6) (6,6) path (walkable, visually different)
 *   centre (5,5) is grass.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { createGameInfoManager, createWorldManager } from '@starvalley/manager';
import type { WorldManager } from '@starvalley/manager';
import {
  COMMAND_PATH,
  PROTOCOL_VERSION,
  WORLD_PATH,
  parseActorId,
  parseGetWorldResponse,
  parseSubmitCommandResponse,
} from '@starvalley/protocol';
import type { ActorId } from '@starvalley/protocol';
import { createRequestListener } from '@starvalley/router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getWorldState,
  loadWorld,
  moveActor,
  resetWorldFetch,
  resetWorldState,
  setWorldFetch,
  subscribeWorld,
} from '../../apps/web/src/organizer';
import type { MoveDirection } from '../../apps/web/src/organizer';

const ACTOR_ID = parseActorId('actor-1');

let server: Server;
let baseUrl: string;

/** Fresh world per test: authoritative position is mutable server state. */
let currentWorld: WorldManager;
const world: WorldManager = {
  getSnapshot: (input) => currentWorld.getSnapshot(input),
  submitCommand: (input) => currentWorld.submitCommand(input),
};

/** Stands in for the future session -> PlayerId -> controlled ActorId lookup. */
let currentActorId: ActorId;

beforeEach(() => {
  currentWorld = createWorldManager();
  currentActorId = ACTOR_ID;
});

beforeAll(async () => {
  server = createServer(
    createRequestListener({
      gameInfo: createGameInfoManager(),
      world,
      resolveActorId: () => currentActorId,
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
});

function useRealServer(): void {
  setWorldFetch((input, init) => fetch(new URL(input, baseUrl), init));
}

function actorTransform(): { x: number; y: number } {
  const { entities, controlledActorId } = getWorldState();
  const entity = entities.find((candidate) => candidate.actorId === controlledActorId);
  if (entity === undefined) {
    throw new Error('expected a controlled actor entity');
  }
  return { x: entity.x, y: entity.y };
}

function terrainAt(x: number, y: number): string | undefined {
  return getWorldState().tiles.find((tile) => tile.x === x && tile.y === y)?.terrain;
}

async function step(direction: MoveDirection): Promise<void> {
  await moveActor(direction);
}

async function postCommand(body: unknown): Promise<Response> {
  return fetch(new URL(COMMAND_PATH, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('vertical slice: world + tile + authoritative collision', () => {
  it('loads the authoritative world: identity, dimensions, terrain and actor', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe('world-1');
    expect(state.world).toEqual({ width: 10, height: 10 });
    expect(state.tiles).toHaveLength(100);

    // Terrain is carried per tile and is not a client-derived property.
    expect(new Set(state.tiles.map((tile) => tile.terrain))).toEqual(
      new Set(['grass', 'path', 'blocked']),
    );
    expect(terrainAt(0, 0)).toBe('grass');
    expect(terrainAt(2, 4)).toBe('blocked');
    expect(terrainAt(5, 6)).toBe('path');

    // The actor spawns on the walkable centre tile.
    expect(state.controlledActorId).toBe('actor-1');
    expect(actorTransform()).toEqual({ x: 5, y: 5 });
    expect(terrainAt(5, 5)).toBe('grass');
  });

  it('moves one tile east through the real chain on walkable terrain', async () => {
    useRealServer();
    await loadWorld();

    await step('east');

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().error).toBeNull();
    expect(actorTransform()).toEqual({ x: 6, y: 5 });
  });

  it('emits exactly one transform.changed event on the wire for a legal step', async () => {
    const response = await postCommand({ type: 'actor.move', direction: 'north' });
    expect(response.status).toBe(200);

    const body = parseSubmitCommandResponse(await response.json());
    expect(body.events).toHaveLength(1);

    const event = body.events[0];
    expect(event?.type).toBe('transform.changed');
    if (event?.type !== 'transform.changed') {
      throw new Error('expected a transform.changed event');
    }
    expect(event.transform).toEqual({ x: 5, y: 4 });
  });

  it('blocks movement into a blocked tile: empty events, unchanged position, no client error', async () => {
    useRealServer();
    await loadWorld();

    // (5,5) -> north -> (5,4) grass -> west -> (4,4) grass -> west -> (3,4) grass
    await step('north');
    await step('west');
    await step('west');
    expect(actorTransform()).toEqual({ x: 3, y: 4 });

    // The next west step targets (2,4), which is 'blocked' terrain.
    const refused = await postCommand({ type: 'actor.move', direction: 'west' });
    expect(refused.status).toBe(200);
    expect(parseSubmitCommandResponse(await refused.json()).events).toEqual([]);

    await step('west');
    let state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 3, y: 4 });

    // (3,3) is blocked too (row 3 is 'gg###ggggg'), so the whole cluster resists.
    await step('north');
    expect(actorTransform()).toEqual({ x: 3, y: 4 });

    // ...and the world is still usable: a legal step afterwards works.
    await step('east');
    state = getWorldState();
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 4, y: 4 });
  });

  it('treats path terrain as walkable but visually distinct', async () => {
    useRealServer();
    await loadWorld();

    // (5,5) grass -> south -> (5,6) path
    await step('south');

    expect(getWorldState().error).toBeNull();
    expect(actorTransform()).toEqual({ x: 5, y: 6 });
    expect(terrainAt(5, 6)).toBe('path');
  });

  it('gives a client no way to submit a destination, so collision cannot be bypassed', async () => {
    useRealServer();
    await loadWorld();

    // The only mutation primitive is a direction. A hand-crafted body that tries to
    // teleport (a destination) or to name the actor is rejected outright.
    for (const body of [
      { type: 'actor.move', direction: 'east', x: 9, y: 9 },
      { type: 'actor.move', direction: 'east', position: { x: 9, y: 9 } },
      { type: 'actor.move', direction: 'east', to: { x: 9, y: 9 } },
      { type: 'actor.move', direction: 'east', actorId: 'ghost' },
      { type: 'actor.move', direction: 'east', playerId: 'player-1' },
    ]) {
      const response = await postCommand(body);
      expect(response.status).toBe(400);
    }

    // And no legal client path can move more than one tile: the authoritative answer
    // is produced by the Manager, not by the payload.
    await step('east');
    expect(actorTransform()).toEqual({ x: 6, y: 5 });
  });

  it('observes the idle -> loading -> ready lifecycle against a real server', async () => {
    const observed: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      observed.push(next.status);
    });

    useRealServer();
    await loadWorld();
    unsubscribe();

    expect(observed).toEqual(['loading', 'ready']);
  });

  it('resolves the actor from transport context and 404s an unknown one', async () => {
    useRealServer();
    await loadWorld();
    expect(actorTransform()).toEqual({ x: 5, y: 5 });

    currentActorId = parseActorId('ghost-actor');

    await step('north');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).not.toBeNull();
    expect(state.world).toEqual({ width: 10, height: 10 });
    expect(actorTransform()).toEqual({ x: 5, y: 5 });
  });

  it('serves the world/tile snapshot shape and the current protocol version', async () => {
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    expect(response.status).toBe(200);

    const parsed = parseGetWorldResponse(await response.json());
    expect(Object.keys(parsed.world).sort()).toEqual([
      'controlledActorId',
      'entities',
      'serverTime',
      'size',
      'tiles',
      'worldId',
    ]);
    expect(parsed.world.worldId).toBe('world-1');
    expect(parsed.world.tiles).toHaveLength(100);
    expect(Object.keys(parsed.world.tiles[0] ?? {}).sort()).toEqual(['terrain', 'transform']);

    const info = await fetch(new URL('/api/game-info', baseUrl));
    const payload = (await info.json()) as { gameInfo: { protocolVersion: number } };
    expect(payload.gameInfo.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('no longer serves any per-feature move endpoint', async () => {
    for (const path of ['/api/actor/move', '/api/player/move']) {
      const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'east' }),
      });
      expect(response.status).toBe(404);
    }
  });
});
