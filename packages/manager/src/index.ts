/**
 * `@starvalley/manager` — authoritative backend execution.
 *
 * Framework-neutral and transport-agnostic: everything here is a pure,
 * synchronous, typed operation that Router can invoke. No HTTP/WebSocket
 * objects, no persistence, no client concerns.
 *
 * Phase 15 models the world as a block-spatial kernel: a sparse block store +
 * server-only collision-shape/entity registries, a Placement Resolver with a
 * derived occupancy index, and a unified shape-based movement solver.
 */

export {
  BLOCK_DEFINITIONS,
  blockCellAabb,
  blockDefinition,
  blockSolidTopOverRect,
  blocksAtHeight,
  cellKey,
  createBlockStore,
  hasBlockTag,
  isSolidBlockKind,
  solidIntervalAt,
  supportHeightAt,
} from './blocks.ts';
export type {
  BlockCollisionShape,
  BlockDefinition,
  BlockReadPort,
  BlockStore,
  BlockTag,
} from './blocks.ts';

export {
  DEFAULT_BLOCK_GRID,
  createDefaultBlocks,
  createDefaultEntities,
} from './default-world.ts';

export {
  DEFAULT_ACTOR_HEIGHT,
  DEFAULT_ACTOR_RADIUS,
  ENTITY_DEFINITIONS,
  TREE_TRUNK_HEIGHT,
  TREE_TRUNK_RADIUS,
  entityDefinition,
  isPlaceableKind,
} from './entities.ts';
export type { EntityCollider, EntityDefinition, EntityPlacementDefinition } from './entities.ts';

export {
  SERVER_VERSION,
  BLOCK_KIND_INFOS,
  ENTITY_KIND_INFOS,
  createGameInfoManager,
} from './game-info-manager.ts';
export type { CreateGameInfoManagerDeps, GameInfoManager } from './game-info-manager.ts';

export {
  GRAVITY,
  JUMP_SPEED,
  LANDING_SNAP_TOLERANCE,
  MAX_STEP_DOWN,
  actorCanOccupy,
  depenetrateActor,
  stepMovement,
  supportTopUnderActor,
} from './movement.ts';
export type { MovementCollider, MovementInput, MovementResult } from './movement.ts';

export {
  MAX_STEP_HEIGHT,
  OCCUPANCY_EPSILON,
  assertAuthoredPlaceable,
  cellsAreFree,
  checkPlacementInvariants,
  columnSupportTop,
  createOccupancyIndex,
  deriveOccupiedCells,
  extentsForYaw,
  footprintColumns,
  occupancyLayers,
  rebuildOccupancyFromEntities,
  resolvePlacement,
  snapYaw,
  yawStepFromRotation,
} from './placement.ts';
export type {
  AssertAuthoredPlaceableInput,
  CheckPlacementInvariantsInput,
  OccupancyIndex,
  PlacementInvariantViolation,
  PlacementRejected,
  PlacementRejectionReason,
  PlacementResolution,
  PlacementResolved,
  ResolvePlacementInput,
} from './placement.ts';

export {
  DEFAULT_ACTOR_SPEED,
  INTERACTABLE_BY_ENTITY_KIND,
  INTERACTION_RANGE,
  InteractionRejectedError,
  PlacementRejectedError,
  TICK_RATE_HZ,
  UnknownActorError,
  UnknownEntityError,
  createWorldManager,
  distanceXZ,
} from './world-manager.ts';
export type {
  CreateWorldManagerDeps,
  InteractionRejectionReason,
  WorldManager,
} from './world-manager.ts';
