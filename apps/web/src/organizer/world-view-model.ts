/**
 * UI-facing view models for the world feature.
 *
 * Deliberately narrower than the Protocol payloads: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. All coordinates are plain view-model objects so the UI can
 * render them without importing `@starvalley/math` or `@starvalley/protocol`.
 *
 * Phase 15 replaces the phase-14 gameplay grid (`GridSpec`/`TileState`) and the
 * world-geometry layer (`surfaces`/`colliders`) with the **block-spatial kernel**:
 * a `BlockGrid` (`origin` + `cellSize`) and a **sparse** list of absolute integer
 * `BlockState`s. A block view model carries its derived **world-space centre**,
 * computed with the same frozen, `cellSize`-configurable rule the server uses:
 *
 * ```text
 * cellCentre.a = origin.a + (cell.a + 0.5) * cellSize    for a in { x, y, z }
 * ```
 *
 * Deriving that centre is a *world fact* (where the cell is), not a gameplay
 * rule, so it lives here rather than being recomputed by every renderer. The
 * derivation delegates to the canonical Protocol helper {@link cellCentre} so the
 * client and server can never disagree on where a cell is.
 *
 * `block.kind` and `entity.kind` stay **opaque strings** at this boundary:
 * mapping a kind to an appearance is the UI/bridge's job, and whether a
 * placement is legal is an authoritative Manager rule. The Organizer deliberately
 * encodes neither, so no gameplay or collision rule can leak into client state.
 *
 * The `entityKinds` catalogue is **declarative geometry only** (footprint, height,
 * allowed yaw steps, pivot) so the client can draw a pending placement ghost
 * without a second source of truth. It carries no appearance and no legality
 * rule; `validatePlacement` returns the server's verdict as plain data.
 *
 * Order is normalised deterministically — blocks by layer (`y`), then row (`z`),
 * then column (`x`); entities by `entityId`; catalogue entries by `kind` — so
 * each array is a stable function of the server state rather than of wire
 * iteration order.
 */

import { cellCentre } from '@starvalley/protocol';
import type { Vec3 } from '@starvalley/math';
import type {
  BlockGrid,
  BlockKindInfo,
  BlockState,
  CellCoord,
  EntityKindInfo,
  EntityState,
  ValidatePlacementResponse,
  WorldBounds,
} from '@starvalley/protocol';

/** Plain 3D vector for the UI. Mirrors the neutral `Vec3` without depending on it. */
export interface Vec3ViewModel {
  x: number;
  y: number;
  z: number;
}

/** Plain 3D rotation (quaternion) for the UI. */
export interface QuatViewModel {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A continuous world transform (position + rotation) as plain data. */
export interface TransformViewModel {
  position: Vec3ViewModel;
  rotation: QuatViewModel;
}

/** World AABB for the UI. */
export interface BoundsViewModel {
  min: Vec3ViewModel;
  max: Vec3ViewModel;
}

/**
 * The block grid's pure configuration for the UI: an `origin` corner and a
 * `cellSize` in world units. It is deliberately NOT the removed `GridSpec` (no
 * `width`/`depth`): a sparse block world has no fixed extent, only addressing.
 */
export interface BlockGridViewModel {
  origin: Vec3ViewModel;
  cellSize: number;
}

/** An integer cell address in the block grid (all three axes). Plain data. */
export interface CellCoordViewModel {
  x: number;
  y: number;
  z: number;
}

/**
 * Presentation-ready block: an absolute integer cell, its derived world-space
 * centre, an opaque kind, and its yaw-step orientation.
 *
 * `position` is the *derived* centre of the cell, so the render bridge can place
 * the block without importing the Protocol derivation helper (the bridge may not
 * import `@starvalley/protocol`). `kind` stays an opaque string and
 * `orientation` is a plain number (`0 | 90 | 180 | 270`).
 */
export interface BlockViewModel {
  coord: CellCoordViewModel;
  position: Vec3ViewModel;
  kind: string;
  orientation: number;
}

/** Presentation-ready world object. `kind` stays a plain string at the UI boundary. */
export interface EntityViewModel {
  entityId: string;
  actorId: string | null;
  kind: string;
  position: Vec3ViewModel;
  rotation: QuatViewModel;
  visible: boolean;
}

/**
 * Declarative, presentation-only data for one block kind: its id and whether a
 * non-default orientation is meaningful. No appearance, no collision, no rule.
 */
export interface BlockKindInfoViewModel {
  kind: string;
  orientable: boolean;
}

/**
 * Declarative, presentation-only placement geometry for one entity kind: pure
 * geometry sufficient to draw a pending placement ghost. No appearance and no
 * legality rule.
 */
export interface EntityKindInfoViewModel {
  kind: string;
  footprintX: number;
  footprintZ: number;
  height: number;
  allowedYawSteps: readonly number[];
  pivot: 'center';
}

/**
 * The server's placement verdict, translated to plain data. `reason` and
 * `resolvedTransform` are present-and-nullable: `valid: false` carries a non-null
 * reason and a null transform; `valid: true` the opposite.
 *
 * This is a **preview**: the Organizer never caches it as authority and never
 * derives validity, support, occupancy or permission itself.
 */
export interface PlacementValidationViewModel {
  valid: boolean;
  reason: string | null;
  occupiedCells: readonly CellCoordViewModel[];
  resolvedTransform: TransformViewModel | null;
}

/** Copy a neutral `Vec3` into a plain view-model object (never shares the wire object). */
export function toVec3ViewModel(value: Vec3): Vec3ViewModel {
  return { x: value.x, y: value.y, z: value.z };
}

/** Map a validated Protocol `WorldBounds` into the view model. */
export function toBoundsViewModel(bounds: WorldBounds): BoundsViewModel {
  return { min: toVec3ViewModel(bounds.min), max: toVec3ViewModel(bounds.max) };
}

/** Map a validated Protocol `BlockGrid` into the view model. */
export function toBlockGridViewModel(grid: BlockGrid): BlockGridViewModel {
  return { origin: toVec3ViewModel(grid.origin), cellSize: grid.cellSize };
}

/**
 * Derive a cell's world-space centre from the grid.
 *
 * Delegates to the canonical Protocol helper {@link cellCentre} rather than
 * re-deriving the frozen formula, so the client and server can never disagree on
 * where a cell is. This is a world fact — where the cell physically is — and
 * deliberately not a walkability/collision rule.
 */
export function cellWorldPosition(grid: BlockGrid, cell: CellCoord): Vec3ViewModel {
  return toVec3ViewModel(cellCentre(grid, cell));
}

/**
 * Map a validated Protocol `BlockState` into a presentation-ready view model,
 * deriving its world position from the grid.
 */
export function toBlockViewModel(block: BlockState, grid: BlockGrid): BlockViewModel {
  return {
    coord: { x: block.coord.x, y: block.coord.y, z: block.coord.z },
    position: cellWorldPosition(grid, block.coord),
    kind: block.kind,
    orientation: block.orientation,
  };
}

/**
 * Deterministic block order: ascending by layer (`y`), then row (`z`), then
 * column (`x`). Layer-major order makes the array a stable function of the
 * snapshot rather than of the order blocks happened to cross the wire in.
 */
export function compareBlockViewModels(a: BlockViewModel, b: BlockViewModel): number {
  if (a.coord.y !== b.coord.y) {
    return a.coord.y - b.coord.y;
  }
  if (a.coord.z !== b.coord.z) {
    return a.coord.z - b.coord.z;
  }
  return a.coord.x - b.coord.x;
}

/** Map and order a validated sparse block list into presentation-ready view models. */
export function toBlockViewModels(
  blocks: readonly BlockState[],
  grid: BlockGrid,
): BlockViewModel[] {
  return blocks.map((block) => toBlockViewModel(block, grid)).sort(compareBlockViewModels);
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

/** Map a validated Protocol `BlockKindInfo` into a presentation-ready view model. */
export function toBlockKindInfoViewModel(info: BlockKindInfo): BlockKindInfoViewModel {
  return { kind: info.kind, orientable: info.orientable };
}

/** Deterministic catalogue order: ascending by `kind`. */
export function compareBlockKindInfoViewModels(
  a: BlockKindInfoViewModel,
  b: BlockKindInfoViewModel,
): number {
  if (a.kind < b.kind) {
    return -1;
  }
  if (a.kind > b.kind) {
    return 1;
  }
  return 0;
}

/** Map and order the validated block-kind catalogue into presentation-ready view models. */
export function toBlockKindInfoViewModels(
  infos: readonly BlockKindInfo[],
): BlockKindInfoViewModel[] {
  return infos.map(toBlockKindInfoViewModel).sort(compareBlockKindInfoViewModels);
}

/** Map a validated Protocol `EntityKindInfo` into a presentation-ready view model. */
export function toEntityKindInfoViewModel(info: EntityKindInfo): EntityKindInfoViewModel {
  return {
    kind: info.kind,
    footprintX: info.footprintX,
    footprintZ: info.footprintZ,
    height: info.height,
    allowedYawSteps: [...info.allowedYawSteps],
    pivot: info.pivot,
  };
}

/** Deterministic catalogue order: ascending by `kind`. */
export function compareEntityKindInfoViewModels(
  a: EntityKindInfoViewModel,
  b: EntityKindInfoViewModel,
): number {
  if (a.kind < b.kind) {
    return -1;
  }
  if (a.kind > b.kind) {
    return 1;
  }
  return 0;
}

/** Map and order the validated entity-kind catalogue into presentation-ready view models. */
export function toEntityKindInfoViewModels(
  infos: readonly EntityKindInfo[],
): EntityKindInfoViewModel[] {
  return infos.map(toEntityKindInfoViewModel).sort(compareEntityKindInfoViewModels);
}

/**
 * Map the server's `ValidatePlacementResponse` into plain view-model data.
 *
 * Pure translation: the Organizer makes no validity decision and stores nothing.
 */
export function toPlacementValidationViewModel(
  response: ValidatePlacementResponse,
): PlacementValidationViewModel {
  return {
    valid: response.valid,
    reason: response.reason,
    occupiedCells: response.occupiedCells.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z })),
    resolvedTransform:
      response.resolvedTransform === null
        ? null
        : {
            position: toVec3ViewModel(response.resolvedTransform.position),
            rotation: {
              x: response.resolvedTransform.rotation.x,
              y: response.resolvedTransform.rotation.y,
              z: response.resolvedTransform.rotation.z,
              w: response.resolvedTransform.rotation.w,
            },
          },
  };
}
