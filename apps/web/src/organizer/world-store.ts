/**
 * Client-side store for the world/actor feature.
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
 *
 * After the Phase-3 identity migration the client controls an **Actor**, not a
 * player. `controlledActor` is the actor the client believes it controls; the
 * actor resolved by the server (from transport context) is authoritative and the
 * move command carries only a direction.
 */

import type { MoveActorCommand, MoveActorResult } from '@starvalley/protocol';

import { ApiError, describeApiError } from './transport';
import { fetchWorld, requestMoveActor } from './world-api-client';
import { toControlledActorViewModel, toWorldViewModel } from './world-view-model';
import type { ControlledActorViewModel, MoveDirection, WorldViewModel } from './world-view-model';

/** World request lifecycle as observed by the UI. */
export type WorldStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Observable state. `world`/`controlledActor` are populated once a snapshot is `ready`. */
export interface WorldState {
  status: WorldStatus;
  world: WorldViewModel | null;
  controlledActor: ControlledActorViewModel | null;
  /** User-presentable message; never a raw error/response object. */
  error: string | null;
}

type Listener = (state: WorldState) => void;

/** Canonical initial state. Reused so `getWorldState` is reference-stable. */
const IDLE_STATE: WorldState = {
  status: 'idle',
  world: null,
  controlledActor: null,
  error: null,
};

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
 * one is in flight, `moveActor` records only the *latest* requested direction
 * (`queuedDirection`) and returns a promise that settles once the in-flight
 * request that superseded it (or its own request) has settled. This bounds
 * held-key input to one request per settle and keeps ordering deterministic.
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
  setState({ status: 'loading', world: null, controlledActor: null, error: null });

  try {
    const snapshot = await fetchWorld();
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'ready',
      world: toWorldViewModel(snapshot),
      controlledActor: toControlledActorViewModel(snapshot.actor),
      error: null,
    });
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'error',
      world: null,
      controlledActor: null,
      error: describeApiError(error, 'Something went wrong while loading the world.'),
    });
  }
}

/**
 * UI intent: move the controlled actor one tile in `direction`.
 *
 * The store owns the wire command: the command is built from the direction
 * alone. The server resolves *which* actor the caller controls from transport
 * context, so no actor/player id is ever sent (and none may be invented here).
 * Semantics:
 *
 * - **No world loaded yet:** safe no-op that resolves without sending anything
 *   (there is no authoritative controlled actor to move).
 * - **A move already in flight:** no second concurrent request; the latest
 *   direction is queued and dispatched when the current request settles.
 * - **Never rejects:** failures settle the store into `error` and resolve.
 */
export function moveActor(direction: MoveDirection): Promise<void> {
  if (state.controlledActor === null) {
    // No authoritative snapshot yet; refuse the step rather than send a command
    // the server would have to reject.
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
    // any) as the next request. Waiters attached to a direction resolve once the
    // request that superseded it (or its own request) has settled.
    for (;;) {
      await performMove(currentDirection, loopGeneration);

      // Settle the waiters attached to the request that just completed. These
      // are owned by this loop regardless of whether it is still current.
      for (const resolve of currentWaiters) {
        resolve();
      }
      currentWaiters = [];

      // A reset supersedes this loop. `resetWorldState` already drained the
      // waiters that were queued when it ran, and any newer queue belongs to the
      // loop that now owns the token. Do not consume it: touching the shared
      // queue here would silently drop a newer caller's direction and leave its
      // promise unsettled forever.
      if (loopGeneration !== generation) {
        break;
      }

      const nextDirection = queuedDirection;
      const nextWaiters = queuedWaiters;
      queuedDirection = null;
      queuedWaiters = [];

      if (nextDirection === null) {
        break;
      }
      currentDirection = nextDirection;
      currentWaiters = nextWaiters;
    }
  } finally {
    // Only the current generation's loop owns the shared queue. Drain anything
    // queued after the final dispatch so no caller is left waiting. A superseded
    // loop must not touch the queue owned by its successor.
    if (loopGeneration === generation) {
      for (const resolve of queuedWaiters) {
        resolve();
      }
      queuedWaiters = [];
      queuedDirection = null;
    }
    if (activeMoveToken === token) {
      activeMoveToken = null;
    }
  }
}

async function performMove(direction: MoveDirection, loopGeneration: number): Promise<void> {
  if (state.controlledActor === null) {
    return;
  }

  const command: MoveActorCommand = { direction };

  try {
    const result = await requestMoveActor(command);
    if (loopGeneration !== generation) {
      return;
    }
    // A concurrent `loadWorld`/`resetWorldState` invalidates this result.
    if (state.controlledActor === null) {
      return;
    }
    applyMoveResult(result);
  } catch (error) {
    if (loopGeneration !== generation) {
      return;
    }
    // Preserve the last authoritative world/actor so the map stays visible;
    // only the status/error signal the failure.
    setState({
      status: 'error',
      world: state.world,
      controlledActor: state.controlledActor,
      error: toMoveErrorMessage(error),
    });
  }
}

/**
 * Map a movement failure to a user-presentable message. An unknown actor (404)
 * is the one transport status with a specific, actionable meaning here.
 */
function toMoveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'status' && error.status === 404) {
    return 'That actor could not be found.';
  }
  return describeApiError(error, 'Something went wrong while moving.');
}

/**
 * Reconcile a server move result into state. `result.actor.position` is
 * authoritative; for a refused step (`moved: false`) it is unchanged, so the
 * visible position does not move and no error is raised.
 */
function applyMoveResult(result: MoveActorResult): void {
  setState({
    status: 'ready',
    world: state.world,
    controlledActor: toControlledActorViewModel(result.actor),
    error: null,
  });
}

function setState(next: WorldState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}
