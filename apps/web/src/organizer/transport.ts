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

/** Injectable fetch shape. Must mirror the subset of `fetch` this layer uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Coarse failure classification used to produce a stable user message. */
export type ApiErrorKind = 'network' | 'status' | 'contract';

/**
 * Internal error type. Never part of the UI API - stores convert it into a plain
 * user-facing string via `describeApiError`.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Origin-relative URL. Resolves a Protocol path, optionally prefixed by
 * `VITE_API_BASE_URL` when configured. No host is hardcoded; in development the
 * Vite proxy forwards `/api` to the backend (see `apps/web/vite.config.ts`).
 */
export function resolveApiUrl(path: string): string {
  const raw: unknown = import.meta.env.VITE_API_BASE_URL;
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
 * - `status` when the response is not `ok` (carries `status`),
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
    throw new ApiError(
      'status',
      `Game server responded with HTTP ${response.status}.`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError('contract', 'Game server response body was not valid JSON.');
  }
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
