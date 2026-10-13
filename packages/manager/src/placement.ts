import type {
  BlockGrid,
  BlockOrientation,
  BlockState,
  CellCoord,
  EntityId,
  EntityState,
  FootprintExtents,
  Transform,
  Vec3,
} from '@starvalley/protocol';
import { cellOf, snapFootprintCentre } from '@starvalley/protocol';
import type { Quat } from '@starvalley/math';
import { quatFromYaw, yawFromQuat } from '@starvalley/math';

import type { BlockReadPort } from './blocks.ts';
import { blockCellAabb, blockSolidTopOverRect, isSolidBlockKind } from './blocks.ts';
import type { EntityCollider, EntityDefinition, EntityPlacementDefinition } from './entities.ts';
import { ENTITY_DEFINITIONS } from './entities.ts';

/**
 * Server rule: the maximum upward step the resolver may lift a base anchor to
 * reach the nearest support in a footprint column. It is the same tolerance the
 * movement solver uses for auto-step, so a surface an actor can step onto is
 * also one a placeable can be seated on.
 */
export const MAX_STEP_HEIGHT = 0.6;

/** Slack for the occupancy `> 0.5` extrusion rule, so exactly `0.5` does not add a layer. */
export const OCCUPANCY_EPSILON = 1e-6;

/** Slack for comparing support tops across a footprint. */
const SUPPORT_EPSILON = 1e-6;

/**
 * Why a placement request was refused. Transport maps these to `CONFLICT`.
 *
 * `'blocked'` is the shared CLEARANCE rule: the entity's own body would
 * intersect a solid block (for example a tree under a bridge deck). It is
 * deliberately distinct from `'occupied'`, which is entity-vs-entity occupancy
 * alone; the wire type for the reason is a plain string, so adding it needs no
 * Protocol change.
 */
export type PlacementRejectionReason =
  | 'not-placeable'
  | 'no-supported-orientation'
  | 'insufficient-support'
  | 'blocked'
  | 'occupied';

/** Successful placement resolution: the transform the server would commit. */
export interface PlacementResolved {
  readonly ok: true;
  readonly transform: Transform;
  readonly occupiedCells: CellCoord[];
  readonly yaw: BlockOrientation;
}

/** Refused placement resolution. */
export interface PlacementRejected {
  readonly ok: false;
  readonly reason: PlacementRejectionReason;
  readonly occupiedCells: CellCoord[];
}

export type PlacementResolution = PlacementResolved | PlacementRejected;

/** Input for the pure {@link resolvePlacement}. */
export interface ResolvePlacementInput {
  readonly definition: EntityDefinition;
  /** A REQUESTED anchor, not the committed transform. */
  readonly requestedPosition: Vec3;
  readonly yawDegrees: number;
  readonly grid: BlockGrid;
  readonly blocks: BlockReadPort;
  readonly occupancy: OccupancyIndex;
  /** When re-resolving an existing entity, its own occupancy must not conflict. */
  readonly ignoreEntityId?: EntityId;
  /** Lowest world `y` the support search descends to. */
  readonly minY: number;
}

function copyCoord(coord: CellCoord): CellCoord {
  return { x: coord.x, y: coord.y, z: coord.z };
}

function compareCells(a: CellCoord, b: CellCoord): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.z !== b.z) return a.z - b.z;
  return a.x - b.x;
}

/** Normalize an angle in degrees into `[0, 360)`. */
function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Snap a requested yaw to the nearest allowed quarter turn, deterministically.
 *
 * Ties on angular distance are broken toward the SMALLEST allowed step, so the
 * result does not depend on the order of `allowed`.
 */
export function snapYaw(
  requestedDegrees: number,
  allowed: readonly BlockOrientation[],
): BlockOrientation | null {
  if (allowed.length === 0) {
    return null;
  }
  const sorted = [...allowed].sort((a, b) => a - b);
  const target = normalizeDegrees(requestedDegrees);
  let best = sorted[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of sorted) {
    const raw = Math.abs(target - step);
    const distance = Math.min(raw, 360 - raw);
    if (distance < bestDistance - SUPPORT_EPSILON) {
      best = step;
      bestDistance = distance;
    }
  }
  return best;
}

/** The horizontal extents for a yaw: a 90/270 rotation swaps x and z. */
export function extentsForYaw(
  footprint: FootprintExtents,
  yaw: BlockOrientation,
): FootprintExtents {
  return yaw === 90 || yaw === 270
    ? { x: footprint.z, z: footprint.x }
    : { x: footprint.x, z: footprint.z };
}

/** The yaw step encoded by a committed rotation (multiples of 90 only). */
export function yawStepFromRotation(rotation: Quat): BlockOrientation {
  const degrees = (yawFromQuat(rotation) * 180) / Math.PI;
  const step = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return step as BlockOrientation;
}

/**
 * The integer footprint columns an entity covers for a snapped centre and
 * extents.
 *
 * For an extent `E` on an axis the committed centre is a cell centre when `E`
 * is odd and a cell boundary when `E` is even, so the first covered cell is
 * `round((centre - origin)/cellSize - E/2)`. This is exact for a snapped centre
 * and never hardcodes `cellSize`.
 */
export function footprintColumns(
  grid: BlockGrid,
  centre: Vec3,
  extents: FootprintExtents,
): Array<{ readonly x: number; readonly z: number }> {
  const firstX = Math.round((centre.x - grid.origin.x) / grid.cellSize - extents.x / 2);
  const firstZ = Math.round((centre.z - grid.origin.z) / grid.cellSize - extents.z / 2);
  const columns: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < extents.x; dx += 1) {
    for (let dz = 0; dz < extents.z; dz += 1) {
      columns.push({ x: firstX + dx, z: firstZ + dz });
    }
  }
  return columns;
}

/**
 * The number of grid layers a placement occupies, from its height and the grid
 * cell size:
 *
 * ```text
 * full  = floor(height / cellSize)
 * extra = (remainder > 0.5 * cellSize) ? 1 : 0
 * layers = max(1, full + extra)
 * ```
 *
 * The epsilon makes a remainder of exactly `0.5` NOT add a layer.
 */
export function occupancyLayers(height: number, cellSize: number): number {
  const full = Math.floor(height / cellSize);
  const remainder = height - full * cellSize;
  const extra = remainder > 0.5 * cellSize + OCCUPANCY_EPSILON ? 1 : 0;
  return Math.max(1, full + extra);
}

/**
 * Derive the occupied `CellCoord[]` for a COMMITTED transform + placement
 * definition. Occupancy is always a pure function of the committed transform;
 * it can never drive it.
 */
export function deriveOccupiedCells(
  transform: Transform,
  placement: EntityPlacementDefinition,
  grid: BlockGrid,
): CellCoord[] {
  const yaw = yawStepFromRotation(transform.rotation);
  const extents = extentsForYaw(placement.footprint, yaw);
  const columns = footprintColumns(grid, transform.position, extents);
  const layers = occupancyLayers(placement.height, grid.cellSize);
  const baseCellY = cellOf(grid, transform.position).y;
  const cells: CellCoord[] = [];
  for (const column of columns) {
    for (let layer = 0; layer < layers; layer += 1) {
      cells.push({ x: column.x, y: baseCellY + layer, z: column.z });
    }
  }
  return cells.sort(compareCells);
}

/**
 * Authoritative `CellCoord -> EntityId[]` occupancy index.
 *
 * Only PLACEABLE entities are ever written; dynamic actors never write it. The
 * live index is kept in lockstep with `deriveOccupiedCells`, and
 * {@link rebuildOccupancyFromEntities} reproduces it exactly.
 */
export interface OccupancyIndex {
  add(entityId: EntityId, cells: readonly CellCoord[]): void;
  remove(entityId: EntityId): void;
  entitiesAt(cell: CellCoord): EntityId[];
  has(cell: CellCoord): boolean;
  cells(): CellCoord[];
}

/** Create an empty occupancy index. */
export function createOccupancyIndex(): OccupancyIndex {
  const byCell = new Map<string, Set<EntityId>>();
  const byEntity = new Map<EntityId, CellCoord[]>();

  const keyOf = (cell: CellCoord): string => `${cell.x}|${cell.y}|${cell.z}`;

  const remove: (entityId: EntityId) => void = (entityId) => {
    const cells = byEntity.get(entityId);
    if (cells === undefined) {
      return;
    }
    for (const cell of cells) {
      const key = keyOf(cell);
      const owners = byCell.get(key);
      if (owners !== undefined) {
        owners.delete(entityId);
        if (owners.size === 0) {
          byCell.delete(key);
        }
      }
    }
    byEntity.delete(entityId);
  };

  return {
    add(entityId, cells): void {
      remove(entityId);
      const stored = cells.map(copyCoord);
      byEntity.set(entityId, stored);
      for (const cell of stored) {
        const key = keyOf(cell);
        let owners = byCell.get(key);
        if (owners === undefined) {
          owners = new Set<EntityId>();
          byCell.set(key, owners);
        }
        owners.add(entityId);
      }
    },
    remove,
    entitiesAt(cell): EntityId[] {
      const owners = byCell.get(keyOf(cell));
      return owners === undefined ? [] : [...owners].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    has(cell): boolean {
      return byCell.has(keyOf(cell));
    },
    cells(): CellCoord[] {
      return [...byCell.keys()]
        .map((key) => {
          const [x, y, z] = key.split('|').map(Number);
          return { x, y, z };
        })
        .sort(compareCells);
    },
  };
}

/** Is every cell in `cells` free of an occupant other than `ignoreEntityId`? */
export function cellsAreFree(
  occupancy: OccupancyIndex,
  cells: readonly CellCoord[],
  ignoreEntityId?: EntityId,
): boolean {
  for (const cell of cells) {
    for (const owner of occupancy.entitiesAt(cell)) {
      if (owner !== ignoreEntityId) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Rebuild the occupancy index from a live entity list. This MUST equal the live
 * index maintained by place/rotate/remove; tests assert the equivalence.
 */
export function rebuildOccupancyFromEntities(
  entities: readonly EntityState[],
  grid: BlockGrid,
): OccupancyIndex {
  const index = createOccupancyIndex();
  for (const entity of entities) {
    const placement = ENTITY_DEFINITIONS[entity.kind].placement;
    if (placement === undefined) {
      continue;
    }
    index.add(entity.entityId, deriveOccupiedCells(entity.transform, placement, grid));
  }
  return index;
}

/**
 * The highest solid top in a footprint column at or below `maxY`, or `null`.
 *
 * The whole cell is used (the shape's top over the full cell), so a `ramp` or
 * `stairs` column is seated on its highest point. This is the server support
 * query behind placement's `requireFullSupport`.
 */
export function columnSupportTop(
  grid: BlockGrid,
  blocks: BlockReadPort,
  cellX: number,
  cellZ: number,
  maxY: number,
  minY: number,
): number | null {
  const size = grid.cellSize;
  const maxCellY = Math.floor((maxY - grid.origin.y) / size);
  const minCellY = Math.floor((minY - grid.origin.y) / size);
  for (let y = maxCellY; y >= minCellY; y -= 1) {
    const block = blocks.get({ x: cellX, y, z: cellZ });
    if (block === undefined || !isSolidBlockKind(block.kind)) {
      continue;
    }
    const aabb = blockCellAabb(block, grid);
    const top = blockSolidTopOverRect(block, grid, aabb.min.x, aabb.max.x, aabb.min.z, aabb.max.z);
    if (top !== null && top <= maxY + SUPPORT_EPSILON) {
      return top;
    }
  }
  return null;
}

interface AuthoringAabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The world AABB of an entity collider anchored at its base position. */
function entityColliderAabb(collider: EntityCollider, position: Vec3): AuthoringAabb {
  switch (collider.type) {
    case 'aabb':
      return {
        min: {
          x: position.x - collider.halfExtents.x,
          y: position.y,
          z: position.z - collider.halfExtents.z,
        },
        max: {
          x: position.x + collider.halfExtents.x,
          y: position.y + 2 * collider.halfExtents.y,
          z: position.z + collider.halfExtents.z,
        },
      };
    case 'cylinder':
    case 'capsule':
      return {
        min: { x: position.x - collider.radius, y: position.y, z: position.z - collider.radius },
        max: {
          x: position.x + collider.radius,
          y: position.y + collider.height,
          z: position.z + collider.radius,
        },
      };
    default: {
      const exhaustive: never = collider;
      throw new Error(`Unhandled EntityCollider: ${String(exhaustive)}`);
    }
  }
}

/** A committed placement that fails the shared support/clearance rule. */
export type PlacementInvariantViolation =
  | {
      /** Some footprint column's solid top is not exactly the base. */
      readonly kind: 'support';
      readonly column: { readonly x: number; readonly z: number };
      readonly top: number | null;
    }
  | {
      /** The entity's collider body intersects a solid block. */
      readonly kind: 'blocked';
      readonly block: BlockState;
    };

/** Input for the shared support+clearance rule {@link checkPlacementInvariants}. */
export interface CheckPlacementInvariantsInput {
  readonly placement: EntityPlacementDefinition;
  readonly collider: EntityCollider;
  /** A COMMITTED base position (already snapped and seated by the caller). */
  readonly position: Vec3;
  readonly yaw: BlockOrientation;
  readonly grid: BlockGrid;
  readonly blocks: BlockReadPort;
  readonly minY: number;
}

/**
 * The SINGLE server-side support+clearance rule for a committed placement.
 *
 * Both the authored construction guard ({@link assertAuthoredPlaceable}) and the
 * wire resolver ({@link resolvePlacement}) call this, so a placement can never
 * produce a state the authoring path forbids:
 *
 * 1. SUPPORT: every footprint column's highest solid top at or below the base
 *    is exactly the base. A `slab`/`stair`/`ramp` top is CONTINUOUS, so the
 *    base is that face, never the cell boundary. This catches a floating entity.
 * 2. CLEARANCE: the entity's collider body does not intersect a solid block.
 *    This catches an entity embedded in a solid (or a tree under a bridge deck)
 *    even when a lower support exists beneath it.
 *
 * The caller decides how to report the violation (a `RangeError` at authoring,
 * a `PlacementRejectionReason` on the wire); this function stays pure.
 */
export function checkPlacementInvariants(
  input: CheckPlacementInvariantsInput,
): PlacementInvariantViolation | null {
  const { placement, collider, position, yaw, grid, blocks, minY } = input;

  const extents = extentsForYaw(placement.footprint, yaw);
  for (const column of footprintColumns(grid, position, extents)) {
    const top = columnSupportTop(grid, blocks, column.x, column.z, position.y, minY);
    if (top === null || Math.abs(top - position.y) > SUPPORT_EPSILON) {
      return { kind: 'support', column, top };
    }
  }

  const box = entityColliderAabb(collider, position);
  for (const block of blocks.queryAabb(box.min, box.max)) {
    if (!isSolidBlockKind(block.kind)) {
      continue;
    }
    const cell = blockCellAabb(block, grid);
    const rx0 = Math.max(box.min.x, cell.min.x);
    const rx1 = Math.min(box.max.x, cell.max.x);
    const rz0 = Math.max(box.min.z, cell.min.z);
    const rz1 = Math.min(box.max.z, cell.max.z);
    if (rx1 - rx0 <= SUPPORT_EPSILON || rz1 - rz0 <= SUPPORT_EPSILON) {
      continue;
    }
    const top = blockSolidTopOverRect(block, grid, rx0, rx1, rz0, rz1);
    if (top === null) {
      continue;
    }
    if (box.min.y < top - SUPPORT_EPSILON && box.max.y > cell.min.y + SUPPORT_EPSILON) {
      return { kind: 'blocked', block };
    }
  }

  return null;
}

/** Input for the authored-placeable construction guard {@link assertAuthoredPlaceable}. */
export interface AssertAuthoredPlaceableInput {
  readonly entity: EntityState;
  readonly definition: EntityDefinition;
  readonly grid: BlockGrid;
  readonly blocks: BlockReadPort;
  /** Occupancy of the authored entities validated so far (excludes `entity`). */
  readonly occupancy: OccupancyIndex;
  readonly minY: number;
}

/**
 * Authoring guard: every AUTHORED placeable entity must already be a legal
 * placement before the world is served.
 *
 * The resolver would produce exactly this transform for a compliant placement,
 * so authoring one directly must meet the same invariants. SUPPORT and
 * CLEARANCE are delegated to the single shared rule
 * ({@link checkPlacementInvariants}), which the wire resolver also calls, so
 * the two paths can never disagree:
 *
 * 1. SUPPORT: the entity's base sits exactly on the highest solid top under its
 *    own footprint. A `slab`/`stair`/`ramp` top is CONTINUOUS, so the base is
 *    that face, never the cell boundary. This is the check that catches a
 *    floating entity.
 * 2. CLEARANCE: the entity's collider does not intersect a solid block. This
 *    catches an entity authored embedded in a solid even when a lower support
 *    exists beneath it.
 *
 * Derived occupancy is then checked separately for entity-vs-entity overlap.
 * Every failure throws a `RangeError` (the spawn guard's style) at construction,
 * so this class of authoring error can never be silent again.
 */
export function assertAuthoredPlaceable(input: AssertAuthoredPlaceableInput): void {
  const { entity, definition, grid, blocks, occupancy, minY } = input;
  const placement = definition.placement;
  if (placement === undefined) {
    throw new RangeError(`Authored entity ${entity.entityId} (${entity.kind}) is not placeable`);
  }
  const position = entity.transform.position;
  const violation = checkPlacementInvariants({
    placement,
    collider: definition.collider,
    position,
    yaw: yawStepFromRotation(entity.transform.rotation),
    grid,
    blocks,
    minY,
  });
  if (violation !== null) {
    if (violation.kind === 'support') {
      throw new RangeError(
        `Authored ${entity.kind} ${entity.entityId} at (${position.x}, ${position.y}, ${position.z}) ` +
          `must sit on its support top, but the support under cell (${violation.column.x}, ${violation.column.z}) ` +
          `tops at ${violation.top === null ? 'no solid block' : violation.top}`,
      );
    }
    throw new RangeError(
      `Authored ${entity.kind} ${entity.entityId} overlaps the solid ${violation.block.kind} at ` +
        `(${violation.block.coord.x}, ${violation.block.coord.y}, ${violation.block.coord.z})`,
    );
  }

  const occupiedCells = deriveOccupiedCells(entity.transform, placement, grid);
  if (!cellsAreFree(occupancy, occupiedCells, entity.entityId)) {
    throw new RangeError(
      `Authored ${entity.kind} ${entity.entityId} occupancy overlaps another authored entity`,
    );
  }
}

/**
 * The shared server-side Placement Resolver. Pure: it reads the world and
 * returns the transform it WOULD commit, or a typed refusal. It never mutates.
 *
 * Semantics:
 * 1. The yaw is snapped to the nearest allowed quarter turn.
 * 2. X/Z are snapped with the shared `snapFootprintCentre`.
 * 3. Y is the server support query: every footprint column must have a solid
 *    support and all supports must be at the same top (`requireFullSupport`).
 * 4. The committed transform is the resolved centre on that support top face.
 * 5. The committed transform re-enters the shared support+clearance rule
 *    ({@link checkPlacementInvariants}), so the wire path can never accept a
 *    body that intersects a solid block (`'blocked'`).
 * 6. Occupancy is derived from the committed transform and checked for conflict.
 */
export function resolvePlacement(input: ResolvePlacementInput): PlacementResolution {
  const { definition, grid, blocks, occupancy, ignoreEntityId, minY } = input;
  const placement = definition.placement;
  if (placement === undefined) {
    return { ok: false, reason: 'not-placeable', occupiedCells: [] };
  }
  const yaw = snapYaw(input.yawDegrees, placement.allowedYawSteps);
  if (yaw === null) {
    return { ok: false, reason: 'no-supported-orientation', occupiedCells: [] };
  }
  const extents = extentsForYaw(placement.footprint, yaw);
  const snapped = snapFootprintCentre(input.requestedPosition, extents, grid);
  const columns = footprintColumns(grid, snapped, extents);
  const maxSupportY = input.requestedPosition.y + MAX_STEP_HEIGHT;

  let baseY: number | null = null;
  for (const column of columns) {
    const top = columnSupportTop(grid, blocks, column.x, column.z, maxSupportY, minY);
    if (top === null) {
      return { ok: false, reason: 'insufficient-support', occupiedCells: [] };
    }
    if (baseY === null) {
      baseY = top;
    } else if (Math.abs(top - baseY) > SUPPORT_EPSILON) {
      return { ok: false, reason: 'insufficient-support', occupiedCells: [] };
    }
  }

  const transform: Transform = {
    position: { x: snapped.x, y: baseY as number, z: snapped.z },
    rotation: quatFromYaw((yaw * Math.PI) / 180),
  };
  const occupiedCells = deriveOccupiedCells(transform, placement, grid);
  const violation = checkPlacementInvariants({
    placement,
    collider: definition.collider,
    position: transform.position,
    yaw,
    grid,
    blocks,
    minY,
  });
  if (violation !== null) {
    return {
      ok: false,
      reason: violation.kind === 'blocked' ? 'blocked' : 'insufficient-support',
      occupiedCells,
    };
  }
  if (!cellsAreFree(occupancy, occupiedCells, ignoreEntityId)) {
    return { ok: false, reason: 'occupied', occupiedCells };
  }
  return { ok: true, transform, occupiedCells, yaw };
}
