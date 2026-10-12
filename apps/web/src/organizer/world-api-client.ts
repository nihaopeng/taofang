/**
 * Transport adapter for the Phase-7 primitive world endpoints:
 *
 * - `GET  /api/world`   -> `GetWorldResponse` (full authoritative snapshot)
 * - `POST /api/command` -> `GameEventBatch`    (authoritative event delta / ack)
 *
 * As with `api-client.ts`, this is the only place in the world feature that knows
 * about HTTP. Payloads are decoded by `transport.requestJson` and then validated
 * with the canonical Protocol guards (`parseGetWorldResponse`,
 * `parseGameEventBatch`). Failures surface only as `ApiError`, which the world
 * store reduces to a user-presentable string.
 *
 * The command deliberately carries **no actor id**: the actor is resolved by
 * Router from transport context. This adapter serialises the caller-supplied
 * canonical `MoveIntentCommand` verbatim and never adds a wire field.
 *
 * The injectable fetch implementation is per-resource: `setWorldFetch` does not
 * affect the game-info client and vice versa. The realtime stream has its own
 * injectable factory (`world-stream.setWorldEventSource`).
 */

import {
  COMMAND_PATH,
  WORLD_PATH,
  parseGameEventBatch,
  parseGetWorldResponse,
} from '@starvalley/protocol';
import type { GameEventBatch, MoveIntentCommand, WorldSnapshot } from '@starvalley/protocol';

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

/** Origin-relative URL for the command endpoint. */
export function resolveCommandUrl(): string {
  return resolveApiUrl(COMMAND_PATH);
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
 * Send a movement intent and validate the authoritative event delta.
 *
 * The command is built by the store from the requested `{ x, z }` movement only;
 * the actor is resolved server-side from transport context, so this adapter must
 * not add an actor/player field, and the client never sends a position. Resolves
 * the Protocol `GameEventBatch` (not the raw response). Rejects only with
 * `ApiError`.
 */
export async function submitCommand(command: MoveIntentCommand): Promise<GameEventBatch> {
  const payload = await requestJson(fetchImpl, resolveCommandUrl(), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });

  return parseContract(
    payload,
    (value) => parseGameEventBatch(value),
    'Game server response did not match the command protocol.',
  );
}
