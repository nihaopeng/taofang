/**
 * Transport adapter for the `GET /api/game-info` Protocol endpoint.
 *
 * This module is the *only* place in the client that knows about HTTP. It hides
 * `fetch`, `Response`, status codes, and JSON parsing behind a typed function
 * that either resolves a validated Protocol `GameInfo` or throws an internal
 * `GameInfoApiError` carrying a coarse failure kind. The store maps that kind to
 * a user-presentable message, so no transport detail reaches the UI.
 */

import {
  GAME_INFO_PATH,
  ProtocolParseError,
  parseGetGameInfoResponse,
} from '@starvalley/protocol';
import type { GameInfo } from '@starvalley/protocol';

/** Injectable fetch shape. Must mirror the subset of `fetch` this client uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Coarse failure classification used to produce a stable user message. */
export type GameInfoApiErrorKind = 'network' | 'status' | 'contract';

/**
 * Internal error type. Never exported as part of the UI API - the store converts
 * it into a plain user-facing string.
 */
export class GameInfoApiError extends Error {
  readonly kind: GameInfoApiErrorKind;
  readonly status: number | undefined;

  constructor(kind: GameInfoApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GameInfoApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Origin-relative target. Resolves the Protocol path, optionally prefixed by
 * `VITE_API_BASE_URL` when configured. No host is hardcoded; in development the
 * Vite proxy forwards `/api` to the backend (see `apps/web/vite.config.ts`).
 */
export function resolveGameInfoUrl(): string {
  const raw: unknown = import.meta.env.VITE_API_BASE_URL;
  const base = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  return base.length > 0 ? `${base}${GAME_INFO_PATH}` : GAME_INFO_PATH;
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const globalFetch: typeof fetch | undefined = globalThis.fetch;
  if (typeof globalFetch !== 'function') {
    return Promise.reject(
      new GameInfoApiError('network', 'Global fetch is not available in this environment.'),
    );
  }
  return globalFetch(input, init);
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
 * Fetch and validate game info.
 *
 * Resolves the Protocol `GameInfo` (not the envelope, never the raw response).
 * Rejects only with `GameInfoApiError` so the caller can classify the failure.
 */
export async function fetchGameInfo(): Promise<GameInfo> {
  let response: Response;
  try {
    response = await fetchImpl(resolveGameInfoUrl(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new GameInfoApiError('network', 'Game server request could not be completed.');
  }

  if (!response.ok) {
    throw new GameInfoApiError(
      'status',
      `Game server responded with HTTP ${response.status}.`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GameInfoApiError('contract', 'Game server response body was not valid JSON.');
  }

  try {
    return parseGetGameInfoResponse(payload).gameInfo;
  } catch (error) {
    if (error instanceof ProtocolParseError) {
      throw new GameInfoApiError('contract', 'Game server response did not match the protocol.');
    }
    throw new GameInfoApiError('contract', 'Game server response could not be parsed.');
  }
}
