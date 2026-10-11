import {
  GAME_INFO_PATH,
  HEALTH_PATH,
  MOVE_ACTOR_PATH,
  WORLD_PATH,
  parseMoveActorCommand,
} from '@starvalley/protocol';
import type {
  ActorId,
  GetGameInfoResponse,
  GetWorldResponse,
  HealthStatus,
  MoveActorResponse,
} from '@starvalley/protocol';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';

/**
 * Everything a route handler may read from the inbound request.
 *
 * Handlers receive typed inputs only: the Managers they may call, the parsed
 * URL, the parsed JSON body, and the caller identity already resolved by the
 * listener's single authorization seam. Raw `IncomingMessage`/`ServerResponse`
 * objects stay in the listener so framework details never leak past the Router
 * boundary.
 *
 * `body` is `undefined` when the request carries no body (for example GET).
 */
export interface RouteContext {
  readonly gameInfo: GameInfoManager;
  readonly world: WorldManager;
  readonly actorId: ActorId;
  readonly url: URL;
  readonly body: unknown;
}

/** A serialized, Protocol-compliant success payload. */
export interface RouteResponse {
  readonly status: number;
  readonly body:
    | GetGameInfoResponse
    | GetWorldResponse
    | HealthStatus
    | MoveActorResponse;
}

/** A declarative route entry: method + path + thin handler. */
export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  readonly handle: (context: RouteContext) => RouteResponse | Promise<RouteResponse>;
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: GAME_INFO_PATH,
    handle: ({ gameInfo }) => {
      const body: GetGameInfoResponse = { gameInfo: gameInfo.getGameInfo() };
      return { status: 200, body };
    },
  },
  {
    method: 'GET',
    path: HEALTH_PATH,
    handle: ({ gameInfo }) => {
      const body: HealthStatus = gameInfo.getHealth();
      return { status: 200, body };
    },
  },
  {
    method: 'GET',
    path: WORLD_PATH,
    handle: ({ world, actorId }) => {
      const body: GetWorldResponse = { world: world.getSnapshot({ actorId }) };
      return { status: 200, body };
    },
  },
  {
    method: 'POST',
    path: MOVE_ACTOR_PATH,
    handle: ({ world, actorId, body }) => {
      // Router validates shape and delegates the decision (including world-edge
      // refusal) to the Manager; it never reimplements movement rules. The
      // command carries no actor: `actorId` comes from the transport seam.
      const command = parseMoveActorCommand(body);
      const result = world.moveActor({ actorId, command });
      const responseBody: MoveActorResponse = { result };
      return { status: 200, body: responseBody };
    },
  },
];

export function isKnownPath(path: string): boolean {
  return ROUTES.some((route) => route.path === path);
}

/**
 * Resolve a route for the given path/method.
 *
 * HEAD is resolved to the GET handler when no explicit HEAD route exists:
 * RFC 9110 requires every GET resource to support HEAD. `node:http` then
 * suppresses the response body while preserving status, headers, and
 * Content-Length, so the same representation is advertised.
 */
export function findRoute(path: string, method: string): RouteDefinition | undefined {
  const route = ROUTES.find((candidate) => candidate.path === path && candidate.method === method);
  if (route !== undefined || method !== 'HEAD') {
    return route;
  }
  return ROUTES.find((candidate) => candidate.path === path && candidate.method === 'GET');
}

/**
 * Methods allowed for a known path, in declaration order, deduplicated.
 *
 * GET implies HEAD (RFC 9110), so HEAD is advertised wherever GET is allowed
 * even though only the GET handler is registered. POST does not imply HEAD.
 */
export function allowedMethods(path: string): string[] {
  const methods = ROUTES.filter((route) => route.path === path).map((route) => route.method);
  if (methods.includes('GET')) {
    methods.push('HEAD');
  }
  return [...new Set(methods)];
}
