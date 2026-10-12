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
  DEFAULT_WORLD_MAP,
  UnknownActorError,
  WALKABILITY_BY_TERRAIN,
  createWorldManager,
} from './world-manager.ts';
export type {
  CreateWorldManagerDeps,
  SubmitCommandResult,
  WorldManager,
} from './world-manager.ts';
