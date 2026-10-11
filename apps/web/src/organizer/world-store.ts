/**
 * Client-side store for the world feature.
 *
 * Owns the world request lifecycle (`idle -> loading -> ready | error`), the
 * command pipeline, subscriptions, and the mapping from internal transport
 * failures to user-presentable strings. It is intentionally a *second* module
 * singleton, separate from `game-info-store`, so the two resources never share
 * state or in-flight bookkeeping.
 *
 * The client is **event-driven over the primitive contract**: a command returns an
 * authoritative `{ events, serverTime }` delta, and the store applies those events
 * to its entity state. An empty `events` array is the server *refusing* the
 * command; it is not an error and changes nothing.
 *
 * Authoritative server state only. There is no prediction, interpolation, deltas,
 * or bounds checking: the visible world changes *only* when a validated snapshot
 * or event is reconciled into the view model.
 */

import type { ActorMoveCommand, GameEvent } from '@starvalley/protocol';

import { ApiError, describeApiError } from './transport';
import { fetchWorld, submitCommand } from './world-api-client';
import {
  compareEntityViewModels,
  toEntityViewModels,
  toEntityViewModel,
  toWorldViewModel,
} from './world-view-model';
import type { EntityViewModel, MoveDirection, WorldViewModel } from './world-view-model';

/** World request lifecycle as observed by the UI. */
export type WorldStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Observable state. `world`/`entities` are populated once a snapshot is `ready`. */
export interface WorldState {
  status: WorldStatus;
  world: WorldViewModel | null;
  /** Authoritative entities, ordered deterministically by `entityId`. */
  entities: readonly EntityViewModel[];
  /** The actor the caller controls, or `null` when the caller controls nothing. */
  controlledActorId: string | null;
  /** User-presentable message; never a raw error/response object. */
  error: string | null;
}

type Listener = (state: WorldState) => void;

/** Shared empty list so idle/loading states are reference-stable. */
const NO_ENTITIES: readonly EntityViewModel[] = Object.freeze([]);

/** Canonical initial state. Reused so `getWorldState` is reference-stable. */
const IDLE_STATE: WorldState = {
  status: 'idle',
  world: null,
  entities: NO_ENTITIES,
  controlledActorId: null,
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
 * Command serialization.
 *
 * Exactly one command may be in flight at a time (`activeMoveToken`). While one
 * is in flight, `moveActor` records only the *latest* requested direction
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
 * second fetch. A successful snapshot **replaces** the world and entity state
 * wholesale.
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
  setState({
    status: 'loading',
    world: null,
    entities: NO_ENTITIES,
    controlledActorId: null,
    error: null,
  });

  try {
    const snapshot = await fetchWorld();
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'ready',
      world: toWorldViewModel(snapshot),
      entities: toEntityViewModels(snapshot.entities),
      controlledActorId: snapshot.controlledActorId,
      error: null,
    });
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'error',
      world: null,
      entities: NO_ENTITIES,
      controlledActorId: null,
      error: describeApiError(error, 'Something went wrong while loading the world.'),
    });
  }
}

/**
 * UI intent: move the controlled actor one tile in `direction`.
 *
 * The store owns the wire command: the primitive is built from the direction
 * alone as `{ type: 'actor.move', direction }`. The server resolves *which* actor
 * the caller controls from transport context, so no actor/player id is ever sent
 * (and none may be invented here). Semantics:
 *
 * - **No world loaded yet:** safe no-op that resolves without sending anything
 *   (there is no authoritative controlled actor to move).
 * - **A command already in flight:** no second concurrent request; the latest
 *   direction is queued and dispatched when the current request settles.
 * - **Never rejects:** failures settle the store into `error` and resolve.
 */
export function moveActor(direction: MoveDirection): Promise<void> {
  if (state.controlledActorId === null) {
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
  if (state.controlledActorId === null) {
    return;
  }

  const command: ActorMoveCommand = { type: 'actor.move', direction };

  try {
    const response = await submitCommand(command);
    if (loopGeneration !== generation) {
      return;
    }
    // A concurrent `loadWorld`/`resetWorldState` invalidates this result.
    if (state.controlledActorId === null) {
      return;
    }
    applyEvents(response.events);
  } catch (error) {
    if (loopGeneration !== generation) {
      return;
    }
    // Preserve the last authoritative world/entities so the map stays visible;
    // only the status/error signal the failure.
    setState({
      status: 'error',
      world: state.world,
      entities: state.entities,
      controlledActorId: state.controlledActorId,
      error: toMoveErrorMessage(error),
    });
  }
}

/**
 * Map a command failure to a user-presentable message. An unknown actor (404) is
 * the one transport status with a specific, actionable meaning here.
 */
function toMoveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'status' && error.status === 404) {
    return 'That actor could not be found.';
  }
  return describeApiError(error, 'Something went wrong while moving.');
}

/**
 * Reconcile the authoritative event delta into entity state.
 *
 * - `transform.changed` updates exactly that entity; it never creates one.
 * - `entity.spawned` adds (or replaces) the entity.
 * - `entity.removed` drops the entity.
 *
 * An **empty** event list is the server refusing the command: it is not an error,
 * the status stays `ready`, the error stays `null`, and nothing changes. Events
 * that would produce no observable change are also ignored so the state object
 * (and therefore the `useSyncExternalStore` snapshot) stays reference-stable.
 *
 * Exported as an internal seam only (it is deliberately **not** re-exported from
 * the public `organizer/index.ts` surface): the transport's Protocol guards reject
 * an unknown event `type` before it reaches here, so this function's defensive
 * tolerance for an unrecognised event can only be exercised directly.
 */
export function applyEvents(events: readonly GameEvent[]): void {
  if (events.length === 0) {
    return;
  }

  const byId = new Map<string, EntityViewModel>();
  for (const entity of state.entities) {
    byId.set(entity.entityId, entity);
  }

  let changed = false;
  for (const event of events) {
    switch (event.type) {
      case 'entity.spawned': {
        const next = toEntityViewModel(event.entity);
        const previous = byId.get(next.entityId);
        if (previous === undefined || !entityEquals(previous, next)) {
          byId.set(next.entityId, next);
          changed = true;
        }
        break;
      }
      case 'entity.removed': {
        if (byId.delete(event.entityId)) {
          changed = true;
        }
        break;
      }
      case 'transform.changed': {
        const previous = byId.get(event.entityId);
        // Create nothing and invent nothing: an unknown entity is ignored.
        if (
          previous !== undefined &&
          (previous.x !== event.transform.x || previous.y !== event.transform.y)
        ) {
          byId.set(event.entityId, {
            ...previous,
            x: event.transform.x,
            y: event.transform.y,
          });
          changed = true;
        }
        break;
      }
      default: {
        // Exhaustiveness guard on the server-sent union. The `never`
        // assignment is what makes a future `GameEvent` member a *compile*
        // error here until it is handled above: `event` is narrowed to `never`
        // only when every member has a case.
        //
        // At *runtime* an unknown event is tolerated, not thrown: the server
        // may legitimately add an event this client build does not understand
        // yet, and one unrecognised delta must never crash the client or drop
        // the rest of the batch. Skip it and keep applying the others.
        const exhaustive: never = event;
        void exhaustive;
        break;
      }
    }
  }

  if (!changed) {
    return;
  }

  setState({
    status: 'ready',
    world: state.world,
    entities: [...byId.values()].sort(compareEntityViewModels),
    controlledActorId: state.controlledActorId,
    error: null,
  });
}

function entityEquals(a: EntityViewModel, b: EntityViewModel): boolean {
  return (
    a.entityId === b.entityId &&
    a.actorId === b.actorId &&
    a.kind === b.kind &&
    a.x === b.x &&
    a.y === b.y &&
    a.visible === b.visible
  );
}

function setState(next: WorldState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}
