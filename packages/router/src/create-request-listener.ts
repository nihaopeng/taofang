import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ProtocolParseError } from '@starvalley/protocol';
import type { ProtocolErrorCode } from '@starvalley/protocol';
import { UnknownPlayerError } from '@starvalley/manager';
import type { GameInfoManager, WorldManager } from '@starvalley/manager';
import { mapErrorCodeToStatus, protocolErrorBody } from './http-errors.ts';
import { allowedMethods, findRoute, isKnownPath } from './routes.ts';

/** Typed collaborators the Router layer needs from the application. */
export interface RouterDependencies {
  readonly gameInfo: GameInfoManager;
  readonly world: WorldManager;
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
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', JSON_CONTENT_TYPE);
  // Advertise the exact length so GET and HEAD agree on the representation.
  // `ServerResponse` suppresses the body for HEAD/204/304 while keeping this
  // header (and the status/content-type) intact.
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
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

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
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
    const result = await route.handle({
      gameInfo: deps.gameInfo,
      world: deps.world,
      url,
      body,
    });
    sendJson(response, result.status, result.body);
  } catch (error) {
    if (error instanceof BodyReadError) {
      sendProtocolError(response, 'BAD_REQUEST', error.message);
      if (error.reason === 'too-large') {
        // Stop the peer from streaming the rest of an unbounded payload.
        request.destroy();
      }
      return;
    }
    if (error instanceof ProtocolParseError) {
      // A bad command body is a client error, not a server failure.
      sendProtocolError(response, error.code, error.message);
      return;
    }
    if (error instanceof UnknownPlayerError) {
      sendProtocolError(response, 'NOT_FOUND', `Unknown player: ${error.playerId}`);
      return;
    }
    // Log server-side; never leak the message/stack to the client.
    console.error('[router] unhandled error while serving request:', error);
    if (response.headersSent) {
      response.end();
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
    void handleRequest(deps, request, response);
  };
}
