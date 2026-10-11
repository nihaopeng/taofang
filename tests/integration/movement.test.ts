/**
 * Main-owned integration test for the phase-4 primitive path.
 *
 * Movement is asserted as a COMPOSITION OF PRIMITIVES, not as a bespoke endpoint:
 *   UI intent -> GameCommand { type: 'actor.move' } -> POST COMMAND_PATH
 *   -> Manager rules -> GameEvent { type: 'transform.changed' }
 *   -> Organizer entity state
 *
 * It boots the real Router/Manager over `node:http` and drives the real Organizer
 * against it over an HTTP loopback, so the whole
 * `UI -> Organizer -> Protocol -> Router -> Manager -> Organizer` chain is exercised
 * with nothing mocked. Importing a client module together with backend modules is
 * forbidden inside module code (AGENTS.md) and is the point here: this is the
 * cross-module integration evidence Main owns.
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

/** The transform of the actor this client controls, read from Organizer state. */
function actorTransform(): { x: number; y: number } {
  const { entities, controlledActorId } = getWorldState();
  const entity = entities.find((candidate) => candidate.actorId === controlledActorId);
  if (entity === undefined) {
    throw new Error('expected a controlled actor entity');
  }
  return { x: entity.x, y: entity.y };
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

describe('vertical slice: movement as primitive composition', () => {
  it('loads full state as a snapshot: entities + controlledActorId', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(state.controlledActorId).toBe('actor-1');

    expect(state.entities).toHaveLength(1);
    const entity = state.entities[0];
    expect(entity?.actorId).toBe('actor-1');
    expect(entity?.kind).toBe('character');
    expect(entity?.visible).toBe(true);
    expect({ x: entity?.x, y: entity?.y }).toEqual({ x: 6, y: 4 });
  });

  it('moves through the real chain and receives a transform.changed event', async () => {
    useRealServer();
    await loadWorld();

    await step('east');

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().error).toBeNull();
    expect(actorTransform()).toEqual({ x: 7, y: 4 });
  });

  it('emits exactly one transform.changed event on the wire for a successful step', async () => {
    // Wire-level proof that movement is a primitive composition: the response is a
    // GameEvent list, not a bespoke move result.
    const response = await postCommand({ type: 'actor.move', direction: 'north' });
    expect(response.status).toBe(200);

    const body = parseSubmitCommandResponse(await response.json());
    expect(body.events).toHaveLength(1);

    const event = body.events[0];
    expect(event?.type).toBe('transform.changed');
    if (event?.type !== 'transform.changed') {
      throw new Error('expected a transform.changed event');
    }
    expect(event.transform).toEqual({ x: 6, y: 3 });
    expect(typeof body.serverTime).toBe('string');
  });

  it('applies each direction with the frozen deltas', async () => {
    useRealServer();
    await loadWorld();

    await step('south');
    expect(actorTransform()).toEqual({ x: 6, y: 5 });
    await step('west');
    expect(actorTransform()).toEqual({ x: 5, y: 5 });
    await step('north');
    expect(actorTransform()).toEqual({ x: 5, y: 4 });
    await step('east');
    expect(actorTransform()).toEqual({ x: 6, y: 4 });
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

  it('expresses a refused step as an EMPTY event list, not an error', async () => {
    useRealServer();
    await loadWorld();

    for (let i = 0; i < 5; i += 1) {
      await step('east');
    }
    expect(actorTransform()).toEqual({ x: 11, y: 4 });

    // Wire level: the refusal carries no events and is still a 200.
    const refused = await postCommand({ type: 'actor.move', direction: 'east' });
    expect(refused.status).toBe(200);
    expect(parseSubmitCommandResponse(await refused.json()).events).toEqual([]);

    // Client level: nothing changes and no error is reported.
    await step('east');
    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(actorTransform()).toEqual({ x: 11, y: 4 });

    await step('west');
    expect(actorTransform()).toEqual({ x: 10, y: 4 });
  });

  it('rejects a body that tries to name the actor or invent a command primitive', async () => {
    for (const body of [
      { type: 'actor.move', actorId: 'ghost', direction: 'north' },
      { type: 'actor.move', playerId: 'player-1', direction: 'north' },
      { type: 'actor.dance', direction: 'north' },
      { playerId: 'player-1', direction: 'north' },
    ]) {
      const response = await postCommand(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: expect.any(String) as unknown as string },
      });
    }
  });

  it('resolves the actor from transport context and 404s an unknown one', async () => {
    useRealServer();
    await loadWorld();
    expect(actorTransform()).toEqual({ x: 6, y: 4 });

    currentActorId = parseActorId('ghost-actor');

    await step('north');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).not.toBeNull();
    // The last authoritative world is kept so the UI can still render.
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(actorTransform()).toEqual({ x: 6, y: 4 });
  });

  it('serves the primitive snapshot shape and the identity-era protocol version', async () => {
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    expect(response.status).toBe(200);

    const parsed = parseGetWorldResponse(await response.json());
    expect(Object.keys(parsed.world).sort()).toEqual([
      'controlledActorId',
      'entities',
      'serverTime',
      'size',
    ]);
    expect(parsed.world.controlledActorId).toBe('actor-1');
    expect(parsed.world.entities).toHaveLength(1);
    expect(Object.keys(parsed.world.entities[0] ?? {}).sort()).toEqual([
      'actorId',
      'entityId',
      'kind',
      'transform',
      'visible',
    ]);

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
