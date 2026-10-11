import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isFiniteInteger, isIsoUtcString, isNonEmptyString, isRecord } from './internal.ts';

/** Stable identifier for a player. Non-empty string. */
export type PlayerId = string;

/**
 * Integer tile coordinates. Origin is TOP-LEFT: `x` grows east, `y` grows south.
 *
 * No sign or bounds constraint: world-bounds validity is a Manager runtime rule,
 * not a wire invariant.
 */
export interface Position {
  x: number;
  y: number;
}

/** World dimensions in tiles. Positive integers. */
export interface WorldSize {
  width: number;
  height: number;
}

/** A player as exposed on the wire, carrying the authoritative server position. */
export interface Player {
  id: PlayerId;
  name: string;
  position: Position;
}

/**
 * Point-in-time authoritative world and local-player view.
 *
 * `size` carries the world's dimensions directly. Future world data (tiles,
 * objects, NPCs) is added as further fields of this snapshot rather than as
 * another nesting level.
 */
export interface WorldSnapshot {
  size: WorldSize;
  player: Player;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `WORLD_PATH`. */
export interface GetWorldResponse {
  world: WorldSnapshot;
}

const POSITION_KEYS = ['x', 'y'] as const;
const WORLD_SIZE_KEYS = ['width', 'height'] as const;
const PLAYER_KEYS = ['id', 'name', 'position'] as const;
const WORLD_SNAPSHOT_KEYS = ['size', 'player', 'serverTime'] as const;
const GET_WORLD_RESPONSE_KEYS = ['world'] as const;

/**
 * Structural guard for `Position`.
 *
 * `x`/`y` must be finite integers of any sign. In-bounds validation is Manager's
 * runtime concern, so negative coordinates are accepted here.
 */
export function isPosition(value: unknown): value is Position {
  if (!isRecord(value) || !hasExactKeys(value, POSITION_KEYS)) {
    return false;
  }
  return isFiniteInteger(value.x) && isFiniteInteger(value.y);
}

/** Parse and validate `Position`, throwing `ProtocolParseError` on mismatch. */
export function parsePosition(value: unknown): Position {
  if (!isPosition(value)) {
    throw new ProtocolParseError('Invalid Position payload');
  }
  return value;
}

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

/**
 * Structural guard for `Player`.
 *
 * `id` must be a non-empty string; `name` may be any string, including empty.
 */
export function isPlayer(value: unknown): value is Player {
  if (!isRecord(value) || !hasExactKeys(value, PLAYER_KEYS)) {
    return false;
  }
  return isNonEmptyString(value.id) && typeof value.name === 'string' && isPosition(value.position);
}

/** Parse and validate `Player`, throwing `ProtocolParseError` on mismatch. */
export function parsePlayer(value: unknown): Player {
  if (!isPlayer(value)) {
    throw new ProtocolParseError('Invalid Player payload');
  }
  return value;
}

/** Structural guard for `WorldSnapshot`. */
export function isWorldSnapshot(value: unknown): value is WorldSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SNAPSHOT_KEYS)) {
    return false;
  }
  return isWorldSize(value.size) && isPlayer(value.player) && isIsoUtcString(value.serverTime);
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
