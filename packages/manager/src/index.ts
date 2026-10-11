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
  DEFAULT_WORLD_SIZE,
  UnknownPlayerError,
  createWorldManager,
} from './world-manager.ts';
export type { CreateWorldManagerDeps, WorldManager } from './world-manager.ts';
