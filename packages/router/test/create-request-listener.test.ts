import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAME_INFO_PATH,
  HEALTH_PATH,
  PLAYER_MOVE_PATH,
  WORLD_PATH,
  isGetGameInfoResponse,
  isHealthStatus,
  isMovePlayerResponse,
  parseGetGameInfoResponse,
  parseGetWorldResponse,
  parseMovePlayerResponse,
} from '@starvalley/protocol';
import type {
  GameInfo,
  HealthStatus,
  MovePlayerResponse,
  ProtocolError,
  ProtocolErrorCode,
} from '@starvalley/protocol';
import { createWorldManager } from '@starvalley/manager';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';
import { createRequestListener } from '../src/index.ts';

const GAME_INFO: GameInfo = {
  gameName: 'Test Valley',
  serverVersion: '1.2.3',
  protocolVersion: 1,
  serverTime: '2024-01-01T00:00:00.000Z',
};

const HEALTH: HealthStatus = {
  status: 'ok',
  uptimeSeconds: 12.5,
  serverTime: '2024-01-01T00:00:00.000Z',
};

const FIXED_TIME = '2024-01-01T00:00:00.000Z';

function createFakeManager(overrides: Partial<GameInfoManager> = {}): GameInfoManager {
  const manager: GameInfoManager = {
    getGameInfo: () => GAME_INFO,
    getHealth: () => HEALTH,
  };
  return Object.assign(manager, overrides);
}

/**
 * Real Manager, tiny deterministic world. Centre of a 3x3 world is `{ x: 1, y: 1 }`,
 * which keeps edge behaviour easy to assert.
 */
function createTestWorld(overrides: Partial<WorldManager> = {}): WorldManager {
  const world = createWorldManager({
    worldSize: { width: 3, height: 3 },
    playerId: 'player-1',
    playerName: 'Player One',
    clock: () => new Date(FIXED_TIME),
  });
  return Object.assign(world, overrides);
}

const openServers: Server[] = [];

async function startServer(
  gameInfo: GameInfoManager = createFakeManager(),
  world: WorldManager = createTestWorld(),
): Promise<string> {
  const server = createServer(createRequestListener({ gameInfo, world }));
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function postMove(baseUrl: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${PLAYER_MOVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/**
 * Assert an error response is a well-formed `ProtocolError` with the expected
 * code/status, and that its raw body leaks no server internals.
 */
async function expectProtocolError(
  response: Response,
  code: ProtocolErrorCode,
  status: number,
): Promise<ProtocolError> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

  const raw = await response.text();
  expect(raw).not.toContain('Error');
  expect(raw).not.toContain('at ');
  expect(raw).not.toContain('stack');

  const body = JSON.parse(raw) as ProtocolError;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Undici keeps idle keep-alive sockets for ~4s; close them eagerly
          // so teardown does not depend on socket timeouts.
          server.closeAllConnections();
        }),
    ),
  );
});

describe('createRequestListener', () => {
  it('serves GET /api/game-info as a protocol GetGameInfoResponse', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(isGetGameInfoResponse(body)).toBe(true);
    expect(parseGetGameInfoResponse(body)).toEqual({ gameInfo: GAME_INFO });
  });

  it('serves GET /api/health as a protocol HealthStatus', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(isHealthStatus(body)).toBe(true);
    expect(body).toEqual(HEALTH);
  });

  it('returns a 404 ProtocolError for an unknown path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/api/nope`);

    await expectProtocolError(response, 'NOT_FOUND', 404);
  });

  it('returns 405 with an Allow header for POST on a known path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`, { method: 'POST' });

    expect(response.headers.get('allow')).toBe('GET, HEAD');
    const body = await expectProtocolError(response, 'METHOD_NOT_ALLOWED', 405);
    expect(body.error.message).toContain('POST');
  });

  it('serves HEAD for a GET resource with matching headers and an empty body', async () => {
    const baseUrl = await startServer();

    const getResponse = await fetch(`${baseUrl}${HEALTH_PATH}`);
    const headResponse = await fetch(`${baseUrl}${HEALTH_PATH}`, { method: 'HEAD' });

    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headResponse.headers.get('content-length')).toBe(
      getResponse.headers.get('content-length'),
    );
    expect(await headResponse.text()).toBe('');
  });

  it('maps a thrown manager error to an opaque 500 INTERNAL_ERROR', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'super-secret-message with stack detail';
    const baseUrl = await startServer(
      createFakeManager({
        getGameInfo: () => {
          throw new Error(secret);
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`);

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const raw = await response.text();
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain('Error');
      expect(raw).not.toContain('at ');

      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Internal server error');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('maps a thrown manager error on the move path to an opaque 500 INTERNAL_ERROR', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'move-secret-message with stack detail';
    const baseUrl = await startServer(
      createFakeManager(),
      createTestWorld({
        movePlayer: () => {
          throw new Error(secret);
        },
      }),
    );

    try {
      const response = await postMove(
        baseUrl,
        JSON.stringify({ playerId: 'player-1', direction: 'east' }),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const raw = await response.text();
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain('Error');
      expect(raw).not.toContain('at ');

      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Internal server error');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('serves GET /api/world as a protocol GetWorldResponse', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${WORLD_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    const parsed = parseGetWorldResponse(body);

    // Guard against the historical `{ world: { world: { size } } }` nesting
    // that `toEqual` on an unknown silently accepted (tsc could not catch it).
    expect(Object.keys(parsed.world).sort()).toEqual(['player', 'serverTime', 'size']);

    expect(parsed).toEqual({
      world: {
        size: { width: 3, height: 3 },
        player: { id: 'player-1', name: 'Player One', position: { x: 1, y: 1 } },
        serverTime: FIXED_TIME,
      },
    });
  });

  it('moves the player exactly one tile in the requested direction', async () => {
    const baseUrl = await startServer();

    const response = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'player-1', direction: 'east' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(isMovePlayerResponse(body)).toBe(true);
    const parsed: MovePlayerResponse = parseMovePlayerResponse(body);
    expect(parsed.result.moved).toBe(true);
    expect(parsed.result.player.position).toEqual({ x: 2, y: 1 });
    expect(parsed.result.serverTime).toBe(FIXED_TIME);
  });

  it('refuses a step that leaves the world with 200, moved:false, and an unchanged position', async () => {
    const baseUrl = await startServer();

    // Centre { 1, 1 } in a 3x3 world: one east step is legal, the second is not.
    const first = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'player-1', direction: 'east' }),
    );
    const firstBody = (await first.json()) as MovePlayerResponse;
    expect(first.status).toBe(200);
    expect(firstBody.result.moved).toBe(true);
    expect(firstBody.result.player.position).toEqual({ x: 2, y: 1 });

    const second = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'player-1', direction: 'east' }),
    );

    // A blocked step is not an error: still 200, moved:false, position unchanged.
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const secondBody = parseMovePlayerResponse(await second.json());
    expect(secondBody.result.moved).toBe(false);
    expect(secondBody.result.player.position).toEqual({ x: 2, y: 1 });
  });

  it('returns 404 NOT_FOUND for an unknown player', async () => {
    const baseUrl = await startServer();

    const response = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'nobody', direction: 'north' }),
    );

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('nobody');
  });

  it('returns 400 BAD_REQUEST for an invalid direction', async () => {
    const baseUrl = await startServer();

    const response = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'player-1', direction: 'north-west' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for a missing field', async () => {
    const baseUrl = await startServer();

    const response = await postMove(baseUrl, JSON.stringify({ playerId: 'player-1' }));

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for an extra field', async () => {
    const baseUrl = await startServer();

    const response = await postMove(
      baseUrl,
      JSON.stringify({ playerId: 'player-1', direction: 'north', extra: true }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for malformed JSON', async () => {
    const baseUrl = await startServer();

    const response = await postMove(baseUrl, '{ "playerId": "player-1", "direction":');

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toBe('Request body is not valid JSON');
  });

  it('returns 400 BAD_REQUEST for an empty body', async () => {
    const baseUrl = await startServer();

    const response = await postMove(baseUrl, '');

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toBe('Request body is required');
  });

  it('returns 400 BAD_REQUEST when the body exceeds the 64 KiB cap', async () => {
    const baseUrl = await startServer();

    const response = await postMove(baseUrl, 'x'.repeat(70 * 1024));

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toContain('65536');
  });

  it('returns 405 with Allow: POST for GET on the move path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${PLAYER_MOVE_PATH}`);

    expect(response.headers.get('allow')).toBe('POST');
    await expectProtocolError(response, 'METHOD_NOT_ALLOWED', 405);
  });

  it('does not advertise HEAD for the POST-only move path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${PLAYER_MOVE_PATH}`, { method: 'HEAD' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
