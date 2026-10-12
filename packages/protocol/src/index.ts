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
 *
 * Phase 7 models a real continuous 3D world. The gameplay grid is a separate
 * interaction layer (`GridSpec`/`CellCoord`/`TileState`); it is never the
 * Actor's motion coordinate system. `Vec3`/`Quat` are re-exported here so
 * consumers keep a single import site.
 */

export {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  STREAM_PATH,
  WORLD_PATH,
} from './constants.ts';

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
  isGameCommand,
  isGameEventBatch,
  isInteractCommand,
  isMoveIntentCommand,
  isMoveToCommand,
  parseGameCommand,
  parseGameEventBatch,
  parseInteractCommand,
  parseMoveIntentCommand,
  parseMoveToCommand,
} from './command.ts';
export type {
  GameCommand,
  GameEventBatch,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
} from './command.ts';

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
  isWorldId,
  parseActorId,
  parseEntityId,
  parsePlayerId,
  parseWorldId,
} from './identity.ts';
export type { ActorId, EntityId, PlayerId, WorldId } from './identity.ts';

export { isQuat, isVec3, parseQuat, parseVec3 } from './math.ts';
export type { Quat, Vec3 } from './math.ts';

export { isWorldStreamMessage, parseWorldStreamMessage } from './stream.ts';
export type { WorldStreamMessage } from './stream.ts';

export {
  isCellCoord,
  isGetWorldResponse,
  isGridSpec,
  isTerrainKind,
  isTileState,
  isWorldBounds,
  isWorldSnapshot,
  parseCellCoord,
  parseGetWorldResponse,
  parseGridSpec,
  parseTerrainKind,
  parseTileState,
  parseWorldBounds,
  parseWorldSnapshot,
} from './world.ts';
export type {
  CellCoord,
  GetWorldResponse,
  GridSpec,
  TerrainKind,
  TileState,
  WorldBounds,
  WorldSnapshot,
} from './world.ts';
