/**
 * `@starvalley/protocol` — canonical client/server contract.
 *
 * Framework-neutral and dependency-free. Everything crossing a process boundary
 * between client and server is defined here; transport mapping (HTTP status
 * codes, headers, sockets) lives in Router.
 */

export { GAME_INFO_PATH, HEALTH_PATH, PROTOCOL_VERSION } from './constants.ts';

export { ProtocolParseError, toProtocolError } from './errors.ts';
export type { ProtocolError, ProtocolErrorCode } from './errors.ts';

export {
  isGameInfo,
  isGetGameInfoResponse,
  parseGameInfo,
  parseGetGameInfoResponse,
} from './game-info.ts';
export type { GameInfo, GetGameInfoResponse } from './game-info.ts';

export { isHealthStatus, parseHealthStatus } from './health.ts';
export type { HealthStatus } from './health.ts';
