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
  BLOCKING_BY_ENTITY_KIND,
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  DEFAULT_WORLD_MAP,
  INTERACTABLE_BY_ENTITY_KIND,
  INTERACTION_RANGE,
  InteractionRejectedError,
  TICK_RATE_HZ,
  UnknownActorError,
  UnknownEntityError,
  WALKABILITY_BY_TERRAIN,
  cellCentre,
  cellOf,
  createWorldManager,
  distanceXZ,
} from './world-manager.ts';
export type {
  CreateWorldManagerDeps,
  InteractionRejectionReason,
  WorldManager,
} from './world-manager.ts';
