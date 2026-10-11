import { PROTOCOL_VERSION } from '@starvalley/protocol';
import type { GameInfo, HealthStatus } from '@starvalley/protocol';

/**
 * Version of the authoritative server build, surfaced through `GameInfo` so
 * clients can display and reason about which server they are talking to.
 */
export const SERVER_VERSION = '0.1.0';

const DEFAULT_GAME_NAME = 'Starvalley';

/** Read-only, transport-neutral access to server identity and liveness. */
export interface GameInfoManager {
  /** Server identity plus a fresh protocol-compatible timestamp. */
  getGameInfo(): GameInfo;
  /**
   * Liveness payload. `now` defaults to the current clock time; injecting it
   * keeps uptime computation deterministic and testable.
   */
  getHealth(now?: Date): HealthStatus;
}

/** Construction-time dependencies for {@link createGameInfoManager}. */
export interface CreateGameInfoManagerDeps {
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Server start instant. Defaults to `clock()` evaluated once at creation. */
  startedAt?: Date;
  /** Display name for this server. Defaults to `'Starvalley'`. */
  gameName?: string;
  /** Server build version. Defaults to {@link SERVER_VERSION}. */
  serverVersion?: string;
}

/**
 * Create an authoritative `GameInfoManager`.
 *
 * Pure and synchronous: no I/O, no transport, no persistence. All state
 * (clock, start instant, identity strings) is captured at creation, and each
 * call returns a fresh Protocol-shaped DTO.
 */
export function createGameInfoManager(deps: CreateGameInfoManagerDeps = {}): GameInfoManager {
  const clock = deps.clock ?? ((): Date => new Date());
  const startedAt = deps.startedAt ?? clock();
  const gameName = deps.gameName ?? DEFAULT_GAME_NAME;
  const serverVersion = deps.serverVersion ?? SERVER_VERSION;

  return {
    getGameInfo(): GameInfo {
      return {
        gameName,
        serverVersion,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: clock().toISOString(),
      };
    },

    getHealth(now: Date = clock()): HealthStatus {
      const uptimeSeconds = Math.max(
        0,
        Math.floor((now.getTime() - startedAt.getTime()) / 1000),
      );
      return {
        status: 'ok',
        uptimeSeconds,
        serverTime: now.toISOString(),
      };
    },
  };
}
