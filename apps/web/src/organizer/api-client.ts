/**
 * Transport adapter for the `GET /api/game-info` Protocol endpoint.
 *
 * This module is the *only* place in the client that knows about HTTP for game
 * info. It hides `fetch`, `Response`, status codes, and JSON parsing behind a
 * typed function that either resolves a validated Protocol `GameInfo` or throws
 * an internal `GameInfoApiError` carrying a coarse failure kind. The store maps
 * that kind to a user-presentable message, so no transport detail reaches the UI.
 *
 * The generic request/error mechanics live in `transport.ts`; this file keeps its
 * own injectable fetch implementation so game info and the world never interfere
 * with each other's test hooks.
 */

import { GAME_INFO_PATH, parseGetGameInfoResponse } from '@starvalley/protocol';
import type { GetGameInfoResponse } from '@starvalley/protocol';

import { defaultFetch, parseContract, requestJson, resolveApiUrl } from './transport';
import type { FetchLike } from './transport';

// Re-exported under the historical names so existing internal imports (the
// game-info store) keep working unchanged.
export { ApiError as GameInfoApiError } from './transport';
export type { ApiErrorKind as GameInfoApiErrorKind, FetchLike } from './transport';

/** Origin-relative URL for the game-info endpoint. */
export function resolveGameInfoUrl(): string {
  return resolveApiUrl(GAME_INFO_PATH);
}

let fetchImpl: FetchLike = defaultFetch;

/** Inject a fetch implementation for tests. Internal/test-only. */
export function setGameInfoFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

/** Restore the default (global) fetch implementation. Internal/test-only. */
export function resetGameInfoFetch(): void {
  fetchImpl = defaultFetch;
}

/**
 * Fetch and validate game info plus its static presentation catalogues.
 *
 * Resolves the whole validated `GetGameInfoResponse` (`gameInfo` + `blockKinds`
 * + `entityKinds`), never the raw response: the catalogues travel with the same
 * payload and are validated by the same canonical guard. Rejects only with
 * `GameInfoApiError` so the caller can classify the failure.
 */
export async function fetchGameInfo(): Promise<GetGameInfoResponse> {
  const payload = await requestJson(fetchImpl, resolveGameInfoUrl(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  return parseContract(
    payload,
    (value) => parseGetGameInfoResponse(value),
    'Game server response did not match the protocol.',
  );
}
