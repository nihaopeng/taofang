import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ProtocolParseError } from '@starvalley/protocol';
import type { ActorId, ProtocolErrorCode } from '@starvalley/protocol';
import { UnknownActorError } from '@starvalley/manager';
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

/** Typed collaborators the Router layer needs from the application. */
export interface RouterDependencies {
  readonly gameInfo: GameInfoManager;
  readonly world: WorldManager;
  readonly resolveActorId: ResolveActorId;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Hard cap on a request body; anything larger is rejected with BAD_REQUEST. */
const MAX_BODY_BYTES = 64 * 1024;

/** Methods that may carry a body; anything else gets `body === undefined`. */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

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

    const route = findRoute(url.pathname, method);
    if (route === undefined) {
      response.setHeader('Allow', allowedMethods(url.pathname).join(', '));
      sendProtocolError(response, 'METHOD_NOT_ALLOWED', `Method ${method} not allowed`);
      return;
    }

    const body = await readRequestBody(request, method);
    // Resolve the caller identity exactly once per request, from transport
    // context (never the body), then pass it as typed context to the handler.
    const actorId = await deps.resolveActorId(request);
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
      if (!response.writableEnded) {
        console.warn('[router] client aborted the request');
      }
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
