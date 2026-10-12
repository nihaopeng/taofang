import { ProtocolParseError } from './errors.ts';
import { isEntityState } from './entity.ts';
import type { EntityState } from './entity.ts';
import { isActorId, isWorldId } from './identity.ts';
import type { ActorId, WorldId } from './identity.ts';
import {
  hasExactKeys,
  isFiniteInteger,
  isIsoUtcString,
  isPositiveFiniteNumber,
  isRecord,
} from './internal.ts';
import { isVec3 } from './math.ts';
import type { Vec3 } from './math.ts';

/**
 * The world's AABB-shaped extent, in continuous world units. This is the
 * world's definition; a tile count (`WorldSize`) was deleted in phase 7 because
 * a count is not a world definition.
 */
export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

/**
 * The gameplay grid: a discrete interaction layer **overlaid** on the continuous
 * 3D world (farming, placement, interaction, terrain metadata). It is NOT the
 * Actor's motion coordinate system.
 *
 * `origin` is the grid's minimum corner, and `cell(0, 0)` is deliberately NOT
 * bound to the world origin. The grid's cell centres are derived (frozen rule,
 * identical on both sides):
 *
 * ```text
 * cellCentre.x = origin.x + (cell.x + 0.5) * cellSize
 * cellCentre.z = origin.z + (cell.z + 0.5) * cellSize
 * cellCentre.y = origin.y
 * ```
 *
 * `cellSize` stays grid configuration and must not be hardcoded in algorithms.
 */
export interface GridSpec {
  origin: Vec3;
  width: number;
  depth: number;
  cellSize: number;
}

/** Integer cell indices on the ground plane. The grid holds no world position. */
export interface CellCoord {
  x: number;
  z: number;
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
 * Static terrain of one grid cell. Holds a `CellCoord`, **never a `Transform`**:
 * the grid is an interaction layer and holds no position. A cell's world-space
 * centre is derived from the `GridSpec` (see `GridSpec` for the frozen rule).
 */
export interface TileState {
  cell: CellCoord;
  terrain: TerrainKind;
}

/**
 * Point-in-time authoritative world and caller view.
 *
 * The snapshot is the **full state**: `bounds` and `grid` define the world and
 * its interaction layer, `tiles` is the static terrain of the grid's cells, and
 * `entities` is the complete list of dynamic world objects (each with a real 3D
 * `Transform`). `controlledActorId` states which actor the caller controls
 * (`null` when the caller controls nothing). `worldId` scopes the snapshot to
 * one world, so "which world is the actor in" needs no per-entity field.
 */
export interface WorldSnapshot {
  worldId: WorldId;
  bounds: WorldBounds;
  grid: GridSpec;
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

const WORLD_BOUNDS_KEYS = ['min', 'max'] as const;
const GRID_SPEC_KEYS = ['origin', 'width', 'depth', 'cellSize'] as const;
const CELL_COORD_KEYS = ['x', 'z'] as const;
const TILE_STATE_KEYS = ['cell', 'terrain'] as const;
const WORLD_SNAPSHOT_KEYS = [
  'worldId',
  'bounds',
  'grid',
  'tiles',
  'entities',
  'controlledActorId',
  'serverTime',
] as const;
const GET_WORLD_RESPONSE_KEYS = ['world'] as const;

/** Structural guard for `WorldBounds` (exactly `{ min, max }`, both finite `Vec3`). */
export function isWorldBounds(value: unknown): value is WorldBounds {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_BOUNDS_KEYS)) {
    return false;
  }
  return isVec3(value.min) && isVec3(value.max);
}

/** Parse and validate `WorldBounds`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldBounds(value: unknown): WorldBounds {
  if (!isWorldBounds(value)) {
    throw new ProtocolParseError('Invalid WorldBounds payload');
  }
  return value;
}

/**
 * Structural guard for `GridSpec` (exactly `{ origin, width, depth, cellSize }`).
 * `origin` is a finite `Vec3`; `width`, `depth`, and `cellSize` must be finite
 * and strictly positive. They are counts/units, not necessarily integers, so
 * fractional cell sizes are accepted.
 */
export function isGridSpec(value: unknown): value is GridSpec {
  if (!isRecord(value) || !hasExactKeys(value, GRID_SPEC_KEYS)) {
    return false;
  }
  return (
    isVec3(value.origin) &&
    isPositiveFiniteNumber(value.width) &&
    isPositiveFiniteNumber(value.depth) &&
    isPositiveFiniteNumber(value.cellSize)
  );
}

/** Parse and validate `GridSpec`, throwing `ProtocolParseError` on mismatch. */
export function parseGridSpec(value: unknown): GridSpec {
  if (!isGridSpec(value)) {
    throw new ProtocolParseError('Invalid GridSpec payload');
  }
  return value;
}

/** Structural guard for `CellCoord` (exactly `{ x, z }`, both finite integers). */
export function isCellCoord(value: unknown): value is CellCoord {
  if (!isRecord(value) || !hasExactKeys(value, CELL_COORD_KEYS)) {
    return false;
  }
  return isFiniteInteger(value.x) && isFiniteInteger(value.z);
}

/** Parse and validate `CellCoord`, throwing `ProtocolParseError` on mismatch. */
export function parseCellCoord(value: unknown): CellCoord {
  if (!isCellCoord(value)) {
    throw new ProtocolParseError('Invalid CellCoord payload');
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

/**
 * Structural guard for `TileState` (exactly `{ cell, terrain }`).
 *
 * A `transform` key is rejected: the grid holds no position. This is the
 * guard that prevents the phase-7 modelling error from creeping back in.
 */
export function isTileState(value: unknown): value is TileState {
  if (!isRecord(value) || !hasExactKeys(value, TILE_STATE_KEYS)) {
    return false;
  }
  return isCellCoord(value.cell) && isTerrainKind(value.terrain);
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
    isWorldBounds(value.bounds) &&
    isGridSpec(value.grid) &&
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
