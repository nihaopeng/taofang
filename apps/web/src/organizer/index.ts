/**
 * `organizer` — the client application/data layer.
 *
 * The public surface deliberately exposes only client-application concepts:
 * observable state, async intents, view models, and subscriptions. Transport
 * mechanics (`fetch`, `Response`, HTTP status, JSON parsing, Protocol parsing)
 * stay behind this boundary. The UI consumes this module and nothing below it.
 */

export type { ConnectionStatus, GameInfoViewModel } from './view-model';
export type { GameInfoState } from './game-info-store';

export {
  getGameInfoState,
  loadGameInfo,
  resetGameInfoState,
  subscribeGameInfo,
} from './game-info-store';

export { useGameInfo } from './use-game-info';

// World / actor / movement feature.
export type { ControlledActorViewModel, MoveDirection, WorldViewModel } from './world-view-model';
export type { WorldState, WorldStatus } from './world-store';

export {
  getWorldState,
  loadWorld,
  moveActor,
  resetWorldState,
  subscribeWorld,
} from './world-store';

export { useWorld } from './use-world';

// Test-only transport hooks. These keep each resource's fetch implementation
// injectable without leaking raw response/error objects into the UI contract.
export { setGameInfoFetch, resetGameInfoFetch } from './api-client';
export { setWorldFetch, resetWorldFetch } from './world-api-client';
export type { FetchLike } from './api-client';
