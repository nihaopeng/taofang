/**
 * React binding for the game-info store.
 *
 * SSR-safe: `useSyncExternalStore` is given the same module-level snapshot for
 * both client and server so server rendering does not crash or drift.
 */

import { useSyncExternalStore } from 'react';

import { getGameInfoState, subscribeGameInfo } from './game-info-store';
import type { GameInfoState } from './game-info-store';

/** Subscribe a component to the current game-info state. */
export function useGameInfo(): GameInfoState {
  return useSyncExternalStore(subscribeGameInfo, getGameInfoState, getGameInfoState);
}
