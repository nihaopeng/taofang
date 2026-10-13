import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ProtocolParseError, STREAM_PATH } from '@starvalley/protocol';
import type {
  ActorId,
  GameEventBatch,
  ProtocolErrorCode,
  WorldStreamMessage,
} from '@starvalley/protocol';
import {
  InteractionRejectedError,
  PlacementRejectedError,
  UnknownActorError,
  UnknownEntityError,
} from '@starvalley/manager';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';
import { mapErrorCodeToStatus, protocolErrorBody } from './http-errors.ts';
import { allowedMethods, findRoute, isKnownPath } from './routes.ts';

/**
 * The single caller-identity seam: transport context in, `ActorId` out.
 *
 * This is the ONLY place the actor a request acts as is decided, and it reads
 * TRANSPORT CONTEXT (the raw request), never the request body. Today the
 * composition root returns the server's single local actor. A future session
 * slice resolves session/cookie/header -> `PlayerId` -> the `ActorId` that
 * player controls here, without changing any route handler.
 */
export type ResolveActorId = (request: IncomingMessage) => ActorId | Promise<ActorId>;

/**
 * The realtime fan-out seam the composition root provides: a plain
 * listener-registration port, deliberately timer-free.
 *
 * Router never owns a tick. The composition root owns the simulation clock and
 * calls this port's listeners with the batch produced by each step; Router only
 * adapts those typed batches onto the SSE transport.
 */
export interface WorldStreamPort {
  subscribe(listener: (batch: GameEventBatch) => void): () => void;
}

/** Typed collaborators the Router layer needs from the application. */
export interface RouterDependencies {
  readonly gameInfo: GameInfoManager;
  readonly world: WorldManager;
  readonly worldStream: WorldStreamPort;
  readonly resolveActorId: ResolveActorId;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Media type committed on `GET STREAM_PATH`; a disconnect here is normal. */
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

/** Hard cap on a request body; anything larger is rejected with BAD_REQUEST. */
const MAX_BODY_BYTES = 64 * 1024;

/** Methods that may carry a body; anything else gets `body === undefined`. */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** Heartbeat cadence for the SSE stream, keeping proxies from idling it out. */
const STREAM_HEARTBEAT_MS = 15_000;

type BodyFailureReason = 'too-large' | 'malformed' | 'empty';

const BODY_FAILURE_MESSAGES: Record<BodyFailureReason, string> = {
  'too-large': `Request body exceeds the ${MAX_BODY_BYTES} byte limit`,
  malformed: 'Request body is not valid JSON',
  empty: 'Request body is required',
};

/** Internal signal that the inbound body could not be read as required JSON. */
class BodyReadError extends Error {
  readonly reason: BodyFailureReason;

  constructor(reason: BodyFailureReason) {
    super(BODY_FAILURE_MESSAGES[reason]);
    this.name = 'BodyReadError';
    this.reason = reason;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  // `destroyed`/`writableEnded` mean the peer already vanished or we already
  // answered: touching the socket would throw synchronously and must never
  // escape the listener.
  if (response.destroyed || response.writableEnded) {
    return;
  }
  try {
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('content-type', JSON_CONTENT_TYPE);
    // Advertise the exact length so GET and HEAD agree on the representation.
    // `ServerResponse` suppresses the body for HEAD/204/304 while keeping this
    // header (and the status/content-type) intact.
    response.setHeader('content-length', Buffer.byteLength(payload));
    response.end(payload);
  } catch (error) {
    // A synchronous write failure on an aborted socket must be observed, not
    // rethrown: the connection is gone, so there is nobody left to answer.
    console.error('[router] failed to write protocol response:', error);
  }
}

/**
 * Destroy the request socket once the outgoing response has fully flushed.
 *
 * For an oversized body the peer must be stopped, but destroying the socket
 * while the 400 is still buffered (and inbound data is unread) can RST the
 * connection before a slow/uploading client reads the error. Waiting for
 * `finish` (or `close`, when the peer vanished first) preserves delivery while
 * still tearing the connection down. The handler is one-shot so the socket is
 * destroyed at most once and no listener is leaked.
 */
function destroyAfterResponseFlush(request: IncomingMessage, response: ServerResponse): void {
  let handled = false;
  const destroyOnce = (): void => {
    if (handled) {
      return;
    }
    handled = true;
    response.off('finish', destroyOnce);
    response.off('close', destroyOnce);
    request.destroy();
  };
  response.once('finish', destroyOnce);
  response.once('close', destroyOnce);
}

function sendProtocolError(
  response: ServerResponse,
  code: ProtocolErrorCode,
  message: string,
): void {
  sendJson(response, mapErrorCodeToStatus(code), protocolErrorBody(code, message));
}

/**
 * Whether the response currently being written is an event stream.
 *
 * A client closing an event stream is the expected end of the stream, so the
 * abort handler must not treat it as an exceptional client failure. The header
 * is committed by `handleStream` before any frame is written, so it is already
 * readable by the time a disconnect can occur.
 */
function isEventStreamResponse(response: ServerResponse): boolean {
  const contentType = response.getHeader('content-type');
  return typeof contentType === 'string' && contentType.startsWith(EVENT_STREAM_CONTENT_TYPE);
}

/**
 * Read and JSON-parse the request body for body-carrying methods.
 *
 * Transport concern, kept entirely in the listener: enforces the byte cap,
 * parses JSON, and rejects empty/oversized/malformed payloads. Handlers only
 * ever see the parsed value (or `undefined` for bodyless methods).
 */
function readRequestBody(request: IncomingMessage, method: string): Promise<unknown> {
  if (!BODY_METHODS.has(method)) {
    return Promise.resolve(undefined);
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    function cleanup(): void {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      request.off('close', onClose);
    }

    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        reject(new BodyReadError('too-large'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      cleanup();
      if (size === 0) {
        reject(new BodyReadError('empty'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BodyReadError('malformed'));
      }
    }

    function onError(): void {
      cleanup();
      reject(new BodyReadError('malformed'));
    }

    // A client that disconnects mid-upload must settle the read instead of
    // leaving the handler pending forever. `aborted` is the legacy signal;
    // `close` without a prior `end` covers newer Node. `cleanup` removes the
    // `close` listener on a normal `end`, so the happy path is unaffected.
    function onAborted(): void {
      cleanup();
      reject(new BodyReadError('malformed'));
    }

    function onClose(): void {
      cleanup();
      reject(new BodyReadError('malformed'));
    }

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
    request.on('close', onClose);
  });
}

/**
 * Resolve the caller identity exactly once and reject a missing result.
 *
 * The resolver is the single authorization seam; a rejected or empty result is
 * a server-side failure and must surface as the shared opaque `INTERNAL_ERROR`,
 * never as an actor-less request that reaches Manager.
 */
async function resolveRequiredActor(
  deps: RouterDependencies,
  request: IncomingMessage,
): Promise<ActorId> {
  const actorId: ActorId | undefined = await deps.resolveActorId(request);
  if (actorId === undefined) {
    throw new Error('Actor resolution returned no actor');
  }
  return actorId;
}

/**
 * Serve `GET STREAM_PATH` as a Server-Sent Events stream.
 *
 * Transport-only: commits the SSE headers, emits the leading `snapshot` frame
 * (resolved for `actorId`, which closes the connect race), then relays every
 * batch delivered by the injected `worldStream` port as an `events` frame. A
 * periodic heartbeat comment keeps intermediaries from idling the connection.
 * On client disconnect the subscription is released and the response is ended
 * exactly once. There is no timer for the world and no game rule here: the
 * composition root owns the tick.
 */
async function handleStream(
  deps: RouterDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  actorId: ActorId,
): Promise<void> {
  // Resolve the snapshot BEFORE committing headers so an unknown actor still
  // yields the normal JSON error path instead of a half-open stream.
  const snapshot = deps.world.getSnapshot({ actorId });

  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders();

  let finished = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const writeMessage = (message: WorldStreamMessage): void => {
    if (finished || response.destroyed || response.writableEnded) {
      return;
    }
    try {
      response.write(`data: ${JSON.stringify(message)}\n\n`);
    } catch (error) {
      console.error('[router] failed to write stream frame:', error);
    }
  };

  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (unsubscribe !== undefined) {
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    }
    request.off('close', finish);
    request.off('aborted', finish);
    response.off('close', finish);
    if (!response.writableEnded) {
      try {
        response.end();
      } catch (error) {
        console.error('[router] failed to finalize stream response:', error);
      }
    }
  };

  request.on('close', finish);
  request.on('aborted', finish);
  response.on('close', finish);

  heartbeat = setInterval(() => {
    if (finished || response.destroyed || response.writableEnded) {
      return;
    }
    try {
      response.write(': heartbeat\n\n');
    } catch (error) {
      console.error('[router] failed to write stream heartbeat:', error);
    }
  }, STREAM_HEARTBEAT_MS);
  // Do not let a live stream keep the process alive after the server closes.
  heartbeat.unref();

  // The leading snapshot (full state) precedes any delta, so a consumer can
  // materialise the world without a separate request and cannot miss changes
  // that occurred before the subscription was registered.
  writeMessage({ type: 'snapshot', snapshot });
  unsubscribe = deps.worldStream.subscribe((batch) => {
    writeMessage({ type: 'events', batch });
  });
}

/**
 * Player-facing notice for a refused interaction.
 *
 * Unlike the other error messages (which are developer-facing diagnostics),
 * this text is rendered verbatim by the client when it receives the 409, so it
 * is deliberately phrased as something a player should read. Keep the reasons
 * aligned with Manager's `InteractionRejectionReason`; an unrecognised reason
 * falls back to a generic conflict phrase rather than leaking the raw value.
 */
function interactionConflictMessage(reason: InteractionRejectedError['reason']): string {
  switch (reason) {
    case 'out-of-range':
      return 'Too far away.';
    case 'not-interactable':
      return 'Nothing to do with that.';
    default:
      return 'That cannot be done.';
  }
}

/**
 * Player-facing notice for a refused placement/rotation.
 *
 * Like {@link interactionConflictMessage}, the client renders this 409 message
 * verbatim, so it is phrased for a player. Keep the cases aligned with
 * Manager's `PlacementRejectionReason`, but do NOT treat the switch as
 * exhaustive: an unfamiliar (forward-compatible) reason falls back to the raw
 * reason string rather than being swallowed as a 500.
 */
function placementConflictMessage(reason: PlacementRejectedError['reason']): string {
  switch (reason) {
    case 'not-placeable':
      return 'That cannot be placed there.';
    case 'no-supported-orientation':
      return 'That cannot face that way.';
    case 'insufficient-support':
      return 'It needs something to rest on.';
    case 'occupied':
      return 'Something is already there.';
    case 'blocked':
      return 'There is no room for it.';
    default:
      return String(reason);
  }
}

async function handleRequest(
  deps: RouterDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase();

    if (!isKnownPath(url.pathname)) {
      sendProtocolError(response, 'NOT_FOUND', `Unknown path: ${url.pathname}`);
      return;
    }

    // The stream is a transport-shaped route (SSE headers, incremental writes),
    // so it is served directly here rather than through a JSON RouteDefinition.
    if (url.pathname === STREAM_PATH) {
      if (method !== 'GET') {
        response.setHeader('Allow', allowedMethods(url.pathname).join(', '));
        sendProtocolError(response, 'METHOD_NOT_ALLOWED', `Method ${method} not allowed`);
        return;
      }
      const streamActorId = await resolveRequiredActor(deps, request);
      await handleStream(deps, request, response, streamActorId);
      return;
    }

    const route = findRoute(url.pathname, method);
    if (route === undefined) {
      response.setHeader('Allow', allowedMethods(url.pathname).join(', '));
      sendProtocolError(response, 'METHOD_NOT_ALLOWED', `Method ${method} not allowed`);
      return;
    }

    const body = await readRequestBody(request, method);
    // Resolve the caller identity exactly once per request, from transport
    // context (never the body), then pass it as typed context to the handler.
    const actorId = await resolveRequiredActor(deps, request);
    const result = await route.handle({
      gameInfo: deps.gameInfo,
      world: deps.world,
      actorId,
      url,
      body,
    });
    sendJson(response, result.status, result.body);
  } catch (error) {
    if (error instanceof BodyReadError) {
      if (error.reason === 'too-large') {
        // Register before writing so the flush event cannot be missed; the
        // destroy then runs only after the 400 has been delivered.
        destroyAfterResponseFlush(request, response);
      }
      sendProtocolError(response, 'BAD_REQUEST', error.message);
      return;
    }
    if (error instanceof ProtocolParseError) {
      // A bad command body is a client error, not a server failure.
      sendProtocolError(response, error.code, error.message);
      return;
    }
    if (error instanceof UnknownActorError) {
      // The resolved actor does not exist in the world. The actor id is safe to
      // name: it came from Transport, not from the client body.
      sendProtocolError(response, 'NOT_FOUND', `Unknown actor: ${error.actorId}`);
      return;
    }
    if (error instanceof UnknownEntityError) {
      // A command named a world entity that does not exist. The id came from
      // the (validated) command body, so echoing it back is safe.
      sendProtocolError(response, 'NOT_FOUND', `Unknown entity: ${error.entityId}`);
      return;
    }
    if (error instanceof InteractionRejectedError) {
      // The request was well-formed and the target exists, but it is illegal
      // against the current world state (out of range / not interactable).
      // 409 is deliberately distinct from a 400 and from an empty delta, so
      // the client can surface a precise notice instead of "nothing happened".
      // The message is shown to the player for this case, hence the user-facing
      // phrasing; every other error message here stays developer-facing.
      sendProtocolError(response, 'CONFLICT', interactionConflictMessage(error.reason));
      return;
    }
    if (error instanceof PlacementRejectedError) {
      // The placement command was well-formed and named a known kind, but the
      // resulting placement is illegal against current world state. Same 409
      // shape as an interaction refusal; the discriminator is surfaced (via a
      // player-facing phrase) so the client can show a precise notice rather
      // than a generic failure.
      sendProtocolError(response, 'CONFLICT', placementConflictMessage(error.reason));
      return;
    }
    // Log server-side; never leak the message/stack to the client. This also
    // covers a rejecting `resolveActorId`: its reason stays server-side.
    console.error('[router] unhandled error while serving request:', error);
    if (response.headersSent) {
      if (!response.writableEnded) {
        try {
          response.end();
        } catch (endError) {
          console.error('[router] failed to finalize response:', endError);
        }
      }
      return;
    }
    sendProtocolError(response, 'INTERNAL_ERROR', 'Internal server error');
  }
}

/**
 * Build a `node:http` request listener over the given Manager dependencies.
 *
 * Thin transport adapter: resolve route -> read/validate body -> call Manager
 * -> serialize Protocol response. No game rules, persistence, or transport-shaped
 * Manager calls.
 */
export function createRequestListener(deps: RouterDependencies): RequestListener {
  return (request, response) => {
    // A client may abort at any time. Observe stream errors so an `error` event
    // with no listener can never surface as an uncaught exception.
    request.on('aborted', () => {
      // Once the response is finalized the abort is the expected consequence of
      // our own oversized-body teardown, not a client failure.
      if (response.writableEnded) {
        return;
      }
      // Closing an event stream is the normal end of `GET STREAM_PATH`, not an
      // exceptional abort: teardown is owned by the stream's own disconnect
      // handler, so there is nothing to warn about and no one to warn for.
      if (isEventStreamResponse(response)) {
        return;
      }
      // A genuinely exceptional abort on an ordinary request (e.g. the peer
      // vanished mid-response) still deserves a warning.
      console.warn('[router] client aborted the request');
    });
    response.on('error', (error: Error) => {
      console.error('[router] response stream error:', error);
    });

    // `handleRequest` absorbs its own failures, but a rejected promise here
    // would be discarded (fire-and-forget) and terminate the process on modern
    // Node. Catch explicitly so no rejection can escape.
    void handleRequest(deps, request, response).catch((error: unknown) => {
      console.error('[router] unhandled failure while serving request:', error);
    });
  };
}
