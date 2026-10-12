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
 * Order is normalised deterministically — entities by `entityId`, tiles by
 * `cellZ` then `cellX` — so each array is a stable function of the server state
 * rather than of wire iteration order.
 */

import type { Vec3 } from '@starvalley/math';
import type {
  CellCoord,
  EntityState,
  GridSpec,
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
 * Derive a cell's world-space centre from the grid (the frozen formula).
 *
 * This is a world fact — where the cell physically is — and deliberately not a
 * walkability/collision rule.
 */
export function tileWorldPosition(cell: CellCoord, grid: GridSpec): Vec3ViewModel {
  return {
    x: grid.origin.x + (cell.x + 0.5) * grid.cellSize,
    y: grid.origin.y,
    z: grid.origin.z + (cell.z + 0.5) * grid.cellSize,
  };
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
