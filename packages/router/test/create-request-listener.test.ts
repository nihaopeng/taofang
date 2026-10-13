import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  STREAM_PATH,
  WORLD_PATH,
  isGetGameInfoResponse,
  isHealthStatus,
  parseActorId,
  parseColliderId,
  parseEntityId,
  parseGameEventBatch,
  parseGetGameInfoResponse,
  parseGetWorldResponse,
  parseSurfaceId,
  parseWorldId,
  parseWorldStreamMessage,
} from '@starvalley/protocol';
import type {
  ActorId,
  ColliderState,
  GameEventBatch,
  GameInfo,
  HealthStatus,
  ProtocolError,
  ProtocolErrorCode,
  SurfaceState,
  TileState,
  WorldSnapshot,
  WorldStreamMessage,
} from '@starvalley/protocol';
import { InteractionRejectedError, UnknownActorError, UnknownEntityError } from '@starvalley/manager';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';
import { createRequestListener } from '../src/index.ts';
import type { ResolveActorId, WorldStreamPort } from '../src/index.ts';

const ACTOR_ID = parseActorId('actor-1');
const ENTITY_ID = parseEntityId('entity-1');
const TEST_WORLD_ID = parseWorldId('test-world');
const FIXED_TIME = '2024-01-01T00:00:00.000Z';

/**
 * Build an `InteractionRejectedError` whose reason is typed as a plain string,
 * so a test can also exercise the router's fallback for an unrecognised (but
 * runtime-reachable) reason value.
 */
function interactionRejection(reason: string): InteractionRejectedError {
  return new InteractionRejectedError(
    parseEntityId('tree-1'),
    reason as InteractionRejectedError['reason'],
  );
}

const GAME_INFO: GameInfo = {
  gameName: 'Test Valley',
  serverVersion: '1.2.3',
  protocolVersion: 8,
  serverTime: FIXED_TIME,
};

const HEALTH: HealthStatus = {
  status: 'ok',
  uptimeSeconds: 12.5,
  serverTime: FIXED_TIME,
};

function createFakeManager(overrides: Partial<GameInfoManager> = {}): GameInfoManager {
  const manager: GameInfoManager = {
    getGameInfo: () => GAME_INFO,
    getHealth: () => HEALTH,
  };
  return Object.assign(manager, overrides);
}

/** Nine all-grass cells for a 3x3 grid. */
function grassTiles(width: number, depth: number): TileState[] {
  const tiles: TileState[] = [];
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({ cell: { x, z }, terrain: 'grass' });
    }
  }
  return tiles;
}

/**
 * A valid phase-14 (protocol v8) WorldSnapshot: continuous world geometry
 * (`bounds`/`surfaces`/`colliders`), the separate gameplay grid
 * (`grid`/`tiles`), and dynamic `entities`. The Router relays this verbatim.
 */
const SURFACES: SurfaceState[] = [
  {
    surfaceId: parseSurfaceId('surface-ground'),
    kind: 'ground',
    center: { x: 1.5, y: 0, z: 1.5 },
    axisU: { x: 1.5, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: -1.5 },
    walkable: true,
  },
  {
    // A real but non-walkable patch: proves the explicit `walkable: false`
    // traversal metadata survives transport untouched.
    surfaceId: parseSurfaceId('surface-roof'),
    kind: 'ramp',
    center: { x: 1.5, y: 0.5, z: 1.5 },
    axisU: { x: 1.5, y: 0.75, z: 0 },
    axisV: { x: 0, y: 0, z: -1.5 },
    walkable: false,
  },
];

const COLLIDERS: ColliderState[] = [
  {
    colliderId: parseColliderId('collider-wall'),
    kind: 'wall',
    shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  },
];

const SNAPSHOT: WorldSnapshot = {
  worldId: TEST_WORLD_ID,
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 1, z: 3 } },
  grid: { origin: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, cellSize: 1 },
  tiles: grassTiles(3, 3),
  surfaces: SURFACES,
  colliders: COLLIDERS,
  entities: [
    {
      entityId: ENTITY_ID,
      actorId: ACTOR_ID,
      kind: 'character',
      transform: {
        position: { x: 1, y: 0, z: 1 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      visible: true,
    },
  ],
  controlledActorId: ACTOR_ID,
  serverTime: FIXED_TIME,
};

const COMMAND_BATCH: GameEventBatch = {
  events: [
    {
      type: 'transform.changed',
      entityId: ENTITY_ID,
      transform: {
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    },
  ],
  serverTime: FIXED_TIME,
};

const EMPTY_BATCH: GameEventBatch = { events: [], serverTime: FIXED_TIME };

/**
 * Fake Manager: Router tests must assert transport mapping, not game rules.
 * `getSnapshot` enforces the unknown-actor contract; `submitIntent`/`step` are
 * overridable per test.
 */
function createFakeWorld(overrides: Partial<WorldManager> = {}): WorldManager {
  const world: WorldManager = {
    getSnapshot: ({ actorId }) => {
      if (actorId !== ACTOR_ID) {
        throw new UnknownActorError(actorId);
      }
      return structuredClone(SNAPSHOT);
    },
    submitIntent: ({ actorId }) => {
      if (actorId !== ACTOR_ID) {
        throw new UnknownActorError(actorId);
      }
      return COMMAND_BATCH;
    },
    step: () => EMPTY_BATCH,
  };
  return Object.assign(world, overrides);
}

/** Controllable `WorldStreamPort` capturing subscriptions for assertions. */
interface StreamPortHarness {
  readonly port: WorldStreamPort;
  push(batch: GameEventBatch): void;
  subscriberCount(): number;
  unsubscribedCount(): number;
}

function createStreamPort(): StreamPortHarness {
  const listeners = new Set<(batch: GameEventBatch) => void>();
  let unsubscribed = 0;
  return {
    port: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) {
            unsubscribed += 1;
          }
        };
      },
    },
    push(batch) {
      for (const listener of listeners) {
        listener(batch);
      }
    },
    subscriberCount: () => listeners.size,
    unsubscribedCount: () => unsubscribed,
  };
}

const openServers: Server[] = [];

async function startServer(
  gameInfo: GameInfoManager = createFakeManager(),
  world: WorldManager = createFakeWorld(),
  resolveActorId: ResolveActorId = () => ACTOR_ID,
  worldStream: WorldStreamPort = createStreamPort().port,
): Promise<string> {
  const server = createServer(
    createRequestListener({ gameInfo, world, worldStream, resolveActorId }),
  );
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

const MOVE_INTENT = { type: 'actor.moveIntent', movement: { x: 0, z: 1 } } as const;

const MOVE_TO = { type: 'actor.moveTo', target: { x: 2, y: 0, z: 3 } } as const;

const INTERACT = { type: 'actor.interact', targetEntityId: parseEntityId('tree-1') } as const;

/** GET `WORLD_PATH` and return the validated snapshot. */
async function fetchWorld(baseUrl: string): Promise<WorldSnapshot> {
  const response = await fetch(`${baseUrl}${WORLD_PATH}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const parsed = parseGetWorldResponse(await response.json());
  return parsed.world;
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
  // Leak check for stack frames rather than a bare "at ": the 409 message is
  // player-facing prose (e.g. "That cannot be done.") and may legitimately
  // contain "at ", so match the actual `file.ts:line` / frame shape instead.
  expect(raw).not.toContain('.ts:');
  expect(raw).not.toMatch(/\n\s+at /);
  expect(raw).not.toContain('stack');

  const body = JSON.parse(raw) as ProtocolError;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body;
}

/** Incremental SSE reader: parses one `WorldStreamMessage` per `next()`. */
interface SseConnection {
  readonly response: Response;
  next(): Promise<WorldStreamMessage>;
  close(): Promise<void>;
}

async function openSse(url: string): Promise<SseConnection> {
  const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
  const body = response.body;
  if (body === null) {
    throw new Error('stream response has no body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    response,
    async next(): Promise<WorldStreamMessage> {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (data.length === 0) {
            // Heartbeat / comment frame; keep reading.
            continue;
          }
          return parseWorldStreamMessage(JSON.parse(data));
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new Error('stream ended before the next frame');
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
      createFakeWorld({
        submitIntent: () => {
          throw new Error(secret);
        },
      }),
    );

    try {
      const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

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

    expect(Object.keys(world).sort()).toEqual([
      'bounds',
      'colliders',
      'controlledActorId',
      'entities',
      'grid',
      'serverTime',
      'surfaces',
      'tiles',
      'worldId',
    ]);
    expect(world.worldId).toBe(TEST_WORLD_ID);
    expect(world.grid).toEqual({ origin: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, cellSize: 1 });
    expect(world.tiles).toHaveLength(9);
    // World geometry passes through verbatim: the Router neither adds, drops,
    // nor reinterprets `surfaces`/`colliders` (including `walkable: false`).
    expect(world.surfaces).toEqual(SURFACES);
    expect(world.colliders).toEqual(COLLIDERS);
    expect(world.serverTime).toBe(FIXED_TIME);
    expect(world.controlledActorId).toBe(ACTOR_ID);

    const controlled = world.entities.find((entity) => entity.actorId === ACTOR_ID);
    expect(controlled?.kind).toBe('character');
    expect(controlled?.transform.position).toEqual({ x: 1, y: 0, z: 1 });
  });

  it('relays the Manager batch for a moveIntent command verbatim', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const batch = parseGameEventBatch(await response.json());
    expect(batch).toEqual(COMMAND_BATCH);
  });

  it('forwards an actor.moveTo command to the manager verbatim and relays its batch', async () => {
    // No new route is needed for the phase-8 intents: the primitive command
    // route validates the union and forwards it, so the Manager receives the
    // exact typed command (target included) it declared.
    const submitIntent = vi.fn(() => COMMAND_BATCH);
    const baseUrl = await startServer(createFakeManager(), createFakeWorld({ submitIntent }));

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_TO));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(parseGameEventBatch(await response.json())).toEqual(COMMAND_BATCH);
    expect(submitIntent).toHaveBeenCalledTimes(1);
    expect(submitIntent).toHaveBeenCalledWith({ actorId: ACTOR_ID, command: MOVE_TO });
  });

  it('forwards an actor.interact command to the manager verbatim and relays its batch', async () => {
    const submitIntent = vi.fn(() => COMMAND_BATCH);
    const baseUrl = await startServer(createFakeManager(), createFakeWorld({ submitIntent }));

    const response = await postCommand(baseUrl, JSON.stringify(INTERACT));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(parseGameEventBatch(await response.json())).toEqual(COMMAND_BATCH);
    expect(submitIntent).toHaveBeenCalledTimes(1);
    expect(submitIntent).toHaveBeenCalledWith({ actorId: ACTOR_ID, command: INTERACT });
  });

  it.each([
    ['out-of-range', 'Too far away.'],
    ['not-interactable', 'Nothing to do with that.'],
  ])(
    'maps an InteractionRejectedError reason %s to 409 CONFLICT with the player-facing message %s',
    async (reason, message) => {
      const baseUrl = await startServer(
        createFakeManager(),
        createFakeWorld({
          submitIntent: () => {
            throw interactionRejection(reason);
          },
        }),
      );

      const response = await postCommand(baseUrl, JSON.stringify(INTERACT));

      // A valid request that is illegal against the current world state must be
      // distinguishable both from a malformed 400 and from "accepted, nothing
      // happened" (200 with empty events). The 409 message is displayed to the
      // player verbatim, so it is asserted exactly.
      const body = await expectProtocolError(response, 'CONFLICT', 409);
      expect(body.error.message).toBe(message);
    },
  );

  it('maps an unknown InteractionRejectedError reason to 409 CONFLICT with a generic message', async () => {
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld({
        submitIntent: () => {
          throw interactionRejection('mystery');
        },
      }),
    );

    const response = await postCommand(baseUrl, JSON.stringify(INTERACT));

    const body = await expectProtocolError(response, 'CONFLICT', 409);
    expect(body.error.message).toBe('That cannot be done.');
  });

  it('maps a manager UnknownEntityError to 404 NOT_FOUND naming the entity id', async () => {
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld({
        submitIntent: () => {
          throw new UnknownEntityError(parseEntityId('ghost'));
        },
      }),
    );

    const response = await postCommand(baseUrl, JSON.stringify(INTERACT));

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('ghost');
  });

  it.each([
    { command: 'actor.moveTo', presentation: { camera: { fov: 50 } } },
    { command: 'actor.moveTo', presentation: { ndc: { x: 0, y: 0 } } },
    { command: 'actor.moveTo', presentation: { screen: { x: 10, y: 20 } } },
    { command: 'actor.interact', presentation: { camera: { fov: 50 } } },
    { command: 'actor.interact', presentation: { ndc: { x: 0, y: 0 } } },
    { command: 'actor.interact', presentation: { screen: { x: 10, y: 20 } } },
  ])(
    'rejects a $command body carrying a $presentation presentation field with 400',
    async ({ command, presentation }) => {
      // Camera/ray/pointer data is client-only; the exact-key guards are what
      // keep it off the wire, so assert the 400 end to end.
      const baseUrl = await startServer();
      const base = command === 'actor.moveTo' ? MOVE_TO : INTERACT;

      const response = await postCommand(baseUrl, JSON.stringify({ ...base, ...presentation }));

      await expectProtocolError(response, 'BAD_REQUEST', 400);
    },
  );

  it('is collision-agnostic: relays a Manager refusal as 200 with empty events and no error body', async () => {
    // Collision is a Manager runtime rule; the Router must not decide it or
    // reinterpret a refusal. A `WorldManager` that always refuses must surface
    // as a successful command whose delta is simply empty, never a ProtocolError.
    const refusingWorld = createFakeWorld({ submitIntent: () => EMPTY_BATCH });
    const baseUrl = await startServer(createFakeManager(), refusingWorld);

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(body).not.toHaveProperty('error');
    expect(body).toEqual({ events: [], serverTime: FIXED_TIME });

    const parsed = parseGameEventBatch(body);
    expect(parsed.events).toEqual([]);
    expect(parsed.serverTime).toBe(FIXED_TIME);
  });

  it('returns 400 BAD_REQUEST for an unknown command type', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.dance', movement: { x: 0, z: 1 } }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST when the movement magnitude exceeds 1', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ type: 'actor.moveIntent', movement: { x: 1, z: 1 } }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 400 BAD_REQUEST for a missing movement field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(baseUrl, JSON.stringify({ type: 'actor.moveIntent' }));

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('returns 404 NOT_FOUND when the resolved actor is unknown to the manager', async () => {
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), () =>
      parseActorId('nobody'),
    );

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('nobody');
  });

  it('rejects a command body that tries to name the actor it acts as', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ ...MOVE_INTENT, actorId: 'actor-1' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('rejects a command body carrying the retired playerId field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ ...MOVE_INTENT, playerId: 'player-1' }),
    );

    await expectProtocolError(response, 'BAD_REQUEST', 400);
  });

  it('treats the resolver as authoritative over any request-shaped identity', async () => {
    // The manager only knows `actor-1`; the resolver yields a different actor,
    // so the command is rejected even though the body cannot name one at all.
    const resolver = vi.fn((): ReturnType<ResolveActorId> => parseActorId('ghost'));
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), resolver);

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

    const body = await expectProtocolError(response, 'NOT_FOUND', 404);
    expect(body.error.message).toContain('ghost');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('consults the resolver exactly once per command request', async () => {
    const resolver = vi.fn((): ReturnType<ResolveActorId> => ACTOR_ID);
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), resolver);

    const response = await postCommand(baseUrl, JSON.stringify(MOVE_INTENT));

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('consults the resolver exactly once per world request', async () => {
    const resolver = vi.fn((): ReturnType<ResolveActorId> => ACTOR_ID);
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), resolver);

    const response = await fetch(`${baseUrl}${WORLD_PATH}`);

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('maps a throwing resolver to an opaque 500 and leaks no reason', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'resolver-secret do not leak';
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), () => {
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
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), async () => {
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

  it('returns 400 BAD_REQUEST for an extra field', async () => {
    const baseUrl = await startServer();

    const response = await postCommand(
      baseUrl,
      JSON.stringify({ ...MOVE_INTENT, extra: true }),
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
      body: JSON.stringify(MOVE_INTENT),
    });

    await expectProtocolError(response, 'NOT_FOUND', 404);
  });

  it('serves GET STREAM_PATH with SSE headers and a leading snapshot frame', async () => {
    expect(STREAM_PATH).toBe('/api/stream');
    const baseUrl = await startServer();

    const sse = await openSse(`${baseUrl}${STREAM_PATH}`);

    expect(sse.response.status).toBe(200);
    expect(sse.response.headers.get('content-type')).toBe('text/event-stream');
    expect(sse.response.headers.get('cache-control')).toBe('no-cache');
    expect(sse.response.headers.get('connection')).toBe('keep-alive');

    const first = await sse.next();
    expect(first.type).toBe('snapshot');
    if (first.type !== 'snapshot') {
      throw new Error('expected a snapshot frame first');
    }
    expect(first.snapshot.worldId).toBe(TEST_WORLD_ID);
    expect(first.snapshot.controlledActorId).toBe(ACTOR_ID);
    // The leading stream frame is the same verbatim snapshot as `GET /api/world`.
    expect(first.snapshot.surfaces).toEqual(SURFACES);
    expect(first.snapshot.colliders).toEqual(COLLIDERS);

    await sse.close();
  });

  it('relays a batch pushed through the worldStream port as an events frame', async () => {
    const stream = createStreamPort();
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld(),
      () => ACTOR_ID,
      stream.port,
    );

    const sse = await openSse(`${baseUrl}${STREAM_PATH}`);
    const first = await sse.next();
    expect(first.type).toBe('snapshot');
    expect(stream.subscriberCount()).toBe(1);

    stream.push(COMMAND_BATCH);

    const message = await sse.next();
    expect(message.type).toBe('events');
    if (message.type !== 'events') {
      throw new Error('expected an events frame');
    }
    expect(message.batch).toEqual(COMMAND_BATCH);
    expect(parseWorldStreamMessage(message)).toEqual(message);

    await sse.close();
  });

  it('unsubscribes and ends the route when the client disconnects', async () => {
    const stream = createStreamPort();
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld(),
      () => ACTOR_ID,
      stream.port,
    );

    const sse = await openSse(`${baseUrl}${STREAM_PATH}`);
    await sse.next();
    expect(stream.subscriberCount()).toBe(1);

    await sse.close();

    await waitFor(() => stream.subscriberCount() === 0);
    expect(stream.unsubscribedCount()).toBe(1);
  });

  it('does not warn when an SSE client disconnects', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stream = createStreamPort();
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld(),
      () => ACTOR_ID,
      stream.port,
    );

    try {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}${STREAM_PATH}`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const body = response.body;
      if (body === null) {
        throw new Error('stream response has no body');
      }
      const reader = body.getReader();
      await reader.read();
      expect(stream.subscriberCount()).toBe(1);

      // Closing an event stream is the normal end of the stream, so aborting
      // the client must not be reported as an exceptional client failure.
      controller.abort();

      await waitFor(() => stream.subscriberCount() === 0);
      expect(stream.unsubscribedCount()).toBe(1);
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('still warns when an ordinary request aborts before it is answered', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolverInvoked = false;
    let releaseActor: (actorId: ActorId) => void = () => undefined;
    const pendingActor = new Promise<ActorId>((resolve) => {
      releaseActor = resolve;
    });
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), () => {
      resolverInvoked = true;
      return pendingActor;
    });

    try {
      const controller = new AbortController();
      const pendingResponse = fetch(`${baseUrl}${GAME_INFO_PATH}`, { signal: controller.signal }).catch(
        () => undefined,
      );
      await waitFor(() => resolverInvoked);

      // An ordinary JSON request abandoned before it is answered is a genuine
      // client failure and must keep its warning.
      controller.abort();

      await waitFor(() => consoleWarn.mock.calls.length > 0);
      expect(consoleWarn).toHaveBeenCalledWith('[router] client aborted the request');
      releaseActor(ACTOR_ID);
      await pendingResponse;
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('fails the stream opaquely when actor resolution rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'stream-resolver-secret do not leak';
    const baseUrl = await startServer(createFakeManager(), createFakeWorld(), async () => {
      throw new Error(secret);
    });

    try {
      const response = await fetch(`${baseUrl}${STREAM_PATH}`);

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const raw = await response.text();
      expect(raw).not.toContain(secret);
      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not expose a stream subscription when actor resolution rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = createStreamPort();
    const baseUrl = await startServer(
      createFakeManager(),
      createFakeWorld(),
      () => {
        throw new Error('no actor');
      },
      stream.port,
    );

    try {
      const response = await fetch(`${baseUrl}${STREAM_PATH}`);
      expect(response.status).toBe(500);
      expect(stream.subscriberCount()).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns 405 with Allow: GET for POST on the stream path', async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}${STREAM_PATH}`, { method: 'POST' });

    expect(response.headers.get('allow')).toBe('GET');
    await expectProtocolError(response, 'METHOD_NOT_ALLOWED', 405);
  });
});
