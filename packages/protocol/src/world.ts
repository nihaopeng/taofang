import { ProtocolParseError } from './errors.ts';
import { isEntityState } from './entity.ts';
import type { EntityState } from './entity.ts';
import { isActorId, isColliderId, isSurfaceId, isWorldId } from './identity.ts';
import type { ActorId, ColliderId, SurfaceId, WorldId } from './identity.ts';
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
 *
 * The grid participates in **gameplay** (farming, placement, selection, terrain
 * metadata) only through the two pure helpers {@link cellCentre} (cell -> world
 * position) and {@link cellOf} (world position -> cell). Both directions are
 * canonical here so no consumer re-derives them independently, and neither may
 * ever be used as the Actor's stored position.
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
 * Closed union of surface kinds: `'ground' | 'platform' | 'ramp' |
 * 'bridge'`. A kind is a *game* label; what it looks like is decided by the
 * render bridge, exactly like `TerrainKind` and `EntityKind`.
 *
 * A kind does **not** imply traversability: whether an actor may traverse a
 * patch is the explicit `SurfaceState.walkable` flag. Adding a kind is a
 * breaking wire change because `SurfaceState` guards keys exactly.
 *
 * - `'ground'` — flat terrain support;
 * - `'platform'` — a raised flat deck at a different `y`;
 * - `'ramp'` — a tiltable planar patch used for stairs/slopes;
 * - `'bridge'` — a deck that may sit above another surface (e.g. a river bed).
 *
 * Adding a kind is a breaking wire change because `SurfaceState` guards keys
 * exactly.
 */
export type SurfaceKind = 'ground' | 'platform' | 'ramp' | 'bridge';

/**
 * One finite, oriented, **planar** patch of ground geometry in real 3D world
 * space.
 *
 * The patch is the parallelogram
 *
 * ```text
 * { center + u * axisU + v * axisV : -1 <= u <= 1, -1 <= v <= 1 }
 * ```
 *
 * which is a rectangle when `axisU` and `axisV` are perpendicular. `axisU` and
 * `axisV` are **half-edge vectors in world units** (not unit direction
 * vectors), so a 10x10 flat patch with an up-facing normal has, for example,
 * `axisU = (5, 0, 0)` and `axisV = (0, 0, -5)` (note the ordering: the plane
 * normal `normalize(axisU x axisV)` must point up). The two vectors must be
 * non-degenerate (non-parallel) to define a plane.
 *
 * `SurfaceState` is **geometry first**: being in `surfaces` means "a real
 * planar patch exists here", NOT "an actor may walk here". Walkability is
 * explicit traversal metadata (`walkable`) because there are legitimately
 * up-facing but NON-walkable surfaces — a too-steep slope, a roof, a special
 * material, or a decorative/rule-only surface. The contract must be able to
 * say "this is a real surface, you just may not traverse it", so a non-walkable
 * patch is still a real `SurfaceState` with `walkable: false`; it is not omitted
 * from `surfaces`.
 *
 * The GEOMETRIC legality constraint is `cross(axisU, axisV).y > 0`: the patch's
 * normal points up, making it a geometrically legal ground *candidate*. That is
 * a **geometric** constraint only, NOT a slope/traversability rule. The actual
 * passable-slope threshold, and any actor/material-specific traversal rule, is
 * a MANAGER runtime rule; it must never be derived from `normal.y > 0` here. No
 * slope limit, angle, or tolerance appears in the contract.
 *
 * `y` is a **real coordinate, never a level**: a flat ground and a platform are
 * the same shape at different `center.y`, and a ramp is the same shape tilted
 * (its `axisU`/`axisV` gain a `y` component). Defining the patch is geometry;
 * whether it may be traversed is `walkable`. Being in `colliders` (not here)
 * means a volume blocks movement.
 *
 * Surfaces are NOT the gameplay grid: they define where support exists in the
 * world. Many surfaces may overlap in `(x, z)` (a bridge deck over a river bed,
 * stacked floors, a cave floor beneath a ledge); selecting the support for a
 * given `(x, z, feetY)` is a runtime query, not a `SurfaceState` field.
 */
export interface SurfaceState {
  surfaceId: SurfaceId;
  kind: SurfaceKind;
  center: Vec3;
  axisU: Vec3;
  axisV: Vec3;
  /**
   * Explicit traversal metadata. `true` once the patch may be traversed (still
   * subject to the Manager's own slope/traversal rules), `false` when the patch
   * is real geometry that must not be traversed. Never derived from the
   * geometry; the Manager's support query filters on `walkable === true` first
   * and then applies its traversal rules.
   */
  walkable: boolean;
}

/**
 * Closed union of static collider kinds: `'wall' | 'rock' | 'water' |
 * 'structure'`. A kind is a *game* label; presentation is decided by the render
 * bridge. Adding a kind is a breaking wire change because `ColliderState`
 * guards keys exactly.
 */
export type ColliderKind = 'wall' | 'rock' | 'water' | 'structure';

/**
 * The geometry primitive of a `ColliderState`: a discriminated union on `kind`,
 * today with exactly ONE variant, `'aabb'`.
 *
 * The union exists so collider geometry is not conceptually frozen to min/max
 * AABBs: a future variant (e.g. `'sphere'` or `'obb'`) is an ADDITIVE union
 * member plus a new `switch` case in {@link isColliderShape}, not a redesign.
 * Do NOT add a variant speculatively.
 *
 * `shape.kind` is the **geometry primitive**. It is a different axis from
 * `ColliderState.kind`, which is the **gameplay vocabulary**
 * (`'wall'`/`'rock'`/`'water'`/`'structure'`). Neither implies the other: a
 * `'wall'` is not necessarily an `'aabb'` forever, and an `'aabb'` is not
 * necessarily a `'wall'`.
 *
 * The `'aabb'` variant keeps the strictly-positive-extent-on-every-axis rule
 * (`max.{x,y,z} > min.{x,y,z}`); the strict `y` check is what forbids an
 * "infinite ground-to-sky column".
 */
export type ColliderShape = {
  /** Geometry-primitive discriminator. Today the only member. */
  kind: 'aabb';
  min: Vec3;
  max: Vec3;
};

/**
 * One static blocking volume in real 3D world space. Its geometry is a
 * discriminated {@link ColliderShape}, not a hardcoded `min`/`max` pair, so the
 * model does not assume every collider is an AABB forever.
 *
 * `ColliderState.kind` is the gameplay label; `shape.kind` is the geometry
 * primitive. They are separate axes.
 *
 * Many colliders may overlap in `(x, z)` with different `y` ranges.
 */
export interface ColliderState {
  colliderId: ColliderId;
  kind: ColliderKind;
  shape: ColliderShape;
}

/**
 * Point-in-time authoritative world and caller view.
 *
 * The snapshot is the **full state** and is composed of three layers:
 *
 * 1. **World geometry** — `bounds`, `surfaces`, `colliders`. This is the
 *    movement truth: support patches (geometry; traversability is the explicit
 *    `SurfaceState.walkable` flag) live in `surfaces` and blockers in
 *    `colliders`, both in real 3D world space with genuine `y` ranges. No
 *    integer level/heightmap is involved.
 * 2. **Gameplay metadata** — `grid` and `tiles`. The discrete interaction
 *    layer (farming, placement, selection, terrain metadata). It holds no
 *    position and defines no geometry; it is NOT the source of truth for where
 *    a surface is.
 * 3. **Dynamic objects** — `entities`, each with a real 3D `Transform` whose
 *    `position.y` is authoritative. No field implies a fixed ground `y`.
 *
 * `controlledActorId` states which actor the caller controls (`null` when the
 * caller controls nothing). `worldId` scopes the snapshot to one world, so
 * "which world is the actor in" needs no per-entity field.
 */
export interface WorldSnapshot {
  worldId: WorldId;
  bounds: WorldBounds;
  grid: GridSpec;
  tiles: TileState[];
  /** Support patches (world geometry; `walkable` is explicit per patch). */
  surfaces: SurfaceState[];
  /** Static blocking volumes with genuine `y` ranges (world geometry). */
  colliders: ColliderState[];
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
const SURFACE_STATE_KEYS = ['surfaceId', 'kind', 'center', 'axisU', 'axisV', 'walkable'] as const;
const COLLIDER_STATE_KEYS = ['colliderId', 'kind', 'shape'] as const;
const AABB_COLLIDER_SHAPE_KEYS = ['kind', 'min', 'max'] as const;
const WORLD_SNAPSHOT_KEYS = [
  'worldId',
  'bounds',
  'grid',
  'tiles',
  'surfaces',
  'colliders',
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
 * A `transform` key is rejected: the grid holds no position. A `level` key is
 * rejected too: the gameplay grid must never carry an integer height/level (the
 * "one XZ = one integer height" model this contract exists to prevent).
 * Because keys are matched exactly, ANY extra key (including `level`) is a
 * rejection; the guard is the regression barrier for both mistakes.
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

/**
 * Structural guard for `SurfaceKind`
 * (exactly `'ground' | 'platform' | 'ramp' | 'bridge'`).
 */
export function isSurfaceKind(value: unknown): value is SurfaceKind {
  return value === 'ground' || value === 'platform' || value === 'ramp' || value === 'bridge';
}

/** Parse and validate `SurfaceKind`, throwing `ProtocolParseError` on mismatch. */
export function parseSurfaceKind(value: unknown): SurfaceKind {
  if (!isSurfaceKind(value)) {
    throw new ProtocolParseError('Invalid SurfaceKind payload');
  }
  return value;
}

/**
 * The `y` component of the plane normal `axisU x axisV`:
 * `axisU.z * axisV.x - axisU.x * axisV.z`.
 *
 * Used ONLY as a geometric ground-candidate constraint (`> 0` means the patch
 * faces up). It is NOT a slope/traversability rule: no slope threshold may be
 * derived from it here.
 */
function crossY(axisU: Vec3, axisV: Vec3): number {
  return axisU.z * axisV.x - axisU.x * axisV.z;
}

/**
 * Structural guard for `SurfaceState`
 * (exactly `{ surfaceId, kind, center, axisU, axisV, walkable }`).
 *
 * `center`, `axisU` and `axisV` must be finite `Vec3`s; `walkable` must be a
 * boolean (a missing or non-boolean `walkable` is rejected). `axisU`/`axisV`
 * must be non-degenerate (non-parallel) so the patch defines a real plane, and
 * the plane normal must point up: `cross(axisU, axisV).y > 0`. That is a
 * **geometric** ground-candidate constraint ONLY — a vertical patch or a
 * down-facing ceiling is not a legal surface, but an up-facing patch is legal
 * whether or not it is walkable. The actual passable-slope threshold is a
 * Manager rule, never derived from `normal.y > 0` here.
 *
 * A `SurfaceState` may share `(x, z)` with any number of other surfaces: there
 * is deliberately no uniqueness constraint on `center`, and no integer `level`.
 */
export function isSurfaceState(value: unknown): value is SurfaceState {
  if (!isRecord(value) || !hasExactKeys(value, SURFACE_STATE_KEYS)) {
    return false;
  }
  if (
    !isSurfaceId(value.surfaceId) ||
    !isSurfaceKind(value.kind) ||
    !isVec3(value.center) ||
    !isVec3(value.axisU) ||
    !isVec3(value.axisV) ||
    typeof value.walkable !== 'boolean'
  ) {
    return false;
  }
  return crossY(value.axisU, value.axisV) > 0;
}

/** Parse and validate `SurfaceState`, throwing `ProtocolParseError` on mismatch. */
export function parseSurfaceState(value: unknown): SurfaceState {
  if (!isSurfaceState(value)) {
    throw new ProtocolParseError('Invalid SurfaceState payload');
  }
  return value;
}

/**
 * Structural guard for `ColliderKind`
 * (exactly `'wall' | 'rock' | 'water' | 'structure'`).
 */
export function isColliderKind(value: unknown): value is ColliderKind {
  return value === 'wall' || value === 'rock' || value === 'water' || value === 'structure';
}

/** Parse and validate `ColliderKind`, throwing `ProtocolParseError` on mismatch. */
export function parseColliderKind(value: unknown): ColliderKind {
  if (!isColliderKind(value)) {
    throw new ProtocolParseError('Invalid ColliderKind payload');
  }
  return value;
}

/**
 * All known `ColliderShape` discriminators. Adding a variant extends the union
 * and this list (and the `switch` in {@link isColliderShape}).
 */
type ColliderShapeKind = ColliderShape['kind'];
const COLLIDER_SHAPE_KINDS = ['aabb'] as const satisfies readonly ColliderShapeKind[];

/** Structural guard for the `ColliderShape` discriminator (`shape.kind`). */
function isColliderShapeKind(value: unknown): value is ColliderShapeKind {
  return typeof value === 'string' && (COLLIDER_SHAPE_KINDS as readonly string[]).includes(value);
}

/**
 * Structural guard for `ColliderShape`, switching on the geometry primitive
 * `shape.kind`. Today exactly one variant:
 *
 * - `'aabb'` — exactly `{ kind, min, max }`; `min`/`max` are finite `Vec3`s and
 *   `max.{x,y,z} > min.{x,y,z}` on EVERY axis (the strict `y` check forbids an
 *   infinite ground-to-sky column).
 *
 * The `switch` carries an exhaustiveness check: adding a `ColliderShape`
 * variant without a `case` here is a compile error.
 */
export function isColliderShape(value: unknown): value is ColliderShape {
  if (!isRecord(value) || !isColliderShapeKind(value.kind)) {
    return false;
  }
  switch (value.kind) {
    case 'aabb':
      return (
        hasExactKeys(value, AABB_COLLIDER_SHAPE_KEYS) &&
        isVec3(value.min) &&
        isVec3(value.max) &&
        value.max.x > value.min.x &&
        value.max.y > value.min.y &&
        value.max.z > value.min.z
      );
    default: {
      // Exhaustiveness: unreachable while `ColliderShape` has only `'aabb'`.
      // Adding a variant without a case above makes `value.kind` non-`never`
      // and fails to compile here.
      const exhaustive: never = value.kind;
      return exhaustive;
    }
  }
}

/**
 * Structural guard for `ColliderState` (exactly `{ colliderId, kind, shape }`).
 *
 * `colliderId` and `kind` are validated here; geometry validation is delegated
 * to {@link isColliderShape}, which switches on `shape.kind`. `kind`
 * (`ColliderKind`, the gameplay vocabulary) and `shape.kind` (the geometry
 * primitive) are separate axes.
 */
export function isColliderState(value: unknown): value is ColliderState {
  if (!isRecord(value) || !hasExactKeys(value, COLLIDER_STATE_KEYS)) {
    return false;
  }
  return (
    isColliderId(value.colliderId) && isColliderKind(value.kind) && isColliderShape(value.shape)
  );
}

/** Parse and validate `ColliderState`, throwing `ProtocolParseError` on mismatch. */
export function parseColliderState(value: unknown): ColliderState {
  if (!isColliderState(value)) {
    throw new ProtocolParseError('Invalid ColliderState payload');
  }
  return value;
}

/**
 * Cell-centre rule (cell -> continuous world position), frozen and shared by
 * both sides of the wire:
 *
 * ```text
 * cellCentre.x = origin.x + (cell.x + 0.5) * cellSize
 * cellCentre.z = origin.z + (cell.z + 0.5) * cellSize
 * cellCentre.y = origin.y
 * ```
 *
 * `cell(0, 0)`'s centre is therefore `origin + 0.5 * cellSize` — never the
 * world origin, because the grid's `origin` is deliberately decoupled from it.
 * `y` is the grid plane's `origin.y`; the cell centre is a gameplay query point,
 * NOT a surface or a ground truth (surfaces live in `surfaces`).
 */
export function cellCentre(grid: GridSpec, cell: CellCoord): Vec3 {
  return {
    x: grid.origin.x + (cell.x + 0.5) * grid.cellSize,
    y: grid.origin.y,
    z: grid.origin.z + (cell.z + 0.5) * grid.cellSize,
  };
}

/**
 * The inverse of {@link cellCentre} (world position -> cell): the integer cell
 * whose `XZ` footprint contains a continuous world position.
 *
 * This is the ONLY shared grid query besides {@link cellCentre}; gameplay
 * (farming/placement/selection/terrain metadata) resolves a position to a cell
 * through it rather than re-deriving the formula. `y` is deliberately ignored:
 * the grid is a ground-plane gameplay overlay, so a bridge deck and the river
 * bed beneath it resolve to the same cell. It must **never** be used as the
 * Actor's stored position, and it does not clamp to the grid (positions outside
 * the grid produce cells outside it).
 */
export function cellOf(grid: GridSpec, position: Vec3): CellCoord {
  return {
    x: Math.floor((position.x - grid.origin.x) / grid.cellSize),
    z: Math.floor((position.z - grid.origin.z) / grid.cellSize),
  };
}

/** Structural guard for `WorldSnapshot`. */
export function isWorldSnapshot(value: unknown): value is WorldSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SNAPSHOT_KEYS)) {
    return false;
  }
  if (
    !Array.isArray(value.tiles) ||
    !Array.isArray(value.surfaces) ||
    !Array.isArray(value.colliders) ||
    !Array.isArray(value.entities)
  ) {
    return false;
  }
  return (
    isWorldId(value.worldId) &&
    isWorldBounds(value.bounds) &&
    isGridSpec(value.grid) &&
    value.tiles.every((tile) => isTileState(tile)) &&
    value.surfaces.every((surface) => isSurfaceState(surface)) &&
    value.colliders.every((collider) => isColliderState(collider)) &&
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
