/**
 * Client-side store for the world/player feature.
 *
 * Owns the world request lifecycle (`idle -> loading -> ready | error`), the
 * movement command pipeline, subscriptions, and the mapping from internal
 * transport failures to user-presentable strings. It is intentionally a *second*
 * module singleton, separate from `game-info-store`, so the two resources never
 * share state or in-flight bookkeeping.
 *
 * Authoritative server state only. There is no prediction or interpolation: the
 * visible position changes *only* when a validated server response is reconciled
 * into the view model.
 */

import type { MovePlayerCommand, MovePlayerResult } from '@starvalley/protocol';

import { ApiError, describeApiError } from './transport';
import { fetchWorld, requestMovePlayer } from './world-api-client';
import { toPlayerViewModel, toWorldViewModel } from './world-view-model';
import type { MoveDirection, PlayerViewModel, WorldViewModel } from './world-view-model';

/** World request lifecycle as observed by the UI. */
export type WorldStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Observable state. `world`/`player` are populated once a snapshot is `ready`. */
export interface WorldState {
  status: WorldStatus;
  world: WorldViewModel | null;
  player: PlayerViewModel | null;
  /** User-presentable message; never a raw error/response object. */
  error: string | null;
}

type Listener = (state: WorldState) => void;

/** Canonical initial state. Reused so `getWorldState` is reference-stable. */
const IDLE_STATE: WorldState = { status: 'idle', world: null, player: null, error: null };

let state: WorldState = IDLE_STATE;
/**
 * Bumped on reset so a response that settles afterwards cannot clobber newer
 * state. Read-only during normal operation.
 */
let generation = 0;
let inFlightLoad: Promise<void> | null = null;
const listeners = new Set<Listener>();

/**
 * Movement serialization.
 *
 * Exactly one move request may be in flight at a time (`activeMoveToken`). While
 * one is in flight, `movePlayer` records only the *latest* requested direction
 * (`queuedDirection`) and returns a promise that settles once that direction has
 * been dispatched. This bounds held-key input to one request per settle and keeps
 * ordering deterministic.
 */
interface MoveLoopToken {
  readonly active: true;
}

let activeMoveToken: MoveLoopToken | null = null;
let queuedDirection: MoveDirection | null = null;
let queuedWaiters: Array<() => void> = [];

/**
 * Current state. Returns the same object reference until an actual transition
 * occurs, which is required for `useSyncExternalStore` to avoid render loops.
 */
export function getWorldState(): WorldState {
  return state;
}

/**
 * Subscribe to state transitions. Notifications are synchronous and delivered
 * only on transitions. Returns an unsubscribe function.
 */
export function subscribeWorld(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Return to the initial `idle` state, discard any in-flight load result, and
 * drain any queued move requests (their promises resolve without further I/O).
 */
export function resetWorldState(): void {
  generation += 1;
  inFlightLoad = null;
  activeMoveToken = null;
  queuedDirection = null;
  const waiters = queuedWaiters;
  queuedWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
  setState(IDLE_STATE);
}

/**
 * Load the authoritative world snapshot. Never rejects: the returned promise
 * resolves once the state has settled (`ready` or `error`). Concurrent calls
 * while a request is in flight share the same promise and do not trigger a
 * second fetch.
 */
export function loadWorld(): Promise<void> {
  if (inFlightLoad !== null) {
    return inFlightLoad;
  }

  const requestGeneration = generation;
  const request = runLoad(requestGeneration).finally(() => {
    // Only the current request may clear the in-flight marker; a reset owns the
    // slot otherwise.
    if (requestGeneration === generation) {
      inFlightLoad = null;
    }
  });
  inFlightLoad = request;
  return request;
}

async function runLoad(requestGeneration: number): Promise<void> {
  setState({ status: 'loading', world: null, player: null, error: null });

  try {
    const snapshot = await fetchWorld();
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'ready',
      world: toWorldViewModel(snapshot),
      player: toPlayerViewModel(snapshot.player),
      error: null,
    });
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'error',
      world: null,
      player: null,
      error: describeApiError(error, 'Something went wrong while loading the world.'),
    });
  }
}

/**
 * UI intent: move the local player one tile.
 *
 * `direction` is the intent; the store owns the wire command and fills in the
 * `playerId` from the loaded snapshot. Semantics:
 *
 * - **No world loaded yet:** safe no-op that resolves without sending anything
 *   (there is no authoritative `playerId` to put in the command).
 * - **A move already in flight:** no second concurrent request; the latest
 *   direction is queued and dispatched when the current request settles.
 * - **Never rejects:** failures settle the store into `error` and resolve.
 */
export function movePlayer(direction: MoveDirection): Promise<void> {
  if (state.player === null) {
    // No authoritative snapshot yet; moving would require inventing a playerId.
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    if (activeMoveToken !== null) {
      queuedDirection = direction;
      queuedWaiters.push(resolve);
      return;
    }

    const token: MoveLoopToken = { active: true };
    activeMoveToken = token;
    void runMoveLoop(direction, [resolve], token);
  });
}

async function runMoveLoop(
  initialDirection: MoveDirection,
  initialWaiters: Array<() => void>,
  token: MoveLoopToken,
): Promise<void> {
  const loopGeneration = generation;
  let currentDirection = initialDirection;
  let currentWaiters: Array<() => void> = initialWaiters;

  try {
    // Dispatch `currentDirection`, then adopt the latest queued direction (if
    // any) as the next request. Waiters attached to a direction resolve once
    // that direction's request has settled.
    for (;;) {
      await performMove(currentDirection, loopGeneration);

      const nextDirection = queuedDirection;
      const nextWaiters = queuedWaiters;
      queuedDirection = null;
      queuedWaiters = [];

      for (const resolve of currentWaiters) {
        resolve();
      }
      currentWaiters = [];

      if (loopGeneration !== generation || nextDirection === null) {
        break;
      }
      currentDirection = nextDirection;
      currentWaiters = nextWaiters;
    }
  } finally {
    // Drain anything queued after the last dispatch (e.g. after a reset) so no
    // caller is left waiting.
    for (const resolve of queuedWaiters) {
      resolve();
    }
    queuedWaiters = [];
    queuedDirection = null;
    if (activeMoveToken === token) {
      activeMoveToken = null;
    }
  }
}

async function performMove(direction: MoveDirection, loopGeneration: number): Promise<void> {
  const player = state.player;
  if (player === null) {
    return;
  }

  const command: MovePlayerCommand = { playerId: player.id, direction };

  try {
    const result = await requestMovePlayer(command);
    if (loopGeneration !== generation) {
      return;
    }
    // A concurrent `loadWorld`/`resetWorldState` invalidates this result.
    if (state.player === null) {
      return;
    }
    applyMoveResult(result);
  } catch (error) {
    if (loopGeneration !== generation) {
      return;
    }
    // Preserve the last authoritative world/player so the map stays visible;
    // only the status/error signal the failure.
    setState({
      status: 'error',
      world: state.world,
      player: state.player,
      error: toMoveErrorMessage(error),
    });
  }
}

/**
 * Map a movement failure to a user-presentable message. An unknown player
 * (404) is the one transport status with a specific, actionable meaning here.
 */
function toMoveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'status' && error.status === 404) {
    return 'That player could not be found.';
  }
  return describeApiError(error, 'Something went wrong while moving.');
}

/**
 * Reconcile a server move result into state. `result.player.position` is
 * authoritative; for a refused step (`moved: false`) it is unchanged, so the
 * visible position does not move and no error is raised.
 */
function applyMoveResult(result: MovePlayerResult): void {
  setState({
    status: 'ready',
    world: state.world,
    player: toPlayerViewModel(result.player),
    error: null,
  });
}

function setState(next: WorldState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}
