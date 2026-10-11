/**
 * Main-owned integration test for the phase-2 vertical slice:
 * World / Player / Movement.
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
import { WORLD_PATH, parseGetWorldResponse } from '@starvalley/protocol';
import { createRequestListener } from '@starvalley/router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getWorldState,
  loadWorld,
  movePlayer,
  resetWorldFetch,
  resetWorldState,
  setWorldFetch,
  subscribeWorld,
} from '../../apps/web/src/organizer';
import type { MoveDirection } from '../../apps/web/src/organizer';

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
  getSnapshot: () => currentWorld.getSnapshot(),
  movePlayer: (command) => currentWorld.movePlayer(command),
};

beforeEach(() => {
  currentWorld = createWorldManager();
});

beforeAll(async () => {
  const gameInfo = createGameInfoManager();
  server = createServer(createRequestListener({ gameInfo, world }));
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

function position(): { x: number; y: number } {
  const { player } = getWorldState();
  if (player === null) {
    throw new Error('expected a loaded player');
  }
  return { x: player.x, y: player.y };
}

async function step(direction: MoveDirection): Promise<void> {
  await movePlayer(direction);
}

describe('vertical slice: organizer -> protocol -> router -> manager (movement)', () => {
  it('loads the authoritative world and places the player at the world centre', async () => {
    useRealServer();

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(state.player).not.toBeNull();
    expect(position()).toEqual({ x: 6, y: 4 });
  });

  it('moves the player one tile east through the real request/response loop', async () => {
    useRealServer();
    await loadWorld();

    await step('east');

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().error).toBeNull();
    expect(position()).toEqual({ x: 7, y: 4 });
  });

  it('applies each direction with the frozen deltas', async () => {
    useRealServer();
    await loadWorld();

    await step('south');
    expect(position()).toEqual({ x: 6, y: 5 });
    await step('west');
    expect(position()).toEqual({ x: 5, y: 5 });
    await step('north');
    expect(position()).toEqual({ x: 5, y: 4 });
    await step('east');
    expect(position()).toEqual({ x: 6, y: 4 });
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

    // Walk east from x=6 to the last tile: x=11.
    for (let i = 0; i < 5; i += 1) {
      await step('east');
    }
    expect(position()).toEqual({ x: 11, y: 4 });

    // The next step must be refused by the authoritative server...
    await step('east');

    // ...as a normal outcome, not a failure.
    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(position()).toEqual({ x: 11, y: 4 });

    // And the world must remain usable afterwards.
    await step('west');
    expect(position()).toEqual({ x: 10, y: 4 });
  });

  it('maps an unknown player (404) to a user-presentable error, keeping the world loaded', async () => {
    useRealServer();
    await loadWorld();
    // Re-point the same origin-relative call at the real server, but rewrite the
    // command body so the server sees a player it does not know.
    setWorldFetch((input, init) => {
      if (init?.method === 'POST') {
        const rewritten: RequestInit = {
          ...init,
          body: JSON.stringify({ playerId: 'ghost', direction: 'north' }),
        };
        return fetch(new URL(input, baseUrl), rewritten);
      }
      return fetch(new URL(input, baseUrl), init);
    });

    await step('north');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).not.toBeNull();
    // The Organizer keeps the last authoritative world so the UI can still render.
    expect(state.world).toEqual({ width: 12, height: 8 });
    expect(position()).toEqual({ x: 6, y: 4 });
  });

  it('keeps the wire shape flat: the corrected WorldSnapshot has no nested world field', async () => {
    // Guards against regressing to the original `response.world.world.size` wart.
    const response = await fetch(new URL(WORLD_PATH, baseUrl));
    expect(response.status).toBe(200);

    const parsed = parseGetWorldResponse(await response.json());
    expect(parsed.world.size).toEqual({ width: 12, height: 8 });
    expect(parsed.world.player.position).toEqual({ x: 6, y: 4 });
    expect(Object.keys(parsed.world).sort()).toEqual(['player', 'serverTime', 'size']);
  });
});
