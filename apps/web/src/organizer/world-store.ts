/**
 * Client-side store for the world feature.
 *
 * Owns the world request lifecycle (`idle -> loading -> ready | error`) for the
 * one-shot snapshot, the realtime stream lifecycle (`idle -> connecting -> live |
 * error`), the movement-intent pipeline, subscriptions, and the mapping from
 * internal transport failures to user-presentable strings.
 *
 * The client is **authoritative-only**: it never predicts and never interpolates.
 * A snapshot and a stream `events` message are the *only* things that move an
 * entity; `setMovementIntent` sends a direction and changes no client position.
 * Smoothing/interpolation between authoritative transforms is the renderer's job
 * (Render ISA `transform.setTarget`), not the Organizer's.
 *
 * ## Realtime stream
 *
 * After a successful snapshot, the store opens exactly one Server-Sent Events
 * connection (`world-stream`). The server sends a full `snapshot` first on every
 * connection (which replaces client state wholesale), then `events` batches
 * (applied through the same applier used for command acks). The store owns the
 * retry policy: a bounded exponential backoff, and after a bounded number of
 * consecutive connection failures `streamStatus` stays `error` instead of
 * reconnecting forever. `resetWorldState()` closes the connection.
 *
 * Every frame is validated with the canonical Protocol guard
 * (`parseWorldStreamMessage`); a malformed frame is ignored and never corrupts
 * state. This module never invents a wire field.
 *
 * ## Movement intent
 *
 * `setMovementIntent({ x, z })` is level-triggered: the UI posts only when the
 * input *changes*, and the Manager stores the latest intent per actor. The body
 * is exactly `{ type: 'actor.moveIntent', movement: { x, z } }` — no actor field
 * (the actor is resolved from transport context) and no position (the client is
 * never trusted with one). Requests are serialised with a single in-flight slot
 * and latest-wins coalescing so rapid input cannot storm the network.
 *
 * ## One-shot intents (`moveTo` / `interact`)
 *
 * `moveTo({ x, y, z })` and `interact(entityId)` post the canonical
 * `actor.moveTo` / `actor.interact` commands. Both take **world-space gameplay
 * data only**: the store never sees a camera, NDC, pointer coordinate or ray,
 * and it sends no actor id and no position. Neither changes any local position;
 * only a validated snapshot or event batch moves an entity (no prediction).
 *
 * A *rejected* intent (the server refuses a well-formed request because it is
 * illegal against the current world state, `CONFLICT`/409, or names a gone
 * target, `NOT_FOUND`/404) is surfaced through `WorldState.notice` — a short,
 * user-presentable string. The reason is read from the canonical `ProtocolError`
 * body (the machine-readable `code` plus the server-authored `message`), not from
 * the status alone, so an out-of-range and a non-interactable 409 stay
 * distinguishable. It deliberately does **not** touch `status` or `error`: a
 * rejected intent is not a broken world, and flipping `status` here
 * was exactly the phase-7 bug that gated movement. `notice` clears on the next
 * successful intent and on `resetWorldState()`.
 *
 * Terrain is **static**: no event carries it, so `tiles`/`grid`/`bounds` are only
 * ever replaced by a fresh snapshot and are carried over reference-identically by
 * the event applier. `terrain` stays an opaque string; walkability is an
 * authoritative Manager rule, so the store derives no collision rule of its own.
 */

import { parseEntityId, parseWorldStreamMessage } from '@starvalley/protocol';
import type {
  EntityId,
  GameEvent,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  WorldSnapshot,
  WorldStreamMessage,
} from '@starvalley/protocol';

import { ApiError, describeApiError } from './transport';
import { fetchWorld, submitCommand } from './world-api-client';
import { createWorldEventSource } from './world-stream';
import type { EventSourceLike } from './world-stream';
import {
  compareEntityViewModels,
  toBoundsViewModel,
  toEntityViewModels,
  toEntityViewModel,
  toGridViewModel,
  toTileViewModels,
} from './world-view-model';
import type {
  BoundsViewModel,
  EntityViewModel,
  GridViewModel,
  TileViewModel,
} from './world-view-model';

/** Snapshot request lifecycle as observed by the UI. */
export type WorldStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Realtime stream lifecycle as observed by the UI. */
export type StreamStatus = 'idle' | 'connecting' | 'live' | 'error';

/** Desired horizontal movement direction, each component in `[-1, 1]`. */
type MovementIntent = { x: number; z: number };

/** Observable state. */
export interface WorldState {
  status: WorldStatus;
  streamStatus: StreamStatus;
  /** The loaded world's identity, or `null` while no snapshot is `ready`. */
  worldId: string | null;
  /** The world's AABB, or `null` while no snapshot is `ready`. */
  bounds: BoundsViewModel | null;
  /** The gameplay grid configuration, or `null` while no snapshot is `ready`. */
  grid: GridViewModel | null;
  /** Static terrain, ordered deterministically by `cellZ` then `cellX`. */
  tiles: readonly TileViewModel[];
  /** Authoritative entities, ordered deterministically by `entityId`. */
  entities: readonly EntityViewModel[];
  /** The actor the caller controls, or `null` when the caller controls nothing. */
  controlledActorId: string | null;
  /** User-presentable message; never a raw error/response object. */
  error: string | null;
  /**
   * Short, user-presentable message for a *rejected intent* (e.g. out of range),
   * or `null`. Never used for a broken world: a rejection leaves `status`/`error`
   * untouched so movement stays usable. Cleared by the next successful intent
   * and by `resetWorldState()`.
   */
  notice: string | null;
}

type Listener = (state: WorldState) => void;

/** Short, non-technical messages for a rejected intent (see `WorldState.notice`). */
const NOTICE_NOT_FOUND = 'That is gone.';
const NOTICE_GENERIC = 'Could not do that.';

/** Shared empty lists so idle/loading states are reference-stable. */
const NO_TILES: readonly TileViewModel[] = Object.freeze([]);
const NO_ENTITIES: readonly EntityViewModel[] = Object.freeze([]);

/** Canonical initial state. Reused so `getWorldState` is reference-stable. */
const IDLE_STATE: WorldState = {
  status: 'idle',
  streamStatus: 'idle',
  worldId: null,
  bounds: null,
  grid: null,
  tiles: NO_TILES,
  entities: NO_ENTITIES,
  controlledActorId: null,
  error: null,
  notice: null,
};

/**
 * Bounded stream reconnect policy.
 *
 * A connection failure sets `streamStatus` to `error` and schedules a retry after
 * an exponential backoff (capped at `STREAM_MAX_RETRY_DELAY_MS`). After
 * `STREAM_MAX_RECONNECT_ATTEMPTS` consecutive failures the store stops and leaves
 * `streamStatus === 'error'` rather than reconnecting forever. A successful open
 * resets the counter.
 */
const STREAM_BASE_RETRY_DELAY_MS = 250;
const STREAM_MAX_RETRY_DELAY_MS = 4_000;
const STREAM_MAX_RECONNECT_ATTEMPTS = 4;

let state: WorldState = IDLE_STATE;
/**
 * Bumped on reset so a response or timer that settles afterwards cannot clobber
 * newer state. Read-only during normal operation.
 */
let generation = 0;
let inFlightLoad: Promise<void> | null = null;
const listeners = new Set<Listener>();

// --- Realtime stream bookkeeping -------------------------------------------

/** The single open connection, or `null` while none is open. */
let eventSource: EventSourceLike | null = null;
/** Pending reconnect timer, or `null` when no reconnect is scheduled. */
let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive connection failures since the last successful open. */
let streamAttempt = 0;

// --- Intent pipeline bookkeeping -------------------------------------------

/**
 * Exactly one intent request may be in flight at a time (`activeIntentToken`).
 * While one is in flight, `setMovementIntent` records only the *latest* requested
 * movement (`queuedIntent`) and returns a promise that settles once the request
 * that superseded it (or its own request) has settled. This bounds rapid input to
 * one request per settle and keeps ordering deterministic.
 */
interface IntentLoopToken {
  readonly active: true;
}

let activeIntentToken: IntentLoopToken | null = null;
let queuedIntent: MovementIntent | null = null;
let queuedIntentWaiters: Array<() => void> = [];

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
 * Return to the initial `idle` state, discard any in-flight load result, close the
 * stream, cancel any pending reconnect, and drain any queued intents (their
 * promises resolve without further I/O).
 */
export function resetWorldState(): void {
  generation += 1;
  inFlightLoad = null;
  resetStream();
  activeIntentToken = null;
  queuedIntent = null;
  const waiters = queuedIntentWaiters;
  queuedIntentWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
  setState(IDLE_STATE);
}

/**
 * Load the authoritative world snapshot, then open the realtime stream.
 *
 * Never rejects: the returned promise resolves once the snapshot has settled
 * (`ready` or `error`). Idempotent: concurrent calls share the same promise, and
 * a call while a stream is already `connecting`/`live` is a no-op (it does not
 * re-fetch or restart the stream). A successful snapshot **replaces** the world,
 * bounds, grid, tile, and entity state wholesale.
 */
export function loadWorld(): Promise<void> {
  if (inFlightLoad !== null) {
    return inFlightLoad;
  }
  if (
    state.status === 'ready' &&
    (state.streamStatus === 'connecting' || state.streamStatus === 'live')
  ) {
    return Promise.resolve();
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
  // Drop any stale connection/timer from a previous attempt before starting over.
  teardownStream();
  streamAttempt = 0;

  setState({
    status: 'loading',
    streamStatus: 'idle',
    worldId: null,
    bounds: null,
    grid: null,
    tiles: NO_TILES,
    entities: NO_ENTITIES,
    controlledActorId: null,
    error: null,
    notice: null,
  });

  try {
    const snapshot = await fetchWorld();
    if (requestGeneration !== generation) {
      return;
    }
    setState(fromSnapshot(snapshot, 'ready', 'idle', null));
    openStream(requestGeneration);
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    setState({
      status: 'error',
      streamStatus: 'idle',
      worldId: null,
      bounds: null,
      grid: null,
      tiles: NO_TILES,
      entities: NO_ENTITIES,
      controlledActorId: null,
      error: describeApiError(error, 'Something went wrong while loading the world.'),
      notice: null,
    });
  }
}

/**
 * Project a validated snapshot into client state. Bounds/grid are mapped fresh,
 * tiles get their world positions derived from the grid, and entities are mapped
 * with their full 3D transform.
 */
function fromSnapshot(
  snapshot: WorldSnapshot,
  status: WorldStatus,
  streamStatus: StreamStatus,
  error: string | null,
): WorldState {
  return {
    status,
    streamStatus,
    worldId: snapshot.worldId,
    bounds: toBoundsViewModel(snapshot.bounds),
    grid: toGridViewModel(snapshot.grid),
    tiles: toTileViewModels(snapshot.tiles, snapshot.grid),
    entities: toEntityViewModels(snapshot.entities),
    controlledActorId: snapshot.controlledActorId,
    error,
    notice: null,
  };
}

// --- Stream lifecycle ------------------------------------------------------

/**
 * Open the stream through the injected factory. The store owns the retry policy;
 * this only wires the connection's lifecycle callbacks to the store's state.
 */
function openStream(streamGeneration: number): void {
  teardownStream();
  setStreamStatus('connecting');

  let source: EventSourceLike;
  try {
    source = createWorldEventSource();
  } catch {
    // No EventSource (SSR/test without an injected factory): treat it as a
    // connection failure so the bounded retry policy still applies.
    handleStreamFailure(null, streamGeneration);
    return;
  }

  eventSource = source;
  source.onopen = () => {
    if (eventSource !== source) {
      return;
    }
    streamAttempt = 0;
    setStreamStatus('live');
  };
  source.onerror = () => {
    if (eventSource !== source) {
      return;
    }
    handleStreamFailure(source, streamGeneration);
  };
  source.addEventListener('message', (event) => {
    if (eventSource !== source) {
      return;
    }
    handleStreamFrame(event.data);
  });
}

/**
 * Handle one connection failure: close the source, surface `error`, and schedule
 * a bounded reconnect unless the attempt budget is exhausted.
 */
function handleStreamFailure(source: EventSourceLike | null, streamGeneration: number): void {
  if (source !== null && eventSource !== source) {
    return;
  }
  if (source !== null) {
    source.onopen = null;
    source.onerror = null;
    source.close();
  }
  eventSource = null;
  streamAttempt += 1;
  setStreamStatus('error');

  if (streamAttempt >= STREAM_MAX_RECONNECT_ATTEMPTS) {
    return;
  }

  const delay = Math.min(
    STREAM_BASE_RETRY_DELAY_MS * 2 ** (streamAttempt - 1),
    STREAM_MAX_RETRY_DELAY_MS,
  );
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = null;
    if (streamGeneration !== generation) {
      return;
    }
    openStream(streamGeneration);
  }, delay);
}

/** Close the current connection and cancel any pending reconnect (keeps the counter). */
function teardownStream(): void {
  if (streamRetryTimer !== null) {
    clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
  }
  if (eventSource !== null) {
    eventSource.onopen = null;
    eventSource.onerror = null;
    eventSource.close();
    eventSource = null;
  }
}

/** Close the stream and forget the attempt history (used by `resetWorldState`). */
function resetStream(): void {
  teardownStream();
  streamAttempt = 0;
}

/**
 * Validate and apply one stream frame. A malformed frame (bad JSON or a payload
 * that fails the canonical Protocol guard) is ignored: one unrecognised frame
 * must never crash the client or corrupt the current state.
 */
function handleStreamFrame(data: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  let message: WorldStreamMessage;
  try {
    message = parseWorldStreamMessage(parsed);
  } catch {
    return;
  }

  switch (message.type) {
    case 'snapshot': {
      // A stream snapshot is authoritative and replaces state wholesale.
      setState(fromSnapshot(message.snapshot, 'ready', state.streamStatus, null));
      break;
    }
    case 'events': {
      applyEvents(message.batch.events);
      break;
    }
    default: {
      // Exhaustiveness guard on the server-sent union; a future member is a
      // compile error until handled here.
      const exhaustive: never = message;
      void exhaustive;
      break;
    }
  }
}

/** Mutate only `streamStatus`, preserving every other field reference-identically. */
function setStreamStatus(next: StreamStatus): void {
  if (state.streamStatus === next) {
    return;
  }
  setState({ ...state, streamStatus: next });
}

// --- Movement intent -------------------------------------------------------

/**
 * UI intent: "the actor I control should move in `movement`", level-triggered.
 *
 * The store builds the wire command itself as
 * `{ type: 'actor.moveIntent', movement: { x, z } }`. The server resolves *which*
 * actor the caller controls from transport context, so no actor/player id is ever
 * sent (and none may be invented here), and the client never sends a position.
 * Semantics:
 *
 * - **No world loaded yet:** safe no-op that resolves without sending anything.
 * - **A request already in flight:** no second concurrent request; the latest
 *   movement is queued and dispatched when the current request settles.
 * - **Never rejects:** failures settle the store into `error` and resolve.
 *
 * It changes no client position: only the authoritative events returned by the
 * server (or the stream) move an entity. There is no prediction.
 */
export function setMovementIntent(movement: { x: number; z: number }): Promise<void> {
  if (state.controlledActorId === null) {
    // No authoritative snapshot yet; refuse the intent rather than send a
    // command the server would have to reject.
    return Promise.resolve();
  }

  // Copy only the contract fields so a stray runtime key cannot reach the wire.
  const intent: MovementIntent = { x: movement.x, z: movement.z };

  return new Promise<void>((resolve) => {
    if (activeIntentToken !== null) {
      queuedIntent = intent;
      queuedIntentWaiters.push(resolve);
      return;
    }

    const token: IntentLoopToken = { active: true };
    activeIntentToken = token;
    void runIntentLoop(intent, [resolve], token);
  });
}

async function runIntentLoop(
  initialMovement: MovementIntent,
  initialWaiters: Array<() => void>,
  token: IntentLoopToken,
): Promise<void> {
  const loopGeneration = generation;
  let currentMovement = initialMovement;
  let currentWaiters: Array<() => void> = initialWaiters;

  try {
    for (;;) {
      await performIntent(currentMovement, loopGeneration);

      // Settle the waiters attached to the request that just completed.
      for (const resolve of currentWaiters) {
        resolve();
      }
      currentWaiters = [];

      // A reset supersedes this loop; it already drained the waiters that were
      // queued when it ran. Do not consume the newer queue: it belongs to the
      // successor loop.
      if (loopGeneration !== generation) {
        break;
      }

      const nextMovement = queuedIntent;
      const nextWaiters = queuedIntentWaiters;
      queuedIntent = null;
      queuedIntentWaiters = [];

      if (nextMovement === null) {
        break;
      }
      currentMovement = nextMovement;
      currentWaiters = nextWaiters;
    }
  } finally {
    if (loopGeneration === generation) {
      for (const resolve of queuedIntentWaiters) {
        resolve();
      }
      queuedIntentWaiters = [];
      queuedIntent = null;
    }
    if (activeIntentToken === token) {
      activeIntentToken = null;
    }
  }
}

async function performIntent(
  movement: MovementIntent,
  loopGeneration: number,
): Promise<void> {
  if (state.controlledActorId === null) {
    return;
  }

  const command: MoveIntentCommand = {
    type: 'actor.moveIntent',
    movement: { x: movement.x, z: movement.z },
  };

  try {
    const batch = await submitCommand(command);
    if (loopGeneration !== generation) {
      return;
    }
    if (state.controlledActorId === null) {
      return;
    }
    applyEvents(batch.events);
    if (loopGeneration !== generation) {
      return;
    }
    clearNotice();
  } catch (error) {
    if (loopGeneration !== generation) {
      return;
    }
    // Preserve the last authoritative world so the scene stays visible; only the
    // status/error signal the failure.
    setState({
      ...state,
      status: 'error',
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
  return describeApiError(error, 'Something went wrong while sending movement.');
}

// --- One-shot intents: moveTo / interact -----------------------------------

/**
 * UI intent: "steer the actor I control toward this world-space point".
 *
 * The store builds and posts exactly `{ type: 'actor.moveTo', target }`. `target`
 * is a continuous world-space position; the server decides whether the goal is
 * legal (in bounds / reachable) and integrates toward it. Picking that point
 * from a pointer is the UI/runtime's job (raycast + ground plane): the Organizer
 * never sees a camera, NDC value, pointer coordinate or ray, and never clamps.
 *
 * It changes no client position (no prediction) and, like `setMovementIntent`,
 * is a safe no-op before a controlled actor exists. A rejected goal sets
 * `notice` only — it never flips `status` or `error`. Never rejects.
 */
export function moveTo(target: { x: number; y: number; z: number }): Promise<void> {
  if (state.controlledActorId === null) {
    return Promise.resolve();
  }
  // Copy only the contract fields so a stray runtime key cannot reach the wire.
  const command: MoveToCommand = {
    type: 'actor.moveTo',
    target: { x: target.x, y: target.y, z: target.z },
  };
  return submitPlayerIntent(command);
}

/**
 * UI intent: "interact with this world entity".
 *
 * The store builds and posts exactly `{ type: 'actor.interact', targetEntityId }`.
 * The Manager validates existence, range and interactability; today the only
 * observed effect is an authoritative `transform.changed` (face + stop), which is
 * reconciled like any other event. Any refusal is surfaced through `notice`, never
 * by corrupting a position locally. Never rejects.
 */
export function interact(targetEntityId: string): Promise<void> {
  if (state.controlledActorId === null) {
    return Promise.resolve();
  }
  // The public API takes a plain string; the canonical Protocol guard is what
  // turns it into the branded `EntityId` the wire contract requires. An empty id
  // can never be sent, so it is rejected locally as a generic notice.
  let entityId: EntityId;
  try {
    entityId = parseEntityId(targetEntityId);
  } catch {
    setNotice(NOTICE_GENERIC);
    return Promise.resolve();
  }
  const command: InteractCommand = { type: 'actor.interact', targetEntityId: entityId };
  return submitPlayerIntent(command);
}

/**
 * Submit a one-shot player intent and reconcile its outcome.
 *
 * Success applies the authoritative event delta (which is the only thing that may
 * move anything) and clears any stale `notice`. A rejection carries no events and
 * must not be treated as a broken world: it maps to a short `notice` while
 * `status`/`error` are left exactly as they were.
 */
async function submitPlayerIntent(command: MoveToCommand | InteractCommand): Promise<void> {
  const intentGeneration = generation;
  try {
    const batch = await submitCommand(command);
    if (intentGeneration !== generation) {
      return;
    }
    applyEvents(batch.events);
    if (intentGeneration !== generation) {
      return;
    }
    clearNotice();
  } catch (error) {
    if (intentGeneration !== generation) {
      return;
    }
    setNotice(toIntentNotice(error));
  }
}

/**
 * Map a one-shot intent failure to a short, user-presentable `notice`.
 *
 * The *reason* is taken from the canonical `ProtocolError` body, never from the
 * HTTP status alone: a `409 CONFLICT` is a well-formed request that is illegal
 * against the current world state, which covers several distinct refusals (out of
 * range, non-interactable, ...). The server authors a short, user-presentable
 * `message` for exactly that case, so it is surfaced verbatim. When the body is
 * missing/unparseable, or the status is neither 404 nor 409, fall back to a
 * generic, non-technical phrase.
 *
 * - `CONFLICT` (409): the server's message, else the generic phrase.
 * - `NOT_FOUND` (404): "That is gone."
 * - Anything else: the generic phrase.
 */
function toIntentNotice(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'status') {
    if (error.status === 409) {
      const message = error.serverMessage;
      return message !== undefined && message.length > 0 ? message : NOTICE_GENERIC;
    }
    if (error.status === 404) {
      return NOTICE_NOT_FOUND;
    }
  }
  return NOTICE_GENERIC;
}

/** Set `notice`, preserving every other field reference-identically when unchanged. */
function setNotice(next: string | null): void {
  if (state.notice === next) {
    return;
  }
  setState({ ...state, notice: next });
}

/** Clear a stale notice after a successful intent (no-op when already clear). */
function clearNotice(): void {
  setNotice(null);
}

// --- Event reconciliation --------------------------------------------------

/**
 * Reconcile an authoritative event delta into entity state.
 *
 * - `transform.changed` updates exactly that entity; it never creates one.
 * - `entity.spawned` adds (or replaces) the entity.
 * - `entity.removed` drops the entity.
 *
 * An **empty** event list is the server refusing a command: it is not an error,
 * the status stays `ready`, the error stays `null`, and nothing changes. Events
 * that would produce no observable change are ignored so the state object (and
 * therefore the `useSyncExternalStore` snapshot) stays reference-stable.
 *
 * Static tiles/grid/bounds are carried over reference-identically: no event
 * replaces them, only a fresh snapshot does.
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
        if (previous !== undefined) {
          const next: EntityViewModel = {
            ...previous,
            position: {
              x: event.transform.position.x,
              y: event.transform.position.y,
              z: event.transform.position.z,
            },
            rotation: {
              x: event.transform.rotation.x,
              y: event.transform.rotation.y,
              z: event.transform.rotation.z,
              w: event.transform.rotation.w,
            },
          };
          if (!entityEquals(previous, next)) {
            byId.set(event.entityId, next);
            changed = true;
          }
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
    ...state,
    status: 'ready',
    tiles: state.tiles,
    grid: state.grid,
    bounds: state.bounds,
    entities: [...byId.values()].sort(compareEntityViewModels),
    error: null,
  });
}

function entityEquals(a: EntityViewModel, b: EntityViewModel): boolean {
  return (
    a.entityId === b.entityId &&
    a.actorId === b.actorId &&
    a.kind === b.kind &&
    a.visible === b.visible &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.position.z === b.position.z &&
    a.rotation.x === b.rotation.x &&
    a.rotation.y === b.rotation.y &&
    a.rotation.z === b.rotation.z &&
    a.rotation.w === b.rotation.w
  );
}

function setState(next: WorldState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}
