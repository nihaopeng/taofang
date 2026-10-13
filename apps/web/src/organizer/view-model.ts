/**
 * UI-facing view model for game info.
 *
 * Deliberately narrower than the Protocol `GameInfo`: the UI never sees wire
 * fields it does not render (e.g. `protocolVersion`, `serverTime`), and it never
 * depends on Protocol types.
 *
 * Phase 15 `GameInfo` also carries the static, presentation-only `blockKinds` /
 * `entityKinds` catalogues. They are mapped here into plain view models so the UI
 * can draw a placement ghost from declarative geometry alone, without importing
 * the Protocol. The catalogues are geometry only: no appearance, no collision and
 * no legality rule enters this layer.
 */

import type { BlockKindInfo, EntityKindInfo, GameInfo } from '@starvalley/protocol';

import type {
  BlockKindInfoViewModel,
  EntityKindInfoViewModel,
} from './world-view-model';
import {
  toBlockKindInfoViewModels,
  toEntityKindInfoViewModels,
} from './world-view-model';

/** Connection lifecycle as observed by the UI. */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Stable, presentation-ready representation of a successful game-info sync. */
export interface GameInfoViewModel {
  gameName: string;
  serverVersion: string;
  connectionStatus: 'connected';
  /** Client-side time the data was received, ISO-8601 UTC. */
  lastSyncedAt: string;
  /**
   * Declarative block/entity geometry catalogues for placement previews,
   * normalised to plain view models and ordered by `kind`. Empty when the server
   * authored none; never `null` so consumers never special-case it.
   */
  blockKinds: readonly BlockKindInfoViewModel[];
  entityKinds: readonly EntityKindInfoViewModel[];
}

/**
 * Map a validated Protocol game-info payload into the UI view model.
 *
 * `lastSyncedAt` is stamped from the client clock (the moment the Organizer
 * accepted the server payload), not from `serverTime`. `syncedAt` is injectable
 * for deterministic tests. The catalogues are mapped from the same validated
 * payload and sorted by `kind` so each array is a stable function of the server
 * state.
 */
export function toGameInfoViewModel(
  gameInfo: GameInfo,
  blockKinds: readonly BlockKindInfo[],
  entityKinds: readonly EntityKindInfo[],
  syncedAt: Date = new Date(),
): GameInfoViewModel {
  return {
    gameName: gameInfo.gameName,
    serverVersion: gameInfo.serverVersion,
    connectionStatus: 'connected',
    lastSyncedAt: syncedAt.toISOString(),
    blockKinds: toBlockKindInfoViewModels(blockKinds),
    entityKinds: toEntityKindInfoViewModels(entityKinds),
  };
}
