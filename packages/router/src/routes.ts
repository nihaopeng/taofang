import { GAME_INFO_PATH, HEALTH_PATH } from '@starvalley/protocol';
import type { GetGameInfoResponse, HealthStatus } from '@starvalley/protocol';
import type { GameInfoManager } from '@starvalley/manager';

/**
 * Everything a route handler may read from the inbound request.
 *
 * Handlers receive typed inputs only: the Manager they may call and the parsed
 * URL. Raw `IncomingMessage`/`ServerResponse` objects stay in the listener so
 * framework details never leak past the Router boundary.
 */
export interface RouteContext {
  readonly gameInfo: GameInfoManager;
  readonly url: URL;
}

/** A serialized, Protocol-compliant success payload. */
export interface RouteResponse {
  readonly status: number;
  readonly body: GetGameInfoResponse | HealthStatus;
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
];

export function isKnownPath(path: string): boolean {
  return ROUTES.some((route) => route.path === path);
}

export function findRoute(path: string, method: string): RouteDefinition | undefined {
  return ROUTES.find((route) => route.path === path && route.method === method);
}

/** Methods registered for a known path, in declaration order, deduplicated. */
export function allowedMethods(path: string): string[] {
  return [...new Set(ROUTES.filter((route) => route.path === path).map((route) => route.method))];
}
