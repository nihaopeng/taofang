import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { ProtocolErrorCode } from '@starvalley/protocol';
import type { GameInfoManager } from '@starvalley/manager';
import { mapErrorCodeToStatus, protocolErrorBody } from './http-errors.ts';
import { allowedMethods, findRoute, isKnownPath } from './routes.ts';

/** Typed collaborators the Router layer needs from the application. */
export interface RouterDependencies {
  readonly gameInfo: GameInfoManager;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', JSON_CONTENT_TYPE);
  // `ServerResponse` suppresses the body for HEAD/204/304; the payload is still
  // serialized so HEAD responses advertise the same representation.
  response.end(JSON.stringify(body));
}

function sendProtocolError(
  response: ServerResponse,
  code: ProtocolErrorCode,
  message: string,
): void {
  sendJson(response, mapErrorCodeToStatus(code), protocolErrorBody(code, message));
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

    const result = await route.handle({ gameInfo: deps.gameInfo, url });
    sendJson(response, result.status, result.body);
  } catch (error) {
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
 * Thin transport adapter: resolve route -> call Manager -> serialize Protocol
 * response. No game rules, persistence, or transport-shaped Manager calls.
 */
export function createRequestListener(deps: RouterDependencies): RequestListener {
  return (request, response) => {
    void handleRequest(deps, request, response);
  };
}
