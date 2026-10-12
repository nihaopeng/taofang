/**
 * `organizer` — the client application/data layer.
 *
 * The public surface deliberately exposes only client-application concepts:
 * observable state, async intents, view models, and subscriptions. Transport
 * mechanics (`fetch`, `EventSource`, `Response`, HTTP status, JSON parsing,
 * Protocol parsing, retry timers) stay behind this boundary. The UI consumes this
 * module and nothing below it.
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

// World / tile / entity / movement-intent / realtime-stream feature.
export type {
  BoundsViewModel,
  EntityViewModel,
  GridViewModel,
  TileViewModel,
  Vec3ViewModel,
} from './world-view-model';
export type { StreamStatus, WorldState, WorldStatus } from './world-store';

export {
  getWorldState,
  loadWorld,
  resetWorldState,
  setMovementIntent,
  subscribeWorld,
} from './world-store';

export { useWorld } from './use-world';

// Test-only transport hooks. These keep each resource's fetch and stream factory
// injectable without leaking raw response/error objects into the UI contract.
export { setGameInfoFetch, resetGameInfoFetch } from './api-client';
export { setWorldFetch, resetWorldFetch } from './world-api-client';
export { setWorldEventSource, resetWorldEventSource } from './world-stream';
export type { EventSourceFactory, EventSourceLike } from './world-stream';
export type { FetchLike } from './api-client';
