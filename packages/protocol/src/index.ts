/**
 * `@starvalley/protocol` — canonical client/server contract.
 *
 * Framework-neutral and dependency-free. Everything crossing a process boundary
 * between client and server is defined here; transport mapping (HTTP status
 * codes, headers, sockets) lives in Router.
 *
 * The contract is primitive-driven: a feature is expressed by composing
 * commands, events, and value objects rather than by adding a bespoke endpoint
 * pair. Commands and events are discriminated unions on `type`; there is no
 * `action: string` + `args: unknown` catch-all.
 */

export {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  WORLD_PATH,
} from './constants.ts';

export { isMoveDirection, parseMoveDirection } from './direction.ts';
export type { MoveDirection } from './direction.ts';

export {
  isEntityKind,
  isEntityState,
  isTransform,
  parseEntityKind,
  parseEntityState,
  parseTransform,
} from './entity.ts';
export type { EntityKind, EntityState, Transform } from './entity.ts';

export { ProtocolParseError, toProtocolError } from './errors.ts';
export type { ProtocolError, ProtocolErrorCode } from './errors.ts';

export {
  isEntityRemovedEvent,
  isEntitySpawnedEvent,
  isGameEvent,
  isTransformChangedEvent,
  parseEntityRemovedEvent,
  parseEntitySpawnedEvent,
  parseGameEvent,
  parseTransformChangedEvent,
} from './event.ts';
export type {
  EntityRemovedEvent,
  EntitySpawnedEvent,
  GameEvent,
  TransformChangedEvent,
} from './event.ts';

export {
  isActorMoveCommand,
  isGameCommand,
  isSubmitCommandResponse,
  parseActorMoveCommand,
  parseGameCommand,
  parseSubmitCommandResponse,
} from './command.ts';
export type { ActorMoveCommand, GameCommand, SubmitCommandResponse } from './command.ts';

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
  isGetWorldResponse,
  isWorldSize,
  isWorldSnapshot,
  parseGetWorldResponse,
  parseWorldSize,
  parseWorldSnapshot,
} from './world.ts';
export type { GetWorldResponse, WorldSize, WorldSnapshot } from './world.ts';
