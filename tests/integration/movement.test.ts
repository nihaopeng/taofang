/**
 * Main-owned integration test for the phase-3 vertical slice:
 * World + Player actor + Movement, with the caller identity resolved at the
 * transport boundary.
 *
 * Like `game-info.test.ts` this deliberately imports a client module
 * (`apps/web/src/organizer`) together with backend modules
 * (`@starvalley/router`, `@starvalley/manager`). The dependency rules in
 * AGENTS.md forbid that inside module code; here it is the point — this is the
 * cross-module integration evidence Main is responsible for.
 *
 * It boots the real Router/Manager over `node:http` and drives the real
 * Organizer against it over an HTTP loopback, so the whole
 * `UI -> Organizer -> Protocol -> Router -> Manager -> Organizer` chain is
 * exercised with nothing mocked.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { createGameInfoManager, createWorldManager } from '@starvalley/manager';
import type { WorldManager } from '@starvalley/manager';
import {
  MOVE_ACTOR_PATH,
  WORLD_PATH,
  parseActorId,
  parseGetWorldResponse,
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

/**
 * The player's authoritative position is mutable server state, so each test gets
 * a fresh `WorldManager`. The listener is built once against this stable facade
 * rather than against one manager instance, which would leak position across
 * tests.
 */
let currentWorld: WorldManager;
const world: WorldManager = {
  getSnapshot: (input) => currentWorld.getSnapshot(input),
  moveActor: (input) => currentWorld.moveActor(input),
};

/**
 * Stands in for the future session -> PlayerId -> controlled ActorId lookup.
 * Mutable so a test can prove that the *resolver* decides the actor, never the
 * request body.
 */
let currentActorId: ActorId;

beforeEach(() => {
  currentWorld = createWorldManager();
  currentActorId = ACTOR_ID;
});

beforeAll(async () => {
  const gameInfo = createGameInfoManager();
  server = createServer(
    createRequestListener({
      gameInfo,
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

/** Route the Organizer's origin-relative Protocol paths at the test server. */
function useRealServer(): void {
  setWorldFetch((input, init) => fetch(new URL(input, baseUrl), init));
}

function actorPosition(): { x: number; y: number } {
  const { controlledActor } = getWorldState();
  if (controlledActor === null) {
    throw new Error('expected a loaded controlled actor');
  }
  return { x: controlledActor.x, y: controlledActor.y };
}

async function step(direction: MoveDirection): Promise<void> {
  await moveActor(direction);
}

describe('vertical slice: organizer -> protocol -> router -> manager (movement)', () => {
  it('loads the authoritative world with the controlled actor at the world centre', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(state.controlledActor).not.toBeNull();
    expect(state.controlledActor?.actorId).toBe('actor-1');
    expect(actorPosition()).toEqual({ x: 6, y: 4 });
  });

  it('moves the actor one tile east through the real request/response loop', async () => {
    useRealServer();
    await loadWorld();

    await step('east');

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().error).toBeNull();
    expect(actorPosition()).toEqual({ x: 7, y: 4 });
  });

  it('applies each direction with the frozen deltas', async () => {
    useRealServer();
    await loadWorld();

    await step('south');
    expect(actorPosition()).toEqual({ x: 6, y: 5 });
    await step('west');
    expect(actorPosition()).toEqual({ x: 5, y: 5 });
    await step('north');
    expect(actorPosition()).toEqual({ x: 5, y: 4 });
    await step('east');
    expect(actorPosition()).toEqual({ x: 6, y: 4 });
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

  it('refuses to leave the world with 200 + moved:false, without reporting an error', async () => {
    useRealServer();
    await loadWorld();

    for (let i = 0; i < 5; i += 1) {
      await step('east');
    }
    expect(actorPosition()).toEqual({ x: 11, y: 4 });

    await step('east');

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(actorPosition()).toEqual({ x: 11, y: 4 });

    await step('west');
    expect(actorPosition()).toEqual({ x: 10, y: 4 });
  });

  it('rejects a command that tries to name the actor, because the body has no actor field', async () => {
    // End-to-end proof of the authorization boundary at the wire level: the
    // Organizer never sends an actor id, and the server rejects one if a client
    // tries to supply it.
    for (const body of [
      { actorId: 'ghost', direction: 'north' },
      { playerId: 'player-1', direction: 'north' },
    ]) {
      const response = await fetch(new URL(MOVE_ACTOR_PATH, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const payload: unknown = await response.json();
      expect(payload).toEqual({
        error: { code: 'BAD_REQUEST', message: expect.any(String) as unknown as string },
      });
    }
  });

  it('resolves the actor from transport context, not from the client, and 404s an unknown one', async () => {
    useRealServer();
    await loadWorld();
    expect(actorPosition()).toEqual({ x: 6, y: 4 });

    // Simulate a session that maps to an actor the world does not know.
    currentActorId = parseActorId('ghost-actor');

    await step('north');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).not.toBeNull();
    // The Organizer keeps the last authoritative world so the UI can still render.
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(actorPosition()).toEqual({ x: 6, y: 4 });
  });

  it('exposes the actor on the wire and no longer exposes a player', async () => {
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    expect(response.status).toBe(200);

    const parsed = parseGetWorldResponse(await response.json());
    expect(parsed.world.size).toEqual({ width: 12, height: 8 });
    expect(parsed.world.actor.actorId).toBe('actor-1');
    expect(parsed.world.actor.position).toEqual({ x: 6, y: 4 });
    expect(Object.keys(parsed.world).sort()).toEqual(['actor', 'serverTime', 'size']);
  });

  it('no longer serves the phase-2 player-named move path', async () => {
    const response = await fetch(new URL('/api/player/move', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'east' }),
    });
    expect(response.status).toBe(404);
  });
});
