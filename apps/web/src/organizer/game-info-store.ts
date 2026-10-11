/**
 * Client-side store for game info.
 *
 * Owns the request lifecycle (`idle -> connecting -> connected | error`),
 * request deduplication, subscriptions, and the mapping from internal transport
 * failures to user-presentable error strings. Server state is authoritative: the
 * store has no optimistic/predicted game-info state and simply reconciles the
 * cached view model against each successful response.
 */

import { fetchGameInfo } from './api-client';
import { describeApiError } from './transport';
import { toGameInfoViewModel } from './view-model';
import type { ConnectionStatus, GameInfoViewModel } from './view-model';

/** Observable state. `data` is null unless `status === 'connected'`. */
export interface GameInfoState {
  status: ConnectionStatus;
  data: GameInfoViewModel | null;
  /** User-presentable message; never a raw error/response object. */
  error: string | null;
}

type Listener = (state: GameInfoState) => void;

/** Canonical initial state. Reused so `getGameInfoState` is reference-stable. */
const IDLE_STATE: GameInfoState = { status: 'idle', data: null, error: null };

let state: GameInfoState = IDLE_STATE;
let inFlight: Promise<void> | null = null;
/**
 * Bumped on reset/new request so a response that settles after a reset cannot
 * clobber newer state.
 */
let generation = 0;
const listeners = new Set<Listener>();

/**
 * Current state. Returns the same object reference until an actual transition
 * occurs, which is required for `useSyncExternalStore` to avoid render loops.
 */
export function getGameInfoState(): GameInfoState {
  return state;
}

/**
 * Subscribe to state transitions. Notifications are synchronous and delivered
 * only on transitions. Returns an unsubscribe function.
 */
export function subscribeGameInfo(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Return to the initial `idle` state and discard any in-flight request result. */
export function resetGameInfoState(): void {
  generation += 1;
  inFlight = null;
  setState(IDLE_STATE);
}

/**
 * Load game info. Never rejects: the returned promise resolves once the state
 * has settled (`connected` or `error`). Concurrent calls while a request is in
 * flight share the same promise and do not trigger a second fetch.
 */
export function loadGameInfo(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }

  const requestGeneration = generation;
  const request = runLoad(requestGeneration).finally(() => {
    // Only the current request may clear the in-flight marker; a reset or a new
    // request owns the slot otherwise.
    if (requestGeneration === generation) {
      inFlight = null;
    }
  });
  inFlight = request;
  return request;
}

async function runLoad(requestGeneration: number): Promise<void> {
  setState({ status: 'connecting', data: null, error: null });

  try {
    const gameInfo = await fetchGameInfo();
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'connected',
      data: toGameInfoViewModel(gameInfo),
      error: null,
    });
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    setState({ status: 'error', data: null, error: toUserMessage(error) });
  }
}

function setState(next: GameInfoState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}

/** Map an internal transport failure to a short, user-presentable message. */
function toUserMessage(error: unknown): string {
  return describeApiError(error, 'Something went wrong while loading game info.');
}
