import type {
  BlockChangedEvent,
  BlockGrid,
  BlockKind,
  BlockOrientation,
  BlockState,
  CellCoord,
  ChunkCoord,
  Vec3,
} from '@starvalley/protocol';
import { cellToChunk } from '@starvalley/protocol';

/**
 * Server-only gameplay tags for a block kind.
 *
 * Tags are the *rule* axis and are deliberately separate from the *geometry*
 * axis (`BlockCollisionShape`): a block is COLLIDABLE because it carries
 * `'solid'`, and its geometry is described by its collision shape. No code may
 * branch on `BlockKind` to decide movement; it reads the definition's shape for
 * geometry and its tags for solidity.
 */
export type BlockTag = 'solid' | 'liquid';

/**
 * The server-only spatial primitive of a block, expressed in LOCAL cell
 * fractions so it is independent of the configurable `cellSize`.
 *
 * - `empty`: no collision volume (air, and any non-solid block such as water).
 * - `cube`: the full unit cell, `[0, 1]` on every local axis.
 * - `slab`: a bottom-anchored slab, `[0, height]` (`height` in `(0, 1]`).
 * - `stair`: two steps; the lower half is `0.5` high, the upper half `1.0`.
 * - `ramp`: a linear height field rising along the block's oriented axis,
 *   `h = cz` where `cz` is the canonical local axis coordinate in `[0, 1]`.
 *
 * This is the SPATIAL PRIMITIVE the solver reads. The wire
 * `BlockOrientation` (yaw `0 | 90 | 180 | 270`) orients it.
 */
export type BlockCollisionShape =
  | { readonly type: 'empty' }
  | { readonly type: 'cube' }
  | { readonly type: 'slab'; readonly height: number }
  | { readonly type: 'stair' }
  | { readonly type: 'ramp' };

/** A block kind's server-only gameplay definition. Never crosses the wire. */
export interface BlockDefinition {
  readonly collisionShape: BlockCollisionShape;
  readonly tags: readonly BlockTag[];
}

/**
 * Total server-side registry: every `BlockKind` has exactly one definition.
 *
 * `air` is the absence of a block and therefore has an `empty` shape and no
 * tags. `water` is a non-solid block: it carries the `'liquid'` tag and an
 * `empty` collision shape, so the solver treats it as neither support nor
 * obstacle (matching "water (a non-solid block)"). The registry is total, so
 * adding a kind is a compile error here until its geometry and tags are
 * decided.
 */
export const BLOCK_DEFINITIONS: Readonly<Record<BlockKind, BlockDefinition>> = {
  air: { collisionShape: { type: 'empty' }, tags: [] },
  grass: { collisionShape: { type: 'cube' }, tags: ['solid'] },
  soil: { collisionShape: { type: 'cube' }, tags: ['solid'] },
  stone: { collisionShape: { type: 'cube' }, tags: ['solid'] },
  path: { collisionShape: { type: 'cube' }, tags: ['solid'] },
  water: { collisionShape: { type: 'empty' }, tags: ['liquid'] },
  slab: { collisionShape: { type: 'slab', height: 0.5 }, tags: ['solid'] },
  stairs: { collisionShape: { type: 'stair' }, tags: ['solid'] },
  ramp: { collisionShape: { type: 'ramp' }, tags: ['solid'] },
};

/** Does this block definition carry the given tag? */
export function hasBlockTag(definition: BlockDefinition, tag: BlockTag): boolean {
  return definition.tags.includes(tag);
}

/** Is a block kind collidable/supporting (carries the `'solid'` tag)? */
export function isSolidBlockKind(kind: BlockKind): boolean {
  return hasBlockTag(BLOCK_DEFINITIONS[kind], 'solid');
}

/** The definition for a kind. Total; never `undefined`. */
export function blockDefinition(kind: BlockKind): BlockDefinition {
  return BLOCK_DEFINITIONS[kind];
}

/**
 * Numerical slack for the shape queries. It is far below any gameplay-relevant
 * distance (it is a fraction of a cell) but comfortably above floating-point
 * noise on the cell fractions used here.
 */
const SHAPE_EPSILON = 1e-9;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamp a local fraction into `[0, 1)`, never returning exactly `1`. */
function clampLocal(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1 - SHAPE_EPSILON;
  return value;
}

/**
 * Map a point in world-local cell fractions `(localX, localZ)` (both `[0, 1)`
 * measured from the cell's minimum corner) into the block's canonical local
 * frame, undoing the `BlockOrientation` yaw about the cell centre.
 *
 * Canonical convention: `+Z` is the rise axis of a `ramp`/`stairs`. The mapping
 * is the inverse of a right-handed yaw rotation about `+Y`, so it is
 * deterministic and exact for the four quarter turns.
 */
function toCanonicalLocal(
  localX: number,
  localZ: number,
  orientation: BlockOrientation,
): { readonly cx: number; readonly cz: number } {
  const radians = (orientation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = localX - 0.5;
  const dz = localZ - 0.5;
  return { cx: dx * cos - dz * sin + 0.5, cz: dx * sin + dz * cos + 0.5 };
}

/**
 * The solid vertical interval of a block at a local cell point, in local cell
 * fractions `[0, 1]`, or `null` when the shape is not solid there.
 *
 * All shapes are bottom-anchored, so `bottom` is always `0`; the value is kept
 * as an interval so a future shape with an underside is representable without
 * changing the solver's shape-agnostic contract.
 */
export function solidIntervalAt(
  block: BlockState,
  localX: number,
  localZ: number,
): { readonly bottom: number; readonly top: number } | null {
  const shape = blockDefinition(block.kind).collisionShape;
  // Non-solid blocks (water) have an empty shape; the tag and the shape agree.
  if (!isSolidBlockKind(block.kind)) {
    return null;
  }
  const { cz } = toCanonicalLocal(localX, localZ, block.orientation);
  switch (shape.type) {
    case 'empty':
      return null;
    case 'cube':
      return { bottom: 0, top: 1 };
    case 'slab':
      return { bottom: 0, top: clamp01(shape.height) };
    case 'stair':
      return { bottom: 0, top: cz < 0.5 ? 0.5 : 1 };
    case 'ramp':
      return { bottom: 0, top: clamp01(cz) };
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unhandled BlockCollisionShape: ${String(exhaustive)}`);
    }
  }
}

/**
 * The local TOP surface height (`[0, 1]` as a fraction of `cellSize`) at a
 * local cell point, or `null` when the shape offers no top there (empty /
 * non-solid).
 *
 * This is the shape-agnostic query the solver's support pass uses. It never
 * reads the block kind beyond the shape/tag lookup.
 */
export function supportHeightAt(
  block: BlockState,
  localX: number,
  localZ: number,
): number | null {
  const interval = solidIntervalAt(block, localX, localZ);
  return interval === null ? null : interval.top;
}

/**
 * Does the shape's solid volume contain the local point `(localX, localY,
 * localZ)` (`localY` in `[0, 1]`)? The shape-agnostic query the solver's
 * collision pass uses.
 */
export function blocksAtHeight(
  block: BlockState,
  localX: number,
  localZ: number,
  localY: number,
): boolean {
  const interval = solidIntervalAt(block, localX, localZ);
  if (interval === null) {
    return false;
  }
  return localY > interval.bottom + SHAPE_EPSILON && localY < interval.top - SHAPE_EPSILON;
}

/** The world-space AABB of a block cell (independent of its shape). */
export function blockCellAabb(
  block: BlockState,
  grid: BlockGrid,
): { readonly min: Vec3; readonly max: Vec3 } {
  const size = grid.cellSize;
  return {
    min: {
      x: grid.origin.x + block.coord.x * size,
      y: grid.origin.y + block.coord.y * size,
      z: grid.origin.z + block.coord.z * size,
    },
    max: {
      x: grid.origin.x + (block.coord.x + 1) * size,
      y: grid.origin.y + (block.coord.y + 1) * size,
      z: grid.origin.z + (block.coord.z + 1) * size,
    },
  };
}

/**
 * The highest solid top of a block over the world-space XZ rectangle
 * `[rx0, rx1] x [rz0, rz1]`, in world units, or `null` when the block is not
 * solid over that region.
 *
 * Every supported shape's top is piecewise constant or linear in the local
 * axes, so its maximum over an axis-aligned rectangle is attained on the
 * rectangle's corners (with the centre as a cheap safety sample). The block is
 * sampled at those points only, which keeps the query exact for the current
 * shapes and O(1).
 */
export function blockSolidTopOverRect(
  block: BlockState,
  grid: BlockGrid,
  rx0: number,
  rx1: number,
  rz0: number,
  rz1: number,
): number | null {
  if (!isSolidBlockKind(block.kind)) {
    return null;
  }
  const baseY = grid.origin.y + block.coord.y * grid.cellSize;
  const xs = [rx0, (rx0 + rx1) / 2, rx1];
  const zs = [rz0, (rz0 + rz1) / 2, rz1];
  let best: number | null = null;
  for (const worldX of xs) {
    for (const worldZ of zs) {
      const localX = clampLocal(
        (worldX - grid.origin.x) / grid.cellSize - block.coord.x,
      );
      const localZ = clampLocal(
        (worldZ - grid.origin.z) / grid.cellSize - block.coord.z,
      );
      const top = supportHeightAt(block, localX, localZ);
      if (top === null) {
        continue;
      }
      const worldTop = baseY + top * grid.cellSize;
      if (best === null || worldTop > best) {
        best = worldTop;
      }
    }
  }
  return best;
}

/** Canonical string key for a cell. Private to the store. */
export function cellKey(coord: CellCoord): string {
  return `${coord.x}|${coord.y}|${coord.z}`;
}

/**
 * Read-only block access used by placement and movement. Kept as an interface
 * so the pure geometry/rules can be exercised without the write store.
 */
export interface BlockReadPort {
  get(coord: CellCoord): BlockState | undefined;
  /** Blocks whose cell AABB intersects the world-space AABB `[min, max]`. */
  queryAabb(min: Vec3, max: Vec3): BlockState[];
  /** Every non-air block, in deterministic order. */
  entries(): BlockState[];
}

/** Mutable authoritative block store + read access. */
export interface BlockStore extends BlockReadPort {
  has(coord: CellCoord): boolean;
  /**
   * Set the block at `coord`. `kind: 'air'` is a REMOVAL (it is the same
   * operation as {@link BlockStore.remove}); there is no way to store air.
   * Always returns exactly one `block.changed` event describing the result.
   */
  set(coord: CellCoord, kind: BlockKind, orientation: BlockOrientation): BlockChangedEvent;
  /** Remove the block at `coord`. Always returns one `block.changed` (kind `air`). */
  remove(coord: CellCoord): BlockChangedEvent;
  /** The chunks that currently contain at least one block, in deterministic order. */
  chunks(): ChunkCoord[];
  /** The cells of one chunk, in deterministic order. */
  cellsInChunk(chunk: ChunkCoord): CellCoord[];
  size(): number;
}

function compareCells(a: CellCoord, b: CellCoord): number {
  // Layered, then north-to-south, then west-to-east; deterministic and stable.
  if (a.y !== b.y) return a.y - b.y;
  if (a.z !== b.z) return a.z - b.z;
  return a.x - b.x;
}

function copyCoord(coord: CellCoord): CellCoord {
  return { x: coord.x, y: coord.y, z: coord.z };
}

function copyBlock(block: BlockState): BlockState {
  return { coord: copyCoord(block.coord), kind: block.kind, orientation: block.orientation };
}

/**
 * Create the authoritative sparse block store.
 *
 * Non-air blocks only (air is absence), at most one block per absolute
 * `CellCoord`, and a deterministic emission order. The internal CHUNK index is
 * a storage/addressing boundary only: it is used for bounded spatial queries
 * and never crosses the wire (the v9 snapshot carries absolute cells).
 */
export function createBlockStore(
  grid: BlockGrid,
  initial: readonly BlockState[] = [],
): BlockStore {
  const blocks = new Map<string, BlockState>();
  const chunkIndex = new Map<string, Set<string>>();

  const chunkKeyOf = (coord: CellCoord): string => {
    const chunk = cellToChunk(coord);
    return `${chunk.x}|${chunk.y}|${chunk.z}`;
  };

  const insert = (block: BlockState): void => {
    const key = cellKey(block.coord);
    blocks.set(key, copyBlock(block));
    const chunkKey = chunkKeyOf(block.coord);
    let cells = chunkIndex.get(chunkKey);
    if (cells === undefined) {
      cells = new Set<string>();
      chunkIndex.set(chunkKey, cells);
    }
    cells.add(key);
  };

  const erase = (coord: CellCoord): void => {
    const key = cellKey(coord);
    if (!blocks.has(key)) {
      return;
    }
    blocks.delete(key);
    const chunkKey = chunkKeyOf(coord);
    const cells = chunkIndex.get(chunkKey);
    if (cells !== undefined) {
      cells.delete(key);
      if (cells.size === 0) {
        chunkIndex.delete(chunkKey);
      }
    }
  };

  for (const block of initial) {
    if (block.kind === 'air') {
      continue;
    }
    insert(block);
  }

  const removeBlock = (coord: CellCoord): BlockChangedEvent => {
    const existing = blocks.get(cellKey(coord));
    const orientation = existing?.orientation ?? 0;
    erase(coord);
    return { type: 'block.changed', coord: copyCoord(coord), kind: 'air', orientation };
  };

  const queryAabb = (min: Vec3, max: Vec3): BlockState[] => {
    const size = grid.cellSize;
    const minCellX = Math.floor((min.x - grid.origin.x) / size);
    const maxCellX = Math.floor((max.x - grid.origin.x) / size);
    const minCellY = Math.floor((min.y - grid.origin.y) / size);
    const maxCellY = Math.floor((max.y - grid.origin.y) / size);
    const minCellZ = Math.floor((min.z - grid.origin.z) / size);
    const maxCellZ = Math.floor((max.z - grid.origin.z) / size);
    const found: BlockState[] = [];
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let z = minCellZ; z <= maxCellZ; z += 1) {
        for (let x = minCellX; x <= maxCellX; x += 1) {
          const block = blocks.get(`${x}|${y}|${z}`);
          if (block !== undefined) {
            found.push(copyBlock(block));
          }
        }
      }
    }
    return found;
  };

  return {
    get(coord: CellCoord): BlockState | undefined {
      const block = blocks.get(cellKey(coord));
      return block === undefined ? undefined : copyBlock(block);
    },
    has(coord: CellCoord): boolean {
      return blocks.has(cellKey(coord));
    },
    entries(): BlockState[] {
      return [...blocks.values()].map(copyBlock).sort((a, b) => compareCells(a.coord, b.coord));
    },
    queryAabb,
    set(coord, kind, orientation): BlockChangedEvent {
      if (kind === 'air') {
        return removeBlock(coord);
      }
      insert({ coord, kind, orientation });
      return { type: 'block.changed', coord: copyCoord(coord), kind, orientation };
    },
    remove: removeBlock,
    chunks(): ChunkCoord[] {
      return [...chunkIndex.keys()]
        .map((key) => {
          const [x, y, z] = key.split('|').map(Number);
          return { x, y, z };
        })
        .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.z !== b.z ? a.z - b.z : a.x - b.x));
    },
    cellsInChunk(chunk): CellCoord[] {
      const cells = chunkIndex.get(`${chunk.x}|${chunk.y}|${chunk.z}`);
      if (cells === undefined) {
        return [];
      }
      return [...cells]
        .map((key) => {
          const [x, y, z] = key.split('|').map(Number);
          return { x, y, z };
        })
        .sort(compareCells);
    },
    size(): number {
      return blocks.size;
    },
  };
}
