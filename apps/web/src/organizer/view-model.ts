/**
 * UI-facing view model for game info.
 *
 * Deliberately narrower than the Protocol `GameInfo`: the UI never sees wire
 * fields it does not render (e.g. `protocolVersion`, `serverTime`), and it never
 * depends on Protocol types.
 */

import type { GameInfo } from '@starvalley/protocol';

/** Connection lifecycle as observed by the UI. */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Stable, presentation-ready representation of a successful game-info sync. */
export interface GameInfoViewModel {
  gameName: string;
  serverVersion: string;
  connectionStatus: 'connected';
  /** Client-side time the data was received, ISO-8601 UTC. */
  lastSyncedAt: string;
}

/**
 * Map a validated Protocol `GameInfo` into the UI view model.
 *
 * `lastSyncedAt` is stamped from the client clock (the moment the Organizer
 * accepted the server payload), not from `serverTime`. `syncedAt` is injectable
 * for deterministic tests.
 */
export function toGameInfoViewModel(
  gameInfo: GameInfo,
  syncedAt: Date = new Date(),
): GameInfoViewModel {
  return {
    gameName: gameInfo.gameName,
    serverVersion: gameInfo.serverVersion,
    connectionStatus: 'connected',
    lastSyncedAt: syncedAt.toISOString(),
  };
}
