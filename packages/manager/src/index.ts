/**
 * `@starvalley/manager` — authoritative backend execution.
 *
 * Framework-neutral and transport-agnostic: everything here is a pure,
 * synchronous, typed operation that Router can invoke. No HTTP/WebSocket
 * objects, no persistence, no client concerns.
 */

export { SERVER_VERSION, createGameInfoManager } from './game-info-manager.ts';
export type { CreateGameInfoManagerDeps, GameInfoManager } from './game-info-manager.ts';

export {
  BLOCKED_COLLIDER_HEIGHT,
  BLOCKING_BY_ENTITY_KIND,
  DEFAULT_ACTOR_HEIGHT,
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  DEFAULT_WORLD_MAP,
  DEMO_PLATFORM_HEIGHT,
  DEMO_RAMP_ANGLE_DEGREES,
  GRAVITY,
  INTERACTABLE_BY_ENTITY_KIND,
  INTERACTION_RANGE,
  InteractionRejectedError,
  LANDING_SNAP_TOLERANCE,
  MAX_STEP_DOWN,
  MAX_STEP_UP,
  MAX_WALKABLE_SLOPE_DEGREES,
  TICK_RATE_HZ,
  TREE_TRUNK_HEIGHT,
  UnknownActorError,
  UnknownEntityError,
  WALKABILITY_BY_TERRAIN,
  WATER_COLLIDER_HEIGHT,
  actorBodyOverlapsCollider,
  cellCentre,
  cellOf,
  createWorldManager,
  distanceXZ,
  findSupportY,
  isSurfaceTraversable,
  resolveColliderPenetration,
  surfacePlaneY,
} from './world-manager.ts';
export type {
  CreateWorldManagerDeps,
  InteractionRejectionReason,
  PenetrationResolutionInput,
  WorldManager,
} from './world-manager.ts';
