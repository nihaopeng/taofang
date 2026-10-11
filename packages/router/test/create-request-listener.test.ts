import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  WORLD_PATH,
  isGetGameInfoResponse,
  isHealthStatus,
  parseActorId,
  parseGetGameInfoResponse,
  parseGetWorldResponse,
  parseSubmitCommandResponse,
} from '@starvalley/protocol';
import type {
  EntityState,
  GameInfo,
  HealthStatus,
  ProtocolError,
  ProtocolErrorCode,
  WorldSnapshot,
} from '@starvalley/protocol';
import { createWorldManager } from '@starvalley/manager';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';
import { createRequestListener } from '../src/index.ts';
import type { ResolveActorId } from '../src/index.ts';

const ACTOR_ID = parseActorId('actor-1');

const GAME_INFO: GameInfo = {
  gameName: 'Test Valley',
  serverVersion: '1.2.3',
  protocolVersion: 3,
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
    actorId: ACTOR_ID,
    clock: () => new Date(FIXED_TIME),
  });
  return Object.assign(world, overrides);
}

const openServers: Server[] = [];

async function startServer(
  gameInfo: GameInfoManager = createFakeManager(),
  world: WorldManager = createTestWorld(),
  resolveActorId: ResolveActorId = () => ACTOR_ID,
): Promise<string> {
  const server = createServer(createRequestListener({ gameInfo, world, resolveActorId }));
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function postCommand(baseUrl: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${COMMAND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** GET `WORLD_PATH` and return the validated snapshot. */
async function fetchWorld(baseUrl: string): Promise<WorldSnapshot> {
  const response = await fetch(`${baseUrl}${WORLD_PATH}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const parsed = parseGetWorldResponse(await response.json());
  return parsed.world;
}

/** The single entity the caller controls (`actorId` is the resolved actor). */
function controlledEntity(world: WorldSnapshot): EntityState {
  const entity = world.entities.find((candidate) => candidate.actorId === ACTOR_ID);
  expect(entity).toBeDefined();
  return entity as EntityState;
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

  it('maps a thrown manager error on the command path to an opaque 500 INTERNAL_ERROR', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'command-secret-message with stack detail';
    const baseUrl = await startServer(
      createFakeManager(),
      createTestWorld({
        submitCommand: () => {
          throw new Error(secret);
        },
      }),
    );

    try {
      const response = await postCommand(
        baseUrl,
        JSON.stringify({ type: 'actor.move', direction: 'east' }),
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

  it('serves GET /api/world as a protocol GetWorldResponse keyed by controlled actor', async () => {
    const baseUrl = await startServer();

    const world = await fetchWorld(baseUrl);

    // Guard against the historical `{ world: { world: { size } } }` nesting
    // that `toEqual` on an unknown silently accepted (tsc could not catch it).
    expect(Object.keys(world).sort()).toEqual([
      'controlledActorId',
      'entities',
      'serverTime',
      'size',
    ]);
    expect(world.size).toEqual({ width: 3, height: 3 });
    expect(world.serverTime).toBe(FIXED_TIME);
    expect(world.controlledActorId).toBe(ACTOR_ID);

    const controlled = controlledEntity(world);
    expect(controlled.kind).toBe('character');
    expect(controlled.visible).toBe(true);
    expect(controlled.transform).toEqual({ x: 1, y: 1 });
  });

  it('advances the controlled actor one tile east and reports it as a single transform.changed event', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'east' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const parsed = parseSubmitCommandResponse(await response.json());
    expect(parsed.serverTime).toBe(FIXED_TIME);

    const changed = parsed.events.filter((event) => event.type === 'transform.changed');
    expect(changed).toHaveLength(1);
    const event = changed[0];
    if (event.type !== 'transform.changed') {
      throw new Error('expected a transform.changed event');
    }
    expect(event.transform).toEqual({ x: 2, y: 1 });

    // The authoritative snapshot agrees with the emitted delta.
    const world = await fetchWorld(baseUrl);
    expect(controlledEntity(world).transform).toEqual({ x: 2, y: 1 });
  });

  it('expresses a refused step as 200 with an empty events array, not an error', async () => {
    const baseUrl = await startServer();

    // Centre { 1, 1 } in a 3x3 world: one east step is legal, the second is not.
    const first = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'east' }),
    );
    expect(first.status).toBe(200);
    const firstBody = parseSubmitCommandResponse(await first.json());
    expect(firstBody.events).toHaveLength(1);

    const second = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'east' }),
    );

    // A refused command is not an error: still 200 with no observable delta.
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const secondBody = parseSubmitCommandResponse(await second.json());
    expect(secondBody.events).toEqual([]);
  });

  it('returns 400 BAD_REQUEST for an unknown command type', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.dance', direction: 'east' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 404 NOT_FOUND when the resolved actor is unknown to the manager', async () => {
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), () =>
      parseActorId('nobody'),
    );

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'north' }),
    );

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('nobody');
  });

  it('rejects a command body that tries to name the actor it acts as', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', actorId: 'actor-1', direction: 'east' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('rejects a command body carrying the retired playerId field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', playerId: 'player-1', direction: 'east' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('treats the resolver as authoritative over any request-shaped identity', async () => {
    // The manager only knows `actor-1`; the resolver yields a different actor,
    // so the command is rejected even though the body cannot name one at all.
    const resolver = vi.fn((): ReturnType<ResolveActorId> => parseActorId('ghost'));
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), resolver);

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'east' }),
    );

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('ghost');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('consults the resolver exactly once per command request', async () => {
    const resolver = vi.fn((): ReturnType<ResolveActorId> => ACTOR_ID);
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), resolver);

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'east' }),
    );

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('consults the resolver exactly once per world request', async () => {
    const resolver = vi.fn((): ReturnType<ResolveActorId> => ACTOR_ID);
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), resolver);

    const response = await fetch(`${baseUrl}${WORLD_PATH}`);

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('maps a throwing resolver to an opaque 500 and leaks no reason', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'resolver-secret do not leak';
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), () => {
      throw new Error(secret);
    });

    try {
      const response = await fetch(`${baseUrl}${WORLD_PATH}`);

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(secret);
      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('maps a rejecting resolver to an opaque 500 and leaks no reason', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'async-resolver-secret do not leak';
    const baseUrl = await startServer(createFakeManager(), createTestWorld(), async () => {
      throw new Error(secret);
    });

    try {
      const response = await fetch(`${baseUrl}${WORLD_PATH}`);

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(secret);
      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns 400 BAD_REQUEST for an invalid direction', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'north-west' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for a missing field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, JSON.stringify({ type: 'actor.move' }));

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for an extra field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.move', direction: 'north', extra: true }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for malformed JSON', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, '{ "type":');

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toBe('Request body is not valid JSON');
  });

  it('returns 400 BAD_REQUEST for an empty body', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, '');

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toBe('Request body is required');
  });

  it('returns 400 BAD_REQUEST when the body exceeds the 64 KiB cap', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, 'x'.repeat(70 * 1024));

    const body = await expectProtocolError(response, 'BAD_REQUEST', 400);
    expect(body.error.message).toContain('65536');
  });

  it('returns 405 with Allow: POST for GET on the command path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${COMMAND_PATH}`);

    expect(response.headers.get('allow')).toBe('POST');
    await expectProtocolError(response, 'METHOD_NOT_ALLOWED', 405);
  });

  it('does not advertise HEAD for the POST-only command path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${COMMAND_PATH}`, { method: 'HEAD' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('exposes the command route at COMMAND_PATH and treats the old move path as unknown', async () => {
    expect(COMMAND_PATH).toBe('/api/command');

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/actor/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'actor.move', direction: 'east' }),
    });

    await expectProtocolError(response, 'NOT_FOUND', 404);
  });
});
