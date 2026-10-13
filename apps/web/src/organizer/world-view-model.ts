/**
 * UI-facing view models for the world feature.
 *
 * Deliberately narrower than the Protocol `WorldSnapshot`: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. All coordinates are plain view-model objects so the UI can
 * render them without importing `@starvalley/math` or `@starvalley/protocol`.
 *
 * Phase 7 makes the world a real continuous 3D world. A `TileState` holds a
 * `CellCoord` and **no position**; a tile's world-space centre is *derived* from
 * the `GridSpec` with the frozen rule:
 *
 * ```text
 * x = grid.origin.x + (cell.x + 0.5) * grid.cellSize
 * z = grid.origin.z + (cell.z + 0.5) * grid.cellSize
 * y = grid.origin.y
 * ```
 *
 * Deriving that centre is a *world fact* (where the cell is), not a gameplay
 * rule, so it lives here rather than being recomputed by every renderer.
 *
 * Terrain stays an **opaque string** at this boundary: mapping a terrain kind to
 * an appearance is the UI/bridge's job, and whether a terrain is walkable is an
 * authoritative Manager rule. The Organizer deliberately encodes neither, so no
 * gameplay or collision rule can leak into client state.
 *
 * Phase 14 adds the **world-geometry** layer (`surfaces`/`colliders`) as plain
 * view models. `walkable` is passed through as *data*: the Organizer applies no
 * slope/support/traversal rule, selects no support patch and performs no
 * collision test. Deciding what `walkable` means is the Manager's (or the
 * renderer's) business, never this layer's.
 *
 * Order is normalised deterministically — entities by `entityId`, tiles by
 * `cellZ` then `cellX`, surfaces by `surfaceId`, colliders by `colliderId` — so
 * each array is a stable function of the server state rather than of wire
 * iteration order.
 */

import { cellCentre } from '@starvalley/protocol';
import type { Vec3 } from '@starvalley/math';
import type {
  CellCoord,
  ColliderShape,
  ColliderState,
  EntityState,
  GridSpec,
  SurfaceState,
  TileState,
  WorldBounds,
} from '@starvalley/protocol';

/** Plain 3D vector for the UI. Mirrors the neutral `Vec3` without depending on it. */
export interface Vec3ViewModel {
  x: number;
  y: number;
  z: number;
}

/** World AABB for the UI. */
export interface BoundsViewModel {
  min: Vec3ViewModel;
  max: Vec3ViewModel;
}

/** Gameplay grid configuration for the UI (origin, extent, cell size). */
export interface GridViewModel {
  origin: Vec3ViewModel;
  width: number;
  depth: number;
  cellSize: number;
}

/**
 * Presentation-ready static terrain cell.
 *
 * `cellX`/`cellZ` are the integer cell indices; `position` is the *derived*
 * world-space centre of the cell. `terrain` stays an opaque string.
 */
export interface TileViewModel {
  cellX: number;
  cellZ: number;
  position: Vec3ViewModel;
  terrain: string;
}

/**
 * Presentation-ready support patch: one finite, oriented, planar ground patch in
 * world space. Pure geometry + explicit metadata — the Organizer does not decide
 * whether the patch may be traversed.
 *
 * The patch is `center + u*axisU + v*axisV` for `u, v` in `[-1, 1]`; `axisU` and
 * `axisV` are half-edge vectors in world units. `kind` stays an opaque string at
 * the UI boundary and `walkable` is passed through verbatim.
 */
export interface SurfaceViewModel {
  surfaceId: string;
  kind: string;
  center: Vec3ViewModel;
  axisU: Vec3ViewModel;
  axisV: Vec3ViewModel;
  walkable: boolean;
}

/** Geometry primitive of a collider, mirrored as plain data. Today only `'aabb'`. */
export interface AabbColliderShapeViewModel {
  kind: 'aabb';
  min: Vec3ViewModel;
  max: Vec3ViewModel;
}

/** Discriminated union of collider geometry primitives (one member today). */
export type ColliderShapeViewModel = AabbColliderShapeViewModel;

/**
 * Presentation-ready static blocking volume. `kind` is the gameplay label and
 * stays an opaque string; `shape` is the geometry primitive.
 */
export interface ColliderViewModel {
  colliderId: string;
  kind: string;
  shape: ColliderShapeViewModel;
}

/** Presentation-ready world object. `kind` stays a plain string at the UI boundary. */
export interface EntityViewModel {
  entityId: string;
  actorId: string | null;
  kind: string;
  position: Vec3ViewModel;
  rotation: { x: number; y: number; z: number; w: number };
  visible: boolean;
}

/** Copy a neutral `Vec3` into a plain view-model object (never shares the wire object). */
export function toVec3ViewModel(value: Vec3): Vec3ViewModel {
  return { x: value.x, y: value.y, z: value.z };
}

/** Map a validated Protocol `WorldBounds` into the view model. */
export function toBoundsViewModel(bounds: WorldBounds): BoundsViewModel {
  return { min: toVec3ViewModel(bounds.min), max: toVec3ViewModel(bounds.max) };
}

/** Map a validated Protocol `GridSpec` into the view model. */
export function toGridViewModel(grid: GridSpec): GridViewModel {
  return {
    origin: toVec3ViewModel(grid.origin),
    width: grid.width,
    depth: grid.depth,
    cellSize: grid.cellSize,
  };
}

/**
 * Derive a cell's world-space centre from the grid.
 *
 * Delegates to the canonical Protocol helper {@link cellCentre} rather than
 * re-deriving the frozen formula, so the client and server can never disagree on
 * where a cell is. This is a world fact — where the cell physically is — and
 * deliberately not a walkability/collision rule.
 */
export function tileWorldPosition(cell: CellCoord, grid: GridSpec): Vec3ViewModel {
  return toVec3ViewModel(cellCentre(grid, cell));
}

/**
 * Map a validated Protocol `TileState` into a presentation-ready view model,
 * deriving its world position from `grid`.
 */
export function toTileViewModel(tile: TileState, grid: GridSpec): TileViewModel {
  return {
    cellX: tile.cell.x,
    cellZ: tile.cell.z,
    position: tileWorldPosition(tile.cell, grid),
    terrain: tile.terrain,
  };
}

/**
 * Deterministic tile order: ascending by `cellZ`, then ascending by `cellX`.
 *
 * Row-major order makes the array a stable function of the snapshot rather than
 * of the order tiles happened to cross the wire in.
 */
export function compareTileViewModels(a: TileViewModel, b: TileViewModel): number {
  if (a.cellZ !== b.cellZ) {
    return a.cellZ - b.cellZ;
  }
  return a.cellX - b.cellX;
}

/** Map and order a validated tile list into presentation-ready view models. */
export function toTileViewModels(
  tiles: readonly TileState[],
  grid: GridSpec,
): TileViewModel[] {
  return tiles.map((tile) => toTileViewModel(tile, grid)).sort(compareTileViewModels);
}

/**
 * Map a validated Protocol `SurfaceState` into a presentation-ready view model.
 * Every field is copied; no traversal decision is made here.
 */
export function toSurfaceViewModel(surface: SurfaceState): SurfaceViewModel {
  return {
    surfaceId: surface.surfaceId,
    kind: surface.kind,
    center: toVec3ViewModel(surface.center),
    axisU: toVec3ViewModel(surface.axisU),
    axisV: toVec3ViewModel(surface.axisV),
    walkable: surface.walkable,
  };
}

/** Deterministic surface order: ascending by `surfaceId`. */
export function compareSurfaceViewModels(a: SurfaceViewModel, b: SurfaceViewModel): number {
  if (a.surfaceId < b.surfaceId) {
    return -1;
  }
  if (a.surfaceId > b.surfaceId) {
    return 1;
  }
  return 0;
}

/** Map and order a validated surface list into presentation-ready view models. */
export function toSurfaceViewModels(
  surfaces: readonly SurfaceState[],
): SurfaceViewModel[] {
  return surfaces.map(toSurfaceViewModel).sort(compareSurfaceViewModels);
}

/**
 * Map a validated Protocol `ColliderShape` into a presentation-ready view model.
 * The `switch` is exhaustive, so a future Protocol shape variant is a compile
 * error until it is mapped here.
 */
function toColliderShapeViewModel(shape: ColliderShape): ColliderShapeViewModel {
  switch (shape.kind) {
    case 'aabb':
      return {
        kind: 'aabb',
        min: toVec3ViewModel(shape.min),
        max: toVec3ViewModel(shape.max),
      };
    default: {
      // Exhaustiveness: `shape.kind` is `never` once every variant has a case.
      // Adding a `ColliderShape` variant without a case makes this a compile
      // error here, exactly like the Protocol guard.
      const exhaustive: never = shape.kind;
      return exhaustive;
    }
  }
}

/** Map a validated Protocol `ColliderState` into a presentation-ready view model. */
export function toColliderViewModel(collider: ColliderState): ColliderViewModel {
  return {
    colliderId: collider.colliderId,
    kind: collider.kind,
    shape: toColliderShapeViewModel(collider.shape),
  };
}

/** Deterministic collider order: ascending by `colliderId`. */
export function compareColliderViewModels(a: ColliderViewModel, b: ColliderViewModel): number {
  if (a.colliderId < b.colliderId) {
    return -1;
  }
  if (a.colliderId > b.colliderId) {
    return 1;
  }
  return 0;
}

/** Map and order a validated collider list into presentation-ready view models. */
export function toColliderViewModels(
  colliders: readonly ColliderState[],
): ColliderViewModel[] {
  return colliders.map(toColliderViewModel).sort(compareColliderViewModels);
}

/** Map a validated Protocol `EntityState` into a presentation-ready view model. */
export function toEntityViewModel(entity: EntityState): EntityViewModel {
  const { position, rotation } = entity.transform;
  return {
    entityId: entity.entityId,
    actorId: entity.actorId,
    kind: entity.kind,
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    visible: entity.visible,
  };
}

/** Deterministic entity order: ascending by `entityId`. */
export function compareEntityViewModels(a: EntityViewModel, b: EntityViewModel): number {
  if (a.entityId < b.entityId) {
    return -1;
  }
  if (a.entityId > b.entityId) {
    return 1;
  }
  return 0;
}

/** Map and order a validated entity list into presentation-ready view models. */
export function toEntityViewModels(entities: readonly EntityState[]): EntityViewModel[] {
  return entities.map(toEntityViewModel).sort(compareEntityViewModels);
}
