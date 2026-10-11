/**
 * Transport adapter for the Phase-2 world endpoints:
 *
 * - `GET  /api/world`         -> `GetWorldResponse`
 * - `POST /api/player/move`   -> `MovePlayerResponse`
 *
 * As with `api-client.ts`, this is the only place in the world feature that knows
 * about HTTP. Payloads are decoded by `transport.requestJson` and then validated
 * with the canonical Protocol guards (`parseGetWorldResponse`,
 * `parseMovePlayerResponse`). Failures surface only as `ApiError`, which the world
 * store reduces to a user-presentable string.
 *
 * The injectable fetch implementation is per-resource: `setWorldFetch` does not
 * affect the game-info client and vice versa.
 */

import {
  PLAYER_MOVE_PATH,
  WORLD_PATH,
  parseGetWorldResponse,
  parseMovePlayerResponse,
} from '@starvalley/protocol';
import type { MovePlayerCommand, MovePlayerResult, WorldSnapshot } from '@starvalley/protocol';

import { defaultFetch, parseContract, requestJson, resolveApiUrl } from './transport';
import type { FetchLike } from './transport';

let fetchImpl: FetchLike = defaultFetch;

/** Inject a fetch implementation for tests. Internal/test-only. */
export function setWorldFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

/** Restore the default (global) fetch implementation. Internal/test-only. */
export function resetWorldFetch(): void {
  fetchImpl = defaultFetch;
}

/** Origin-relative URL for the world snapshot endpoint. */
export function resolveWorldUrl(): string {
  return resolveApiUrl(WORLD_PATH);
}

/** Origin-relative URL for the player move command endpoint. */
export function resolvePlayerMoveUrl(): string {
  return resolveApiUrl(PLAYER_MOVE_PATH);
}

/**
 * Fetch and validate the authoritative world snapshot.
 *
 * Resolves the Protocol `WorldSnapshot` (not the envelope, never the raw
 * response). Rejects only with `ApiError`.
 */
export async function fetchWorld(): Promise<WorldSnapshot> {
  const payload = await requestJson(fetchImpl, resolveWorldUrl(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  return parseContract(
    payload,
    (value) => parseGetWorldResponse(value).world,
    'Game server response did not match the world protocol.',
  );
}

/**
 * Send a movement command and validate its result.
 *
 * The command is built by the store from the authoritative snapshot; no wire
 * field is invented here. Resolves the Protocol `MovePlayerResult` (not the
 * envelope). Rejects only with `ApiError`.
 */
export async function requestMovePlayer(command: MovePlayerCommand): Promise<MovePlayerResult> {
  const payload = await requestJson(fetchImpl, resolvePlayerMoveUrl(), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });

  return parseContract(
    payload,
    (value) => parseMovePlayerResponse(value).result,
    'Game server response did not match the movement protocol.',
  );
}
