import { describe, expect, it } from 'vitest';

import {
  cellCentre,
  cellOf,
  cellToChunk,
  cellToLocal,
  chunkLocalToCell,
  chunkOriginCell,
  isBlockGrid,
  isCellCoord,
  isChunkCoord,
  isFootprintExtents,
  parseBlockGrid,
  parseCellCoord,
  parseChunkCoord,
  parseFootprintExtents,
  snapFootprintCentre,
} from '../src/index.ts';
import { captureParseError, validBlockGrid, validCellCoord } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isBlockGrid', () => {
  it('accepts a well-formed BlockGrid (including a non-1 cellSize)', () => {
    expect(isBlockGrid(validBlockGrid)).toBe(true);
    expect(isBlockGrid({ origin: { x: 10, y: -2, z: 5 }, cellSize: 0.5 })).toBe(true);
    expect(isBlockGrid({ origin: { x: 0, y: 0, z: 0 }, cellSize: 2 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isBlockGrid(value)).toBe(false);
  });

  it.each(['origin', 'cellSize'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validBlockGrid };
    delete value[key];
    expect(isBlockGrid(value)).toBe(false);
  });

  it('rejects unknown extra fields, a malformed origin, and a non-positive cellSize', () => {
    expect(isBlockGrid({ ...validBlockGrid, width: 20 })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, origin: null })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, origin: { x: 0, y: 0 } })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, cellSize: 0 })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, cellSize: -1 })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, cellSize: Number.NaN })).toBe(false);
    expect(isBlockGrid({ ...validBlockGrid, cellSize: '1' })).toBe(false);
  });
});

describe('parseBlockGrid', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockGrid(validBlockGrid)).toBe(validBlockGrid);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseBlockGrid({ ...validBlockGrid, cellSize: 0 }));
    expect(error.message).toBe('Invalid BlockGrid payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isCellCoord (3D)', () => {
  it('accepts finite integer cells of any sign on all three axes', () => {
    expect(isCellCoord(validCellCoord)).toBe(true);
    expect(isCellCoord({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(isCellCoord({ x: -4, y: 7, z: 9 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isCellCoord(value)).toBe(false);
  });

  it('REJECTS the old 2D `{ x, z }` shape and a missing `y`', () => {
    expect(isCellCoord({ x: 1, z: 2 })).toBe(false);
    expect(isCellCoord({ x: 1, y: 2 })).toBe(false);
    const missing: Record<string, unknown> = { ...validCellCoord };
    delete missing.y;
    expect(isCellCoord(missing)).toBe(false);
  });

  it('rejects unknown extra fields and non-integer/non-finite components', () => {
    expect(isCellCoord({ ...validCellCoord, w: 1 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, x: 1.5 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, y: -0.5 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, z: '3' })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, y: Number.NaN })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, x: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('parseCellCoord', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseCellCoord(validCellCoord)).toBe(validCellCoord);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseCellCoord({ x: 1, z: 2 }));
    expect(error.message).toBe('Invalid CellCoord payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isChunkCoord', () => {
  it('accepts finite integer chunk coordinates of any sign', () => {
    expect(isChunkCoord({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(isChunkCoord({ x: -2, y: 3, z: -1 })).toBe(true);
  });

  it('rejects a missing axis, extra keys, and non-integers', () => {
    expect(isChunkCoord({ x: 0, y: 0 })).toBe(false);
    expect(isChunkCoord({ x: 0, y: 0, z: 0, w: 1 })).toBe(false);
    expect(isChunkCoord({ x: 0.5, y: 0, z: 0 })).toBe(false);
    expect(isChunkCoord(null)).toBe(false);
  });
});

describe('parseChunkCoord', () => {
  it('returns the value unchanged when valid', () => {
    const value = { x: 1, y: 0, z: -1 };
    expect(parseChunkCoord(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseChunkCoord({ x: 1, z: 2 }));
    expect(error.message).toBe('Invalid ChunkCoord payload');
  });
});

describe('isFootprintExtents', () => {
  it('accepts strictly positive integer x/z extents', () => {
    expect(isFootprintExtents({ x: 1, z: 1 })).toBe(true);
    expect(isFootprintExtents({ x: 2, z: 3 })).toBe(true);
  });

  it('rejects zero, negative, fractional, missing, extra, and a 3D (y) extent', () => {
    expect(isFootprintExtents({ x: 0, z: 1 })).toBe(false);
    expect(isFootprintExtents({ x: 1, z: -1 })).toBe(false);
    expect(isFootprintExtents({ x: 1, z: 1.5 })).toBe(false);
    expect(isFootprintExtents({ x: 1 })).toBe(false);
    expect(isFootprintExtents({ x: 1, z: 1, y: 1 })).toBe(false);
    expect(isFootprintExtents(null)).toBe(false);
  });
});

describe('parseFootprintExtents', () => {
  it('throws ProtocolParseError when invalid', () => {
    expect(captureParseError(() => parseFootprintExtents({ x: 0, z: 1 })).message).toBe(
      'Invalid FootprintExtents payload',
    );
  });
});

describe('cellCentre / cellOf (3D, configurable cellSize)', () => {
  it('applies the frozen 3-axis cell-centre rule', () => {
    expect(cellCentre(validBlockGrid, { x: 0, y: 0, z: 0 })).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    expect(cellCentre(validBlockGrid, { x: 2, y: 1, z: 3 })).toEqual({ x: 2.5, y: 1.5, z: 3.5 });
    expect(cellCentre(validBlockGrid, { x: -1, y: -2, z: -2 })).toEqual({
      x: -0.5,
      y: -1.5,
      z: -1.5,
    });
  });

  it('reads a NON-1 cellSize and a non-zero origin on every axis', () => {
    const grid = { origin: { x: 10, y: 1, z: -5 }, cellSize: 2 };
    expect(cellCentre(grid, { x: 1, y: 2, z: 0 })).toEqual({ x: 13, y: 6, z: -4 });
  });

  it('cellOf inverts cellCentre for many cells, including negatives', () => {
    const grid = { origin: { x: -3, y: 2, z: 4 }, cellSize: 0.5 };
    const cells = [
      { x: 0, y: 0, z: 0 },
      { x: 9, y: -3, z: 9 },
      { x: -1, y: -2, z: -2 },
      { x: 3, y: 7, z: -4 },
    ];
    for (const cell of cells) {
      expect(cellOf(grid, cellCentre(grid, cell))).toEqual(cell);
    }
  });

  it('cellOf resolves y as well (no ground-plane special case) and never clamps', () => {
    expect(cellOf(validBlockGrid, { x: -0.1, y: 2.1, z: -0.1 })).toEqual({ x: -1, y: 2, z: -1 });
    expect(cellOf(validBlockGrid, { x: 100, y: 5, z: 100 })).toEqual({ x: 100, y: 5, z: 100 });
  });
});

describe('chunk conversions', () => {
  it('maps a cell to its chunk and local index with floor division', () => {
    expect(cellToChunk({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(cellToChunk({ x: 15, y: 16, z: 31 })).toEqual({ x: 0, y: 1, z: 1 });
    expect(cellToChunk({ x: 16, y: 32, z: 32 })).toEqual({ x: 1, y: 2, z: 2 });
    expect(cellToLocal({ x: 15, y: 16, z: 31 })).toEqual({ x: 15, y: 0, z: 15 });
  });

  it('uses FLOOR division (not truncation) for negative coordinates', () => {
    expect(cellToChunk({ x: -1, y: -16, z: -17 })).toEqual({ x: -1, y: -1, z: -2 });
    expect(cellToLocal({ x: -1, y: -16, z: -17 })).toEqual({ x: 15, y: 0, z: 15 });
  });

  it('round-trips cell -> chunk + local -> cell in BOTH directions, including negatives', () => {
    const cells = [
      { x: 0, y: 0, z: 0 },
      { x: 16, y: 0, z: 0 },
      { x: -1, y: -16, z: -17 },
      { x: -33, y: 47, z: -64 },
      { x: 1000, y: -1000, z: 999 },
    ];
    for (const cell of cells) {
      const chunk = cellToChunk(cell);
      const local = cellToLocal(cell);
      expect(local.x).toBeGreaterThanOrEqual(0);
      expect(local.x).toBeLessThan(16);
      expect(chunkLocalToCell(chunk, local)).toEqual(cell);
    }
  });

  it('chunkOriginCell is the chunk low corner and never exceeds the cell', () => {
    const chunk = cellToChunk({ x: -1, y: 17, z: 40 });
    expect(chunkOriginCell(chunk)).toEqual({ x: -16, y: 16, z: 32 });
    const origin = chunkOriginCell(chunk);
    expect(origin.x).toBeLessThanOrEqual(-1);
    expect(origin.y).toBeLessThanOrEqual(17);
    expect(origin.z).toBeLessThanOrEqual(40);
  });
});

describe('snapFootprintCentre (the shared placement lattice)', () => {
  const grid = { origin: { x: 0, y: 0, z: 0 }, cellSize: 1 };

  it('leaves a footprint already on the lattice untouched (odd extent -> cell centre)', () => {
    expect(snapFootprintCentre({ x: 2.5, y: 1.25, z: 3.5 }, { x: 1, z: 1 }, grid)).toEqual({
      x: 2.5,
      y: 1.25,
      z: 3.5,
    });
  });

  it('snaps an odd extent onto cell centres and an even extent onto cell boundaries', () => {
    expect(snapFootprintCentre({ x: 2.4, y: 0.5, z: 0.5 }, { x: 1, z: 1 }, grid)).toEqual({
      x: 2.5,
      y: 0.5,
      z: 0.5,
    });
    expect(snapFootprintCentre({ x: 2.4, y: 0.5, z: 0.4 }, { x: 2, z: 2 }, grid)).toEqual({
      x: 2,
      y: 0.5,
      z: 0,
    });
  });

  it('breaks an exact half-way tie by round-half-up on the lattice index', () => {
    // Even footprint: lattice at 2.0 / 3.0, requested 2.5 -> 3.0 (up).
    expect(snapFootprintCentre({ x: 2.5, y: 0.5, z: 0.5 }, { x: 2, z: 2 }, grid).x).toBe(3);
    // Odd footprint: lattice at 0.5 / 1.5, requested 1.0 -> 1.5 (up).
    expect(snapFootprintCentre({ x: 1.0, y: 0.5, z: 0.5 }, { x: 1, z: 1 }, grid).x).toBe(1.5);
  });

  it('passes y through unchanged (vertical placement is support, not footprint)', () => {
    expect(snapFootprintCentre({ x: 2.4, y: 7.75, z: 0.5 }, { x: 1, z: 1 }, grid).y).toBe(7.75);
  });

  it('rotation that preserves parity never moves the axis (2x2, 2x4, 1x3)', () => {
    for (const extents of [
      { x: 2, z: 2 },
      { x: 2, z: 4 },
      { x: 1, z: 3 },
    ]) {
      const committed =
        extents.x % 2 === 1 ? { x: 2.5, y: 0, z: 3.5 } : { x: 2, y: 0, z: 4 };
      const rotated = { x: extents.z, z: extents.x };
      const resolved = snapFootprintCentre(committed, extents, grid);
      const afterRotate = snapFootprintCentre(resolved, rotated, grid);
      expect(afterRotate).toEqual(resolved);
    }
  });

  it('rotation that changes parity shifts that axis by exactly half a cell (1x2, 2x3)', () => {
    // 1x2 committed on its lattice (x cell centre, z boundary).
    const forOneByTwo = snapFootprintCentre({ x: 2.5, y: 0, z: 3 }, { x: 1, z: 2 }, grid);
    const rotatedOneByTwo = snapFootprintCentre(forOneByTwo, { x: 2, z: 1 }, grid);
    expect(Math.abs(rotatedOneByTwo.x - forOneByTwo.x)).toBe(0.5);
    expect(Math.abs(rotatedOneByTwo.z - forOneByTwo.z)).toBe(0.5);

    // 2x3: BOTH axes change parity.
    const forTwoByThree = snapFootprintCentre({ x: 2.5, y: 0, z: 3.5 }, { x: 2, z: 3 }, grid);
    const rotatedTwoByThree = snapFootprintCentre(forTwoByThree, { x: 3, z: 2 }, grid);
    expect(Math.abs(rotatedTwoByThree.x - forTwoByThree.x)).toBe(0.5);
    expect(Math.abs(rotatedTwoByThree.z - forTwoByThree.z)).toBe(0.5);
  });

  it('honours a non-1 cellSize and a non-zero origin', () => {
    const bigGrid = { origin: { x: 10, y: 0, z: -5 }, cellSize: 2 };
    // Odd footprint -> cell centre at origin + (i + 0.5) * 2; y passes through.
    expect(snapFootprintCentre({ x: 12.9, y: 1.1, z: -3.9 }, { x: 1, z: 1 }, bigGrid)).toEqual({
      x: 13,
      y: 1.1,
      z: -4,
    });
    // Even footprint -> cell boundary at origin + i * 2.
    expect(snapFootprintCentre({ x: 12.9, y: 1.1, z: -3.9 }, { x: 2, z: 2 }, bigGrid)).toEqual({
      x: 12,
      y: 1.1,
      z: -3,
    });
  });
});
