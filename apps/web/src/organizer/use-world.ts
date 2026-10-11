/**
 * React binding for the world store.
 *
 * SSR-safe: `useSyncExternalStore` is given the same module-level snapshot for
 * both the client and the server so server rendering does not crash or drift.
 */

import { useSyncExternalStore } from 'react';

import { getWorldState, subscribeWorld } from './world-store';
import type { WorldState } from './world-store';

/** Subscribe a component to the current world/controlled-actor state. */
export function useWorld(): WorldState {
  return useSyncExternalStore(subscribeWorld, getWorldState, getWorldState);
}
