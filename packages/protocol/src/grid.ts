import { ProtocolParseError } from './errors.ts';
import {
  hasExactKeys,
  isFiniteInteger,
  isPositiveFiniteInteger,
  isPositiveFiniteNumber,
  isRecord,
} from './internal.ts';
import { isVec3 } from './math.ts';
import type { Vec3 } from './math.ts';

/**
 * The block grid: the discrete, integer-`XYZ` addressing layer of the WORLD
 * TOPOLOGY. It is one of the two orthogonal systems that share the single real
 * 3D coordinate system (`+X` East, `+Y` Up, `+Z` South):
 *
 * ```text
 * Block World  (discrete)  <-- this module: integer cells, chunks, topology
 * Entity World (continuous) <-- EntityState.transform: Vec3 + Quat
 * ```
 *
 * A cell is a **volume**, not a ground-plane tile: all three axes are integers
 * and every axis is derived through the same frozen rule. This replaced the
 * phase-14 2D `CellCoord { x, z }` and the `GridSpec` that owned it.
 *
 * `BlockGrid` is pure configuration: an `origin` corner and a `cellSize` in
 * world units. **No algorithm may hardcode `1`**: `cellSize` defaults to one
 * world unit in the authored world, but every derivation below multiplies by
 * it.
 */
export interface BlockGrid {
  /** The grid's minimum corner (`cell(0, 0, 0)`'s low corner). */
  origin: Vec3;
  /** The size of one cell edge in world units. Strictly positive; not forced to 1. */
  cellSize: number;
}

/** An integer cell address in the block grid. All three axes are integers. */
export interface CellCoord {
  x: number;
  y: number;
  z: number;
}

/** An integer chunk address: one chunk is {@link CHUNK_SIZE} cells on every axis. */
export interface ChunkCoord {
  x: number;
  y: number;
  z: number;
}

/**
 * An entity's horizontal footprint measured in **whole cells** (strictly
 * positive integers on `x`/`z`). Footprints are frequently non-square and
 * mixed-parity (1x2, 2x3, 3x4) and that is a first-class, required case.
 *
 * A footprint is deliberately 2D: the vertical placement of a grid-snapped
 * entity is resolved by the server's support query, not by a footprint lattice.
 */
export interface FootprintExtents {
  x: number;
  z: number;
}

/**
 * Cells per chunk edge on every axis. Chunks are the storage/addressing/rebuild
 * boundary; they are deliberately **not** a wire encoding in v1 (the snapshot
 * carries absolute `CellCoord`s, never chunk-local indices).
 */
export const CHUNK_SIZE = 16;

const BLOCK_GRID_KEYS = ['origin', 'cellSize'] as const;
const CELL_COORD_KEYS = ['x', 'y', 'z'] as const;
const CHUNK_COORD_KEYS = ['x', 'y', 'z'] as const;
const FOOTPRINT_EXTENTS_KEYS = ['x', 'z'] as const;

/**
 * Structural guard for `BlockGrid` (exactly `{ origin, cellSize }`).
 * `origin` is a finite `Vec3`; `cellSize` is strictly positive and may be
 * fractional (a sub-unit or multi-unit cell is legal configuration).
 */
export function isBlockGrid(value: unknown): value is BlockGrid {
  if (!isRecord(value) || !hasExactKeys(value, BLOCK_GRID_KEYS)) {
    return false;
  }
  return isVec3(value.origin) && isPositiveFiniteNumber(value.cellSize);
}

/** Parse and validate `BlockGrid`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockGrid(value: unknown): BlockGrid {
  if (!isBlockGrid(value)) {
    throw new ProtocolParseError('Invalid BlockGrid payload');
  }
  return value;
}

/**
 * Structural guard for `CellCoord` (exactly `{ x, y, z }`, all finite
 * integers). A 2D `{ x, z }` shape or any extra key is rejected: the block
 * grid is 3D.
 */
export function isCellCoord(value: unknown): value is CellCoord {
  if (!isRecord(value) || !hasExactKeys(value, CELL_COORD_KEYS)) {
    return false;
  }
  return isFiniteInteger(value.x) && isFiniteInteger(value.y) && isFiniteInteger(value.z);
}

/** Parse and validate `CellCoord`, throwing `ProtocolParseError` on mismatch. */
export function parseCellCoord(value: unknown): CellCoord {
  if (!isCellCoord(value)) {
    throw new ProtocolParseError('Invalid CellCoord payload');
  }
  return value;
}

/** Structural guard for `ChunkCoord` (exactly `{ x, y, z }`, all finite integers). */
export function isChunkCoord(value: unknown): value is ChunkCoord {
  if (!isRecord(value) || !hasExactKeys(value, CHUNK_COORD_KEYS)) {
    return false;
  }
  return isFiniteInteger(value.x) && isFiniteInteger(value.y) && isFiniteInteger(value.z);
}

/** Parse and validate `ChunkCoord`, throwing `ProtocolParseError` on mismatch. */
export function parseChunkCoord(value: unknown): ChunkCoord {
  if (!isChunkCoord(value)) {
    throw new ProtocolParseError('Invalid ChunkCoord payload');
  }
  return value;
}

/**
 * Structural guard for `FootprintExtents` (exactly `{ x, z }`, both strictly
 * positive finite integers). Zero is rejected: a footprint always covers at
 * least one cell on every horizontal axis.
 */
export function isFootprintExtents(value: unknown): value is FootprintExtents {
  if (!isRecord(value) || !hasExactKeys(value, FOOTPRINT_EXTENTS_KEYS)) {
    return false;
  }
  return isPositiveFiniteInteger(value.x) && isPositiveFiniteInteger(value.z);
}

/** Parse and validate `FootprintExtents`, throwing `ProtocolParseError` on mismatch. */
export function parseFootprintExtents(value: unknown): FootprintExtents {
  if (!isFootprintExtents(value)) {
    throw new ProtocolParseError('Invalid FootprintExtents payload');
  }
  return value;
}

/**
 * Cell-centre rule (integer cell -> continuous world position), frozen and
 * shared by both sides of the wire:
 *
 * ```text
 * cellCentre.a = origin.a + (cell.a + 0.5) * cellSize   for a in { x, y, z }
 * ```
 *
 * All three axes are derived; `cell(0, 0, 0)`'s centre is
 * `origin + 0.5 * cellSize` on every axis, deliberately decoupled from the
 * world origin. `cellSize` is read from the grid and is never assumed to be 1.
 */
export function cellCentre(grid: BlockGrid, cell: CellCoord): Vec3 {
  return {
    x: grid.origin.x + (cell.x + 0.5) * grid.cellSize,
    y: grid.origin.y + (cell.y + 0.5) * grid.cellSize,
    z: grid.origin.z + (cell.z + 0.5) * grid.cellSize,
  };
}

/**
 * The inverse of {@link cellCentre} (continuous world position -> integer
 * cell): the cell whose 3D volume contains the position.
 *
 * `x`, `y` and `z` are all resolved; there is no "ignore `y`" ground-plane
 * special case any more. The result is not clamped to any world size:
 * positions outside the grid produce cells outside it.
 */
export function cellOf(grid: BlockGrid, position: Vec3): CellCoord {
  return {
    x: Math.floor((position.x - grid.origin.x) / grid.cellSize),
    y: Math.floor((position.y - grid.origin.y) / grid.cellSize),
    z: Math.floor((position.z - grid.origin.z) / grid.cellSize),
  };
}

/** Floor division: `Math.floor(a / b)` (correct for negative values, not truncation). */
function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/** Floor modulo: always in `[0, divisor)`, correct for negative values. */
function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Chunk containing a cell: floor division by `CHUNK_SIZE` on every axis. */
export function cellToChunk(cell: CellCoord): ChunkCoord {
  return {
    x: floorDiv(cell.x, CHUNK_SIZE),
    y: floorDiv(cell.y, CHUNK_SIZE),
    z: floorDiv(cell.z, CHUNK_SIZE),
  };
}

/** Cell index inside its chunk: floor modulo `CHUNK_SIZE`, always `[0, CHUNK_SIZE)`. */
export function cellToLocal(cell: CellCoord): CellCoord {
  return {
    x: floorMod(cell.x, CHUNK_SIZE),
    y: floorMod(cell.y, CHUNK_SIZE),
    z: floorMod(cell.z, CHUNK_SIZE),
  };
}

/** Chunk + local index -> absolute cell: `chunk * CHUNK_SIZE + local`. */
export function chunkLocalToCell(chunk: ChunkCoord, local: CellCoord): CellCoord {
  return {
    x: chunk.x * CHUNK_SIZE + local.x,
    y: chunk.y * CHUNK_SIZE + local.y,
    z: chunk.z * CHUNK_SIZE + local.z,
  };
}

/** The chunk's origin cell (its lowest-corner cell): `chunk * CHUNK_SIZE`. */
export function chunkOriginCell(chunk: ChunkCoord): CellCoord {
  return {
    x: chunk.x * CHUNK_SIZE,
    y: chunk.y * CHUNK_SIZE,
    z: chunk.z * CHUNK_SIZE,
  };
}

/**
 * Round half up on the lattice index: ties (exactly halfway between two lattice
 * points) resolve toward `+Infinity`. `Math.round` has exactly this behaviour,
 * including for negatives, and it is the frozen, deterministic tie-break.
 */
function roundHalfUp(value: number): number {
  return Math.round(value);
}

/**
 * Snap one axis of a requested centre onto the footprint lattice.
 *
 * The lattice rule (frozen, documented in `docs/architecture.md`): for a
 * footprint extent `E` on an axis, a valid committed centre is a **cell centre**
 * when `E` is odd and a **cell boundary** when `E` is even.
 *
 * ```text
 * offset  = E odd ? 0.5 : 0
 * index   = roundHalfUp((value - origin) / cellSize - offset)
 * snapped = origin + (index + offset) * cellSize
 * ```
 *
 * Because the offset is chosen from the extent's parity, a rotation that
 * changes that parity moves the axis by exactly half a cell, while a rotation
 * that preserves parity leaves it untouched. The tie-break (round half up on
 * the index) is explicit so "deterministic" is a real property, not a claim.
 */
function snapAxis(value: number, origin: number, cellSize: number, extent: number): number {
  const offset = extent % 2 === 1 ? 0.5 : 0;
  const index = roundHalfUp((value - origin) / cellSize - offset);
  return origin + (index + offset) * cellSize;
}

/**
 * Pure geometry: the canonical committed centre for a requested centre and an
 * entity footprint, on the shared snap lattice.
 *
 * Only the horizontal `x`/`z` axes are snapped to the footprint lattice; `y` is
 * passed through unchanged, because the vertical placement is resolved by the
 * server's support query rather than by a footprint rule.
 *
 * This helper is **deliberately shared** between the Manager's Placement
 * Resolver and the client's pending placement ghost: the client must align its
 * ghost identically without re-deriving the parity/tie-break rule, and the
 * client must not keep a second source of truth. It answers "where would the
 * centre land" ONLY. It never decides whether the placement is legal
 * (support, occupancy conflicts, terrain permission, permissions) — that
 * remains a server-only Manager judgement.
 *
 * `extents` is the entity's current horizontal footprint in whole cells. For a
 * grid-snapped placeable, rotation swaps the horizontal extents, which is what
 * turns the parity rule into the deterministic half-cell shift.
 */
export function snapFootprintCentre(
  centre: Vec3,
  extents: FootprintExtents,
  grid: BlockGrid,
): Vec3 {
  return {
    x: snapAxis(centre.x, grid.origin.x, grid.cellSize, extents.x),
    y: centre.y,
    z: snapAxis(centre.z, grid.origin.z, grid.cellSize, extents.z),
  };
}
