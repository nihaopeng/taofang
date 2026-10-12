/**
 * Main-owned integration test for the phase-5/6 primitive path:
 * World + Tile + authoritative collision (terrain AND entity occupancy) + movement,
 * over the phase-4 primitives.
 *
 * Movement is asserted as a COMPOSITION OF PRIMITIVES, not as a bespoke endpoint:
 *   UI intent -> GameCommand { type: 'actor.move' } -> POST COMMAND_PATH
 *   -> Manager: bounds, terrain walkability, blocking-entity occupancy
 *   -> GameEvent { type: 'transform.changed' } -> Organizer entity state
 *
 * It boots the real Router/Manager over `node:http` and drives the real Organizer
 * against it over an HTTP loopback, so the whole
 * `UI -> Organizer -> Protocol -> Router -> Manager -> Organizer` chain is exercised
 * with nothing mocked. Importing a client module together with backend modules is
 * forbidden inside module code (AGENTS.md) and is the point here.
 *
 * The Manager's frozen 10x10 map, in tile coordinates (x, y) with y increasing south:
 *   y=0 'gggggggggg'   y=5 'gpggggggpg'
 *   y=1 'gppppppppg'   y=6 'gppppppppg'
 *   y=2 'gpggggggpg'   y=7 'ggggTggggg'   tree-2 at (4,7)
 *   y=3 'gpgwwgggpg'   y=8 'gg##gggggg'   blocked at (2,8) (3,8)
 *   y=4 'gpgwwgTgpg'   y=9 'gggggggggg'
 *          ^^ water at (3,3) (4,3) (3,4) (4,4); tree-1 at (6,4)
 * The actor spawns at the walkable, unoccupied centre (5,5).
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
import { BRIDGE_TERRAINS } from '../../apps/web/src/render/bridge';

const ACTOR_ID = parseActorId('actor-1');

const GRASS = 'grass';
const WATER = 'water';
const BLOCKED = 'blocked';
const PATH = 'path';
const TREE = 'tree';

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

describe('vertical slice: world + tile + collision + world objects', () => {
  it('loads the authoritative world: identity, terrain kinds, objects and actor', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe('world-1');
    expect(state.world).toEqual({ width: 10, height: 10 });
    expect(state.tiles).toHaveLength(100);

    // All four terrain kinds reach the client, carried per tile.
    expect(new Set(state.tiles.map((tile) => tile.terrain))).toEqual(
      new Set([GRASS, PATH, BLOCKED, WATER]),
    );
    expect(terrainAt(0, 0)).toBe(GRASS);
    expect(terrainAt(1, 1)).toBe(PATH);
    expect(terrainAt(2, 8)).toBe(BLOCKED);
    expect(terrainAt(3, 3)).toBe(WATER);

    // World objects arrive as entities, separate from the terrain layer.
    expect(state.controlledActorId).toBe('actor-1');
    const trees = state.entities.filter((entity) => entity.kind === TREE);
    expect(trees).toHaveLength(2);
    expect(trees.map((tree) => ({ x: tree.x, y: tree.y })).sort((a, b) => a.y - b.y)).toEqual([
      { x: 6, y: 4 },
      { x: 4, y: 7 },
    ]);
    for (const tree of trees) {
      expect(tree.actorId).toBeNull();
      // A tree stands ON walkable ground: terrain and object are different layers.
      expect(terrainAt(tree.x, tree.y)).toBe(GRASS);
    }

    expect(actorTransform()).toEqual({ x: 5, y: 5 });
    expect(terrainAt(5, 5)).toBe(GRASS);
  });

  it('covers every terrain the real server can send with a bridge appearance', async () => {
    // Cross-module guard against a silently-fallback terrain. The bridge cannot know
    // the server's terrain vocabulary (it must not import the game protocol), so the
    // coverage is asserted here, where both sides are legitimately importable.
    useRealServer();
    await loadWorld();

    const terrainsOnTheWire = new Set(getWorldState().tiles.map((tile) => tile.terrain));
    expect(terrainsOnTheWire.size).toBe(4);
    for (const terrain of terrainsOnTheWire) {
      expect(BRIDGE_TERRAINS).toContain(terrain);
    }
  });

  it('moves one tile on walkable terrain through the real chain', async () => {
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

  it('refuses water: empty events, unchanged position, no client error', async () => {
    useRealServer();
    await loadWorld();

    // (5,5) -> west (4,5) -> west (3,5); the next north step targets (3,4) = water.
    await step('west');
    await step('west');
    expect(actorTransform()).toEqual({ x: 3, y: 5 });

    const refused = await postCommand({ type: 'actor.move', direction: 'north' });
    expect(refused.status).toBe(200);
    expect(parseSubmitCommandResponse(await refused.json()).events).toEqual([]);

    await step('north');
    let state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 3, y: 5 });

    // The world stays usable: a legal step afterwards works.
    await step('south');
    state = getWorldState();
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 3, y: 6 });
  });

  it('refuses a blocking world object: the tree tile cannot be entered', async () => {
    useRealServer();
    await loadWorld();

    // (5,5) -> north (5,4) -> north (5,3) -> east (6,3): directly NORTH of tree-1 at (6,4).
    await step('north');
    await step('north');
    await step('east');
    expect(actorTransform()).toEqual({ x: 6, y: 3 });

    // South into the tree's tile is refused by entity occupancy, not by terrain.
    const refused = await postCommand({ type: 'actor.move', direction: 'south' });
    expect(refused.status).toBe(200);
    expect(parseSubmitCommandResponse(await refused.json()).events).toEqual([]);

    await step('south');
    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 6, y: 3 });
    expect(terrainAt(6, 4)).toBe(GRASS);
  });

  it('lets the actor stand both behind and in front of the tree', async () => {
    useRealServer();
    await loadWorld();

    // South of tree-1 at (6,4): one step east from the spawn.
    await step('east');
    expect(actorTransform()).toEqual({ x: 6, y: 5 });

    // ...and back around to the north side is reachable (occupancy is per tile, not a radius).
    await step('west');
    await step('north');
    await step('north');
    await step('east');
    expect(actorTransform()).toEqual({ x: 6, y: 3 });
  });

  it('gives a client no way to submit a destination, so collision cannot be bypassed', async () => {
    useRealServer();
    await loadWorld();

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
    expect(parsed.world.entities).toHaveLength(3);

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
