/**
 * `@starvalley/protocol` — canonical client/server contract.
 *
 * Framework-neutral and dependency-free. Everything crossing a process boundary
 * between client and server is defined here; transport mapping (HTTP status
 * codes, headers, sockets) lives in Router.
 */

export { GAME_INFO_PATH, HEALTH_PATH, MOVE_ACTOR_PATH, PROTOCOL_VERSION, WORLD_PATH } from './constants.ts';

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
  isActorId,
  isEntityId,
  isPlayerId,
  parseActorId,
  parseEntityId,
  parsePlayerId,
} from './identity.ts';
export type { ActorId, EntityId, PlayerId } from './identity.ts';

export {
  isMoveActorCommand,
  isMoveActorResponse,
  isMoveActorResult,
  isMoveDirection,
  parseMoveActorCommand,
  parseMoveActorResponse,
  parseMoveActorResult,
  parseMoveDirection,
} from './movement.ts';
export type {
  MoveActorCommand,
  MoveActorResponse,
  MoveActorResult,
  MoveDirection,
} from './movement.ts';

export {
  isActor,
  isGetWorldResponse,
  isPosition,
  isWorldSize,
  isWorldSnapshot,
  parseActor,
  parseGetWorldResponse,
  parsePosition,
  parseWorldSize,
  parseWorldSnapshot,
} from './world.ts';
export type {
  Actor,
  GetWorldResponse,
  Position,
  WorldSize,
  WorldSnapshot,
} from './world.ts';
