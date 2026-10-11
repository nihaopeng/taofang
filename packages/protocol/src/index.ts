/**
 * `@starvalley/protocol` — canonical client/server contract.
 *
 * Framework-neutral and dependency-free. Everything crossing a process boundary
 * between client and server is defined here; transport mapping (HTTP status
 * codes, headers, sockets) lives in Router.
 */

export { GAME_INFO_PATH, HEALTH_PATH, PLAYER_MOVE_PATH, PROTOCOL_VERSION, WORLD_PATH } from './constants.ts';

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

export {
  isMoveDirection,
  isMovePlayerCommand,
  isMovePlayerResponse,
  isMovePlayerResult,
  parseMoveDirection,
  parseMovePlayerCommand,
  parseMovePlayerResponse,
  parseMovePlayerResult,
} from './movement.ts';
export type {
  MoveDirection,
  MovePlayerCommand,
  MovePlayerResponse,
  MovePlayerResult,
} from './movement.ts';

export {
  isGetWorldResponse,
  isPlayer,
  isPosition,
  isWorldSize,
  isWorldSnapshot,
  parseGetWorldResponse,
  parsePlayer,
  parsePosition,
  parseWorldSize,
  parseWorldSnapshot,
} from './world.ts';
export type {
  GetWorldResponse,
  Player,
  PlayerId,
  Position,
  WorldSize,
  WorldSnapshot,
} from './world.ts';
