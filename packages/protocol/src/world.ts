import { ProtocolParseError } from './errors.ts';
import { isEntityState } from './entity.ts';
import type { EntityState } from './entity.ts';
import { isActorId } from './identity.ts';
import type { ActorId } from './identity.ts';
import { hasExactKeys, isFiniteInteger, isIsoUtcString, isRecord } from './internal.ts';

/** World dimensions in tiles. Positive integers. */
export interface WorldSize {
  width: number;
  height: number;
}

/**
 * Point-in-time authoritative world and caller view.
 *
 * The snapshot is the **full state**: `entities` is the complete list of known
 * world objects. `controlledActorId` states which actor the caller controls
 * (`null` when the caller controls nothing), replacing the phase-3 single-actor
 * assumption. Future world data is added as further fields of this snapshot.
 */
export interface WorldSnapshot {
  size: WorldSize;
  entities: EntityState[];
  controlledActorId: ActorId | null;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `WORLD_PATH`. */
export interface GetWorldResponse {
  world: WorldSnapshot;
}

const WORLD_SIZE_KEYS = ['width', 'height'] as const;
const WORLD_SNAPSHOT_KEYS = ['size', 'entities', 'controlledActorId', 'serverTime'] as const;
const GET_WORLD_RESPONSE_KEYS = ['world'] as const;

/**
 * Structural guard for `WorldSize`.
 *
 * `width`/`height` must be positive finite integers; zero or negative dimensions
 * are meaningless contract values and are rejected as a cross-boundary invariant.
 */
export function isWorldSize(value: unknown): value is WorldSize {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SIZE_KEYS)) {
    return false;
  }
  return (
    isFiniteInteger(value.width) &&
    value.width > 0 &&
    isFiniteInteger(value.height) &&
    value.height > 0
  );
}

/** Parse and validate `WorldSize`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldSize(value: unknown): WorldSize {
  if (!isWorldSize(value)) {
    throw new ProtocolParseError('Invalid WorldSize payload');
  }
  return value;
}

/** Structural guard for `WorldSnapshot`. */
export function isWorldSnapshot(value: unknown): value is WorldSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SNAPSHOT_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.entities)) {
    return false;
  }
  return (
    isWorldSize(value.size) &&
    value.entities.every((entity) => isEntityState(entity)) &&
    (value.controlledActorId === null || isActorId(value.controlledActorId)) &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `WorldSnapshot`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldSnapshot(value: unknown): WorldSnapshot {
  if (!isWorldSnapshot(value)) {
    throw new ProtocolParseError('Invalid WorldSnapshot payload');
  }
  return value;
}

/** Structural guard for `GetWorldResponse` (exactly `{ world }`). */
export function isGetWorldResponse(value: unknown): value is GetWorldResponse {
  return (
    isRecord(value) && hasExactKeys(value, GET_WORLD_RESPONSE_KEYS) && isWorldSnapshot(value.world)
  );
}

/** Parse and validate `GetWorldResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseGetWorldResponse(value: unknown): GetWorldResponse {
  if (!isGetWorldResponse(value)) {
    throw new ProtocolParseError('Invalid GetWorldResponse payload');
  }
  return value;
}
