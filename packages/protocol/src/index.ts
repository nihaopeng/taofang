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
 * Phase 15 models a block-spatial kernel: the world converges on a Minecraft-
 * style **spatial** model (borrowing the spatial/collision idea only, never
 * Minecraft content, code or art). Two orthogonal systems share one real 3D
 * coordinate system (`+X` East, `+Y` Up, `+Z` South): the discrete Block World
 * (integer `CellCoord` grids, chunks, topology) and the continuous Entity World
 * (`Vec3` + `Quat` transforms, entities, placement). `Vec3`/`Quat` are
 * re-exported here so consumers keep a single import site.
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
  isBlockKind,
  isBlockOrientation,
  isBlockState,
  isYawStep,
  parseBlockKind,
  parseBlockOrientation,
  parseBlockState,
  parseYawStep,
} from './block.ts';
export type { BlockKind, BlockOrientation, BlockState, YawStep } from './block.ts';

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
  isBlockChangedEvent,
  isEntityRemovedEvent,
  isEntitySpawnedEvent,
  isGameEvent,
  isTransformChangedEvent,
  parseBlockChangedEvent,
  parseEntityRemovedEvent,
  parseEntitySpawnedEvent,
  parseGameEvent,
  parseTransformChangedEvent,
} from './event.ts';
export type {
  BlockChangedEvent,
  EntityRemovedEvent,
  EntitySpawnedEvent,
  GameEvent,
  TransformChangedEvent,
} from './event.ts';

export {
  isActorJumpCommand,
  isBlockRemoveCommand,
  isBlockSetCommand,
  isCommandResponse,
  isEntityPlaceCommand,
  isEntityRemoveCommand,
  isEntityRotateCommand,
  isEntityValidatePlacementCommand,
  isGameCommand,
  isGameEventBatch,
  isInteractCommand,
  isMoveIntentCommand,
  isMoveToCommand,
  isValidatePlacementResponse,
  parseActorJumpCommand,
  parseBlockRemoveCommand,
  parseBlockSetCommand,
  parseCommandResponse,
  parseEntityPlaceCommand,
  parseEntityRemoveCommand,
  parseEntityRotateCommand,
  parseEntityValidatePlacementCommand,
  parseGameCommand,
  parseGameEventBatch,
  parseInteractCommand,
  parseMoveIntentCommand,
  parseMoveToCommand,
  parseValidatePlacementResponse,
} from './command.ts';
export type {
  ActorJumpCommand,
  BlockRemoveCommand,
  BlockSetCommand,
  CommandResponse,
  EntityPlaceCommand,
  EntityRemoveCommand,
  EntityRotateCommand,
  EntityValidatePlacementCommand,
  GameCommand,
  GameEventBatch,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  ValidatePlacementResponse,
} from './command.ts';

export {
  isBlockKindInfo,
  isEntityKindInfo,
  isGameInfo,
  isGetGameInfoResponse,
  parseBlockKindInfo,
  parseEntityKindInfo,
  parseGameInfo,
  parseGetGameInfoResponse,
} from './game-info.ts';
export type {
  BlockKindInfo,
  EntityKindInfo,
  GameInfo,
  GetGameInfoResponse,
} from './game-info.ts';

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

export {
  CHUNK_SIZE,
  cellCentre,
  cellOf,
  cellToChunk,
  cellToLocal,
  chunkLocalToCell,
  chunkOriginCell,
  isBlockGrid,
  isCellCoord,
  isChunkCoord,
  isFootprintExtents,
  parseBlockGrid,
  parseCellCoord,
  parseChunkCoord,
  parseFootprintExtents,
  snapFootprintCentre,
} from './grid.ts';
export type { BlockGrid, CellCoord, ChunkCoord, FootprintExtents } from './grid.ts';

export { isQuat, isVec3, parseQuat, parseVec3 } from './math.ts';
export type { Quat, Vec3 } from './math.ts';

export { isWorldStreamMessage, parseWorldStreamMessage } from './stream.ts';
export type { WorldStreamMessage } from './stream.ts';

export {
  isGetWorldResponse,
  isWorldBounds,
  isWorldSnapshot,
  parseGetWorldResponse,
  parseWorldBounds,
  parseWorldSnapshot,
} from './world.ts';
export type { GetWorldResponse, WorldBounds, WorldSnapshot } from './world.ts';
