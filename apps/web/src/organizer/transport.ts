/**
 * Shared HTTP mechanics for Organizer API clients.
 *
 * This is the only layer in the client that knows about `fetch`, `Response`,
 * HTTP status codes, and JSON decoding. Each resource client (`api-client` for
 * game info, `world-api-client` for the world) keeps its *own* injectable fetch
 * implementation so the two resources' test hooks remain independent, but they
 * share the request/error-classification code below instead of duplicating it.
 *
 * Nothing here is exported from `organizer/index.ts`: raw responses and internal
 * error objects never cross the Organizer/UI boundary.
 */

import type { ProtocolErrorCode } from '@starvalley/protocol';

/** Injectable fetch shape. Must mirror the subset of `fetch` this layer uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Coarse failure classification used to produce a stable user message. */
export type ApiErrorKind = 'network' | 'status' | 'contract';

/**
 * Internal error type. Never part of the UI API - stores convert it into a plain
 * user-facing string via `describeApiError`.
 *
 * A failed status response additionally carries the canonical `ProtocolError`
 * fields parsed from the error body (`code`/`serverMessage`). These are the
 * *machine-readable* reason plus the server-authored short phrase; the store -
 * not this layer - decides which one a user sees. The raw body never escapes.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** Canonical `ProtocolError.code` from the error body, when it parsed. */
  readonly code: ProtocolErrorCode | undefined;
  /** Canonical `ProtocolError.message` (server-authored), when it parsed. */
  readonly serverMessage: string | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    protocolError?: { code: ProtocolErrorCode | undefined; message: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = protocolError?.code;
    this.serverMessage = protocolError?.message;
  }
}

/**
 * Origin-relative URL. Resolves a Protocol path, optionally prefixed by
 * `VITE_API_BASE_URL` when configured. No host is hardcoded; in development the
 * Vite proxy forwards `/api` to the backend (see `apps/web/vite.config.ts`).
 */
export function resolveApiUrl(path: string): string {
  // Guard the *container* as well as the value: in a non-Vite loader
  // `import.meta.env` is `undefined`, and the property access itself would throw
  // before `typeof raw === 'string'` could run. Vite statically inlines
  // `import.meta.env`, so this is a no-op in the shipped build.
  const raw = (import.meta.env as Record<string, unknown> | undefined)?.VITE_API_BASE_URL;
  const base = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  return base.length > 0 ? `${base}${path}` : path;
}

/** Default fetch implementation backed by the global `fetch` (when present). */
export function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const globalFetch: typeof fetch | undefined = globalThis.fetch;
  if (typeof globalFetch !== 'function') {
    return Promise.reject(
      new ApiError('network', 'Global fetch is not available in this environment.'),
    );
  }
  return globalFetch(input, init);
}

/**
 * Perform a request and decode its JSON body.
 *
 * Rejects only with `ApiError`, classifying the failure as:
 * - `network` when `fetch` itself rejects,
 * - `status` when the response is not `ok` (carries `status`, plus the parsed
 *   canonical `ProtocolError` `code`/`message` when the body supplied one),
 * - `contract` when the body is not valid JSON.
 *
 * Returns the raw `unknown` JSON value; callers must run it through the
 * canonical Protocol guard for the endpoint.
 */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new ApiError('network', 'Game server request could not be completed.');
  }

  if (!response.ok) {
    const status = response.status;
    // Best-effort: a missing/unparseable/foreign error body must never turn a
    // status failure into a throw from the error path itself.
    const protocolError = await readProtocolError(response);
    throw new ApiError(
      'status',
      `Game server responded with HTTP ${status}.`,
      status,
      protocolError ?? undefined,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError('contract', 'Game server response body was not valid JSON.');
  }
}

/**
 * Best-effort read of the canonical `ProtocolError` body (`{ error: { code,
 * message } }`) from a failed response. Returns `null` - never throws - when the
 * body is absent, unparseable, or carries no string `message`, so the caller
 * falls back to a status-derived message. An unrecognised `code` is dropped to
 * `undefined` (the message is still kept) so a newer server code degrades
 * gracefully instead of losing the user-facing reason.
 */
async function readProtocolError(
  response: Response,
): Promise<{ code: ProtocolErrorCode | undefined; message: string } | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return null;
  }
  return { code: isProtocolErrorCode(code) ? code : undefined, message };
}

/** Canonical `ProtocolErrorCode` vocabulary this build understands. */
const PROTOCOL_ERROR_CODES: readonly ProtocolErrorCode[] = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'INTERNAL_ERROR',
];

/** Narrow an untrusted value to the canonical `ProtocolErrorCode` union. */
function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Run a Protocol `parse*` guard over a decoded payload, converting any failure
 * into an `ApiError` of kind `contract`. This keeps `ProtocolParseError` (and any
 * other parser detail) from leaking out of the Organizer boundary.
 */
export function parseContract<T>(
  payload: unknown,
  parse: (value: unknown) => T,
  message: string,
): T {
  try {
    return parse(payload);
  } catch {
    throw new ApiError('contract', message);
  }
}

/** Map an internal transport failure to a short, user-presentable message. */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'network':
        return 'Could not reach the game server. Check your connection and try again.';
      case 'status':
        return `The game server returned an error (HTTP ${error.status ?? 'unknown'}).`;
      case 'contract':
        return 'The game server sent an unexpected response.';
    }
  }
  return fallback;
}
