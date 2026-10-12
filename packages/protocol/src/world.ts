import { ProtocolParseError } from './errors.ts';
import { isEntityState, isTransform } from './entity.ts';
import type { EntityState, Transform } from './entity.ts';
import { isActorId, isWorldId } from './identity.ts';
import type { ActorId, WorldId } from './identity.ts';
import { hasExactKeys, isFiniteInteger, isIsoUtcString, isRecord } from './internal.ts';

/** World dimensions in tiles. Positive integers. */
export interface WorldSize {
  width: number;
  height: number;
}

/**
 * Closed union of terrain kinds: `'grass' | 'path' | 'blocked' | 'water'`.
 * `'path'` is walkable but visually different from `'grass'`; `'water'` is a
 * distinct ground kind so the presenter can tell it apart from generic
 * impassability. Whether a kind is walkable is deliberately **not** on the
 * wire — it is a Manager runtime rule (`WALKABILITY_BY_TERRAIN`). Adding a kind
 * is a breaking wire change because `TileState` guards keys exactly.
 *
 * Modelling note: `'blocked'` is really a *property* (impassable), not a ground
 * kind; when real terrain art lands, prefer concrete kinds (`'rock'`) over a
 * generic `'blocked'`.
 */
export type TerrainKind = 'grass' | 'path' | 'blocked' | 'water';

/**
 * Static terrain of one tile. Reuses the canonical `Transform` (do not
 * reintroduce a separate position type).
 */
export interface TileState {
  transform: Transform;
  terrain: TerrainKind;
}

/**
 * Point-in-time authoritative world and caller view.
 *
 * The snapshot is the **full state**: `tiles` is the static terrain of the
 * world's shape and `entities` is the complete list of dynamic world objects.
 * `controlledActorId` states which actor the caller controls (`null` when the
 * caller controls nothing). `worldId` scopes the snapshot to one world, so
 * "which world is the actor in" needs no per-entity field.
 */
export interface WorldSnapshot {
  worldId: WorldId;
  size: WorldSize;
  tiles: TileState[];
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
const TILE_STATE_KEYS = ['transform', 'terrain'] as const;
const WORLD_SNAPSHOT_KEYS = [
  'worldId',
  'size',
  'tiles',
  'entities',
  'controlledActorId',
  'serverTime',
] as const;
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

/**
 * Structural guard for `TerrainKind`
 * (exactly `'grass' | 'path' | 'blocked' | 'water'`).
 */
export function isTerrainKind(value: unknown): value is TerrainKind {
  return value === 'grass' || value === 'path' || value === 'blocked' || value === 'water';
}

/** Parse and validate `TerrainKind`, throwing `ProtocolParseError` on mismatch. */
export function parseTerrainKind(value: unknown): TerrainKind {
  if (!isTerrainKind(value)) {
    throw new ProtocolParseError('Invalid TerrainKind payload');
  }
  return value;
}

/** Structural guard for `TileState` (exactly `{ transform, terrain }`). */
export function isTileState(value: unknown): value is TileState {
  if (!isRecord(value) || !hasExactKeys(value, TILE_STATE_KEYS)) {
    return false;
  }
  return isTransform(value.transform) && isTerrainKind(value.terrain);
}

/** Parse and validate `TileState`, throwing `ProtocolParseError` on mismatch. */
export function parseTileState(value: unknown): TileState {
  if (!isTileState(value)) {
    throw new ProtocolParseError('Invalid TileState payload');
  }
  return value;
}

/** Structural guard for `WorldSnapshot`. */
export function isWorldSnapshot(value: unknown): value is WorldSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SNAPSHOT_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.tiles) || !Array.isArray(value.entities)) {
    return false;
  }
  return (
    isWorldId(value.worldId) &&
    isWorldSize(value.size) &&
    value.tiles.every((tile) => isTileState(tile)) &&
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
