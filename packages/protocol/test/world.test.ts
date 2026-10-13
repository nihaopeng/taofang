import { describe, expect, it } from 'vitest';

import {
  cellCentre,
  cellOf,
  isCellCoord,
  isColliderKind,
  isColliderShape,
  isColliderState,
  isGetWorldResponse,
  isGridSpec,
  isSurfaceKind,
  isSurfaceState,
  isTerrainKind,
  isTileState,
  isWorldBounds,
  isWorldSnapshot,
  parseCellCoord,
  parseColliderKind,
  parseColliderState,
  parseGetWorldResponse,
  parseGridSpec,
  parseSurfaceKind,
  parseSurfaceState,
  parseTerrainKind,
  parseTileState,
  parseWorldBounds,
  parseWorldSnapshot,
} from '../src/index.ts';
import {
  captureParseError,
  phase6WorldSnapshot,
  phase7WorldSnapshot,
  validCellCoord,
  validColliderState,
  validEntityState,
  validGridSpec,
  validSurfaceState,
  validTileState,
  validWorldBounds,
  validWorldSnapshot,
} from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isWorldBounds', () => {
  it('accepts a well-formed WorldBounds', () => {
    expect(isWorldBounds(validWorldBounds)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldBounds(value)).toBe(false);
  });

  it.each(['min', 'max'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validWorldBounds };
    delete value[key];
    expect(isWorldBounds(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isWorldBounds({ ...validWorldBounds, center: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(isWorldBounds({ ...validWorldBounds, min: null })).toBe(false);
    expect(isWorldBounds({ ...validWorldBounds, min: { x: 0, y: 0 } })).toBe(false);
    expect(isWorldBounds({ ...validWorldBounds, max: { x: 0, y: 0, z: '1' } })).toBe(false);
  });
});

describe('parseWorldBounds', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseWorldBounds(validWorldBounds)).toBe(validWorldBounds);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldBounds({ min: null, max: null }));
    expect(error.message).toBe('Invalid WorldBounds payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isGridSpec', () => {
  it('accepts a well-formed GridSpec (including a fractional cellSize)', () => {
    expect(isGridSpec(validGridSpec)).toBe(true);
    expect(isGridSpec({ ...validGridSpec, cellSize: 0.5 })).toBe(true);
    expect(isGridSpec({ ...validGridSpec, width: 4.5, depth: 2.25 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGridSpec(value)).toBe(false);
  });

  it.each(['origin', 'width', 'depth', 'cellSize'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validGridSpec };
    delete value[key];
    expect(isGridSpec(value)).toBe(false);
  });

  it('rejects zero, negative, and non-finite dimensions', () => {
    expect(isGridSpec({ ...validGridSpec, width: 0 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, depth: 0 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, cellSize: 0 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, width: -1 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, depth: -1 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, cellSize: -0.5 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, width: Number.NaN })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, depth: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, cellSize: '1' })).toBe(false);
  });

  it('rejects unknown extra fields and a malformed origin', () => {
    expect(isGridSpec({ ...validGridSpec, height: 1 })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, origin: null })).toBe(false);
    expect(isGridSpec({ ...validGridSpec, origin: { x: 0, y: 0 } })).toBe(false);
  });
});

describe('parseGridSpec', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseGridSpec(validGridSpec)).toBe(validGridSpec);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGridSpec({ ...validGridSpec, cellSize: 0 }));
    expect(error.message).toBe('Invalid GridSpec payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isCellCoord', () => {
  it('accepts finite integer coordinates of any sign', () => {
    expect(isCellCoord(validCellCoord)).toBe(true);
    expect(isCellCoord({ x: 0, z: 0 })).toBe(true);
    expect(isCellCoord({ x: -4, z: 9 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isCellCoord(value)).toBe(false);
  });

  it.each(['x', 'z'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validCellCoord };
    delete value[key];
    expect(isCellCoord(value)).toBe(false);
  });

  it('rejects a 2D `{ x, y }` shape and unknown extra fields', () => {
    expect(isCellCoord({ x: 1, y: 2 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, y: 9 })).toBe(false);
  });

  it('rejects non-integers, non-numbers, and non-finite values', () => {
    expect(isCellCoord({ ...validCellCoord, x: 1.5 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, z: 2.5 })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, x: '2' })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, z: null })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, x: Number.NaN })).toBe(false);
    expect(isCellCoord({ ...validCellCoord, z: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('parseCellCoord', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseCellCoord(validCellCoord)).toBe(validCellCoord);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseCellCoord({ x: 1.5, z: 2 }));
    expect(error.message).toBe('Invalid CellCoord payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isTerrainKind', () => {
  it('accepts exactly grass, path, blocked, and water', () => {
    expect(isTerrainKind('grass')).toBe(true);
    expect(isTerrainKind('path')).toBe(true);
    expect(isTerrainKind('blocked')).toBe(true);
    expect(isTerrainKind('water')).toBe(true);
  });

  it('rejects an unknown value even though the union grew (exact-union regression guard)', () => {
    expect(isTerrainKind('lava')).toBe(false);
  });

  it.each([
    ['a non-member literal', 'lava'],
    ['the empty string', ''],
    ['a number', 0],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isTerrainKind(value)).toBe(false);
  });
});

describe('parseTerrainKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTerrainKind('path')).toBe('path');
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTerrainKind('lava'));
    expect(error.message).toBe('Invalid TerrainKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isTileState', () => {
  it('accepts a well-formed TileState (cell + terrain, no position)', () => {
    expect(isTileState(validTileState)).toBe(true);
    expect(isTileState({ ...validTileState, terrain: 'water' })).toBe(true);
  });

  it('REJECTS a TileState carrying a `transform` key (the grid holds no position)', () => {
    expect(isTileState({ cell: validCellCoord, terrain: 'grass', transform: { x: 1, y: 2 } })).toBe(
      false,
    );
    // The phase-6 tile shape must not be accepted.
    expect(isTileState({ transform: { x: 2, y: 3 }, terrain: 'grass' })).toBe(false);
  });

  it('REJECTS a TileState carrying a `level` key (no integer-level/heightmap model)', () => {
    expect(isTileState({ cell: validCellCoord, terrain: 'grass', level: 0 })).toBe(false);
    expect(isTileState({ cell: validCellCoord, terrain: 'grass', level: 3 })).toBe(false);
    // The rejected model must not be accepted under any spelling either.
    expect(isTileState({ cell: validCellCoord, terrain: 'grass', height: 1 })).toBe(false);
    expect(isTileState({ cell: validCellCoord, terrain: 'grass', elevation: 1 })).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isTileState(value)).toBe(false);
  });

  it.each(['cell', 'terrain'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validTileState };
    delete value[key];
    expect(isTileState(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isTileState({ ...validTileState, walkable: true })).toBe(false);
    expect(isTileState({ ...validTileState, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type for each field', () => {
    expect(isTileState({ ...validTileState, cell: null })).toBe(false);
    expect(isTileState({ ...validTileState, cell: { x: 1, y: 2 } })).toBe(false);
    expect(isTileState({ ...validTileState, cell: { x: 1.5, z: 2 } })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: 'lava' })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: 1 })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: null })).toBe(false);
  });
});

describe('parseTileState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTileState(validTileState)).toBe(validTileState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTileState({ ...validTileState, terrain: 'lava' }));
    expect(error.message).toBe('Invalid TileState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isSurfaceKind', () => {
  it("accepts exactly ground, platform, ramp, and bridge", () => {
    expect(isSurfaceKind('ground')).toBe(true);
    expect(isSurfaceKind('platform')).toBe(true);
    expect(isSurfaceKind('ramp')).toBe(true);
    expect(isSurfaceKind('bridge')).toBe(true);
  });

  it.each([
    ['an unknown member', 'stair'],
    ['the empty string', ''],
    ['a number', 0],
    ['null', null],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isSurfaceKind(value)).toBe(false);
  });
});

describe('parseSurfaceKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseSurfaceKind('ramp')).toBe('ramp');
  });

  it('throws ProtocolParseError on an unknown value', () => {
    const error = captureParseError(() => parseSurfaceKind('stair'));
    expect(error.message).toBe('Invalid SurfaceKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isSurfaceState', () => {
  it('accepts a well-formed, walkable, up-facing flat surface', () => {
    expect(isSurfaceState(validSurfaceState)).toBe(true);
  });

  it('accepts an up-facing but NON-walkable surface (real geometry, no traversal)', () => {
    // A too-steep slope / roof / rule-only patch: the geometry is legal
    // (up-facing) while traversal is not. This is a normal, expected case.
    expect(isSurfaceState({ ...validSurfaceState, walkable: false })).toBe(true);
    expect(isSurfaceState({ ...validSurfaceState, kind: 'ramp', walkable: false })).toBe(true);
  });

  it('accepts a tilted ramp-shaped surface (axis vectors gain a y component)', () => {
    expect(
      isSurfaceState({
        ...validSurfaceState,
        kind: 'ramp',
        center: { x: 0, y: 1, z: 0 },
        axisU: { x: 0, y: 1, z: 2 },
        axisV: { x: 2, y: 0, z: 0 },
      }),
    ).toBe(true);
  });

  it('REJECTS a VERTICAL patch (plane normal is horizontal, cross.y === 0)', () => {
    expect(
      isSurfaceState({
        ...validSurfaceState,
        // axisU along +x, axisV along +y: the patch stands upright.
        axisU: { x: 0.5, y: 0, z: 0 },
        axisV: { x: 0, y: 0.5, z: 0 },
      }),
    ).toBe(false);
  });

  it('REJECTS a DOWN-FACING ceiling (cross.y < 0) even though it defines a plane', () => {
    expect(
      isSurfaceState({
        ...validSurfaceState,
        axisU: { x: 0.5, y: 0, z: 0 },
        axisV: { x: 0, y: 0, z: 0.5 },
      }),
    ).toBe(false);
  });

  it('accepts MANY surfaces sharing one (x, z) column at different y (bridge over a bed)', () => {
    const bed = { ...validSurfaceState, surfaceId: 'surface-bed', center: { x: 0, y: -2, z: 0 } };
    const deck = { ...validSurfaceState, surfaceId: 'surface-deck', center: { x: 0, y: 3, z: 0 } };
    expect(isSurfaceState(bed)).toBe(true);
    expect(isSurfaceState(deck)).toBe(true);
    expect(bed.center.x).toBe(deck.center.x);
    expect(bed.center.z).toBe(deck.center.z);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isSurfaceState(value)).toBe(false);
  });

  it.each(['surfaceId', 'kind', 'center', 'axisU', 'axisV', 'walkable'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validSurfaceState };
      delete value[key];
      expect(isSurfaceState(value)).toBe(false);
    },
  );

  it('rejects extra keys, including a `level` / slope rule', () => {
    expect(isSurfaceState({ ...validSurfaceState, level: 1 })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, normal: { x: 0, y: 1, z: 0 } })).toBe(false);
    // No slope / traversability rule may leak into the contract.
    expect(isSurfaceState({ ...validSurfaceState, slope: 0.5 })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, maxSlopeDegrees: 45 })).toBe(false);
  });

  it('rejects a missing or non-boolean `walkable` (walkability must be explicit)', () => {
    const missing: Record<string, unknown> = { ...validSurfaceState };
    delete missing.walkable;
    expect(isSurfaceState(missing)).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, walkable: 'yes' })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, walkable: 1 })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, walkable: null })).toBe(false);
  });

  it('rejects a malformed id, kind, or vector', () => {
    expect(isSurfaceState({ ...validSurfaceState, surfaceId: '' })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, surfaceId: 1 })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, kind: 'stair' })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, center: null })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, center: { x: 0, y: 0 } })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, axisU: { x: '1', y: 0, z: 0 } })).toBe(false);
  });

  it('rejects degenerate patches whose axis vectors do not define a plane', () => {
    expect(isSurfaceState({ ...validSurfaceState, axisU: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(isSurfaceState({ ...validSurfaceState, axisV: { x: 0, y: 0, z: 0 } })).toBe(false);
    // Parallel axes (here: same direction) are degenerate.
    expect(isSurfaceState({ ...validSurfaceState, axisV: { x: 2, y: 0, z: 0 } })).toBe(false);
    expect(
      isSurfaceState({ ...validSurfaceState, axisU: { x: 1, y: 1, z: 1 }, axisV: { x: 2, y: 2, z: 2 } }),
    ).toBe(false);
  });
});

describe('parseSurfaceState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseSurfaceState(validSurfaceState)).toBe(validSurfaceState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseSurfaceState({ ...validSurfaceState, kind: 'stair' }));
    expect(error.message).toBe('Invalid SurfaceState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isColliderKind', () => {
  it("accepts exactly wall, rock, water, and structure", () => {
    expect(isColliderKind('wall')).toBe(true);
    expect(isColliderKind('rock')).toBe(true);
    expect(isColliderKind('water')).toBe(true);
    expect(isColliderKind('structure')).toBe(true);
  });

  it.each([
    ['an unknown member', 'tree'],
    ['the empty string', ''],
    ['a number', 0],
    ['null', null],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isColliderKind(value)).toBe(false);
  });
});

describe('parseColliderKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseColliderKind('wall')).toBe('wall');
  });

  it('throws ProtocolParseError on an unknown value', () => {
    const error = captureParseError(() => parseColliderKind('tree'));
    expect(error.message).toBe('Invalid ColliderKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isColliderShape', () => {
  it('accepts the aabb variant', () => {
    expect(
      isColliderShape({ kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    ).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isColliderShape(value)).toBe(false);
  });

  it.each(['kind', 'min', 'max'])('rejects an aabb shape missing %s', (key) => {
    const value: Record<string, unknown> = {
      kind: 'aabb',
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    };
    delete value[key];
    expect(isColliderShape(value)).toBe(false);
  });

  it('rejects an unknown shape.kind (the only variant today is aabb)', () => {
    expect(
      isColliderShape({ kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1 }),
    ).toBe(false);
    expect(
      isColliderShape({ kind: 'obb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    ).toBe(false);
    expect(
      isColliderShape({ kind: 'AABB', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    ).toBe(false);
  });

  it('rejects extra keys inside the aabb shape', () => {
    expect(
      isColliderShape({
        kind: 'aabb',
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
        radius: 1,
      }),
    ).toBe(false);
    expect(
      isColliderShape({
        kind: 'aabb',
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
        level: 1,
      }),
    ).toBe(false);
  });

  it('rejects malformed or non-positive corners inside the aabb shape', () => {
    expect(isColliderShape({ kind: 'aabb', min: null, max: { x: 1, y: 1, z: 1 } })).toBe(false);
    expect(
      isColliderShape({ kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } }),
    ).toBe(false);
    expect(
      isColliderShape({ kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    ).toBe(true);
  });
});

describe('isColliderState', () => {
  it('accepts a well-formed AABB collider', () => {
    expect(isColliderState(validColliderState)).toBe(true);
  });

  it('accepts a flat, low wall with a small but real y range', () => {
    expect(
      isColliderState({
        ...validColliderState,
        kind: 'wall',
        shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0.5, z: 0.25 } },
      }),
    ).toBe(true);
  });

  it('accepts MANY colliders overlapping in (x, z) with different y ranges', () => {
    const lowWall = {
      ...validColliderState,
      colliderId: 'collider-wall',
      shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    };
    const deckBody = {
      ...validColliderState,
      colliderId: 'collider-deck',
      shape: { kind: 'aabb', min: { x: 0, y: 4, z: 0 }, max: { x: 1, y: 4.5, z: 1 } },
    };
    expect(isColliderState(lowWall)).toBe(true);
    expect(isColliderState(deckBody)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isColliderState(value)).toBe(false);
  });

  it.each(['colliderId', 'kind', 'shape'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validColliderState };
    delete value[key];
    expect(isColliderState(value)).toBe(false);
  });

  it('rejects the old flat `{ min, max }` shape and other top-level shortcuts', () => {
    expect(
      isColliderState({
        ...validColliderState,
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
      }),
    ).toBe(false);
    expect(isColliderState({ ...validColliderState, level: 1 })).toBe(false);
    expect(isColliderState({ ...validColliderState, height: 2 })).toBe(false);
    expect(isColliderState({ ...validColliderState, size: { x: 1, y: 1, z: 1 } })).toBe(false);
  });

  it('rejects a malformed id, kind, or shape', () => {
    expect(isColliderState({ ...validColliderState, colliderId: '' })).toBe(false);
    expect(isColliderState({ ...validColliderState, colliderId: 1 })).toBe(false);
    expect(isColliderState({ ...validColliderState, kind: 'tree' })).toBe(false);
    expect(isColliderState({ ...validColliderState, shape: null })).toBe(false);
    expect(isColliderState({ ...validColliderState, shape: { kind: 'sphere' } })).toBe(false);
    expect(
      isColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: Number.NaN, z: 1 } },
      }),
    ).toBe(false);
  });

  it('REJECTS a zero or negative y extent (no infinite ground-to-sky column)', () => {
    expect(
      isColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: 0, z: 4.5 } },
      }),
    ).toBe(false);
    expect(
      isColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: -1, z: 4.5 } },
      }),
    ).toBe(false);
  });

  it('rejects a non-positive extent on any axis', () => {
    expect(
      isColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 1.5, y: 2, z: 4.5 } },
      }),
    ).toBe(false);
    expect(
      isColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: 2, z: 2.5 } },
      }),
    ).toBe(false);
  });
});

describe('parseColliderState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseColliderState(validColliderState)).toBe(validColliderState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseColliderState({
        ...validColliderState,
        shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: 0, z: 4.5 } },
      }),
    );
    expect(error.message).toBe('Invalid ColliderState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('cellCentre / cellOf (the shared world <-> grid query)', () => {
  it('applies the frozen cell-centre rule', () => {
    expect(cellCentre(validGridSpec, { x: 0, z: 0 })).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(cellCentre(validGridSpec, { x: 2, z: 3 })).toEqual({ x: 2.5, y: 0, z: 3.5 });
    expect(cellCentre(validGridSpec, { x: -1, z: -2 })).toEqual({ x: -0.5, y: 0, z: -1.5 });
  });

  it('uses the grid origin and cellSize rather than the world origin', () => {
    const grid = { ...validGridSpec, origin: { x: 10, y: 2, z: -5 }, cellSize: 2 };
    expect(cellCentre(grid, { x: 1, z: 2 })).toEqual({ x: 13, y: 2, z: 0 });
  });

  it('cellOf inverts cellCentre for many cells, including negatives', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: 9, z: 9 },
      { x: -1, z: -2 },
      { x: 3, z: -4 },
      { x: -5, z: 7 },
    ];
    for (const cell of cells) {
      expect(cellOf(validGridSpec, cellCentre(validGridSpec, cell))).toEqual(cell);
    }
  });

  it('cellOf is the WORLD rule: it maps any position and never clamps to the grid', () => {
    expect(cellOf(validGridSpec, { x: -0.1, y: 0, z: -0.1 })).toEqual({ x: -1, z: -1 });
    expect(cellOf(validGridSpec, { x: 100, y: 0, z: 100 })).toEqual({ x: 100, z: 100 });
  });

  it('cellOf ignores y entirely: a bridge deck and the bed below map to the same cell', () => {
    const bed = cellOf(validGridSpec, { x: 2.5, y: -2, z: 3.5 });
    const deck = cellOf(validGridSpec, { x: 2.5, y: 3, z: 3.5 });
    expect(bed).toEqual({ x: 2, z: 3 });
    expect(deck).toEqual({ x: 2, z: 3 });
  });
});

describe('isWorldSnapshot', () => {
  it('accepts a well-formed WorldSnapshot', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
  });

  it('accepts empty tiles, surfaces, colliders, and entities lists, and a null controlledActorId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, surfaces: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, colliders: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: null })).toBe(true);
  });

  it('accepts a snapshot with many surfaces/colliders overlapping in (x, z)', () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        surfaces: [
          { ...validSurfaceState, surfaceId: 'surface-bed', center: { x: 0, y: -2, z: 0 } },
          { ...validSurfaceState, surfaceId: 'surface-deck', center: { x: 0, y: 3, z: 0 } },
          {
            ...validSurfaceState,
            surfaceId: 'surface-roof',
            kind: 'ramp',
            center: { x: 0, y: 6, z: 0 },
            walkable: false,
          },
        ],
        colliders: [
          {
            ...validColliderState,
            colliderId: 'collider-wall',
            shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
          },
          {
            ...validColliderState,
            colliderId: 'collider-deck',
            shape: { kind: 'aabb', min: { x: 0, y: 4, z: 0 }, max: { x: 1, y: 4.5, z: 1 } },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a snapshot containing a 'water' tile and a 'tree' entity (phase-6 vocabulary)", () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        tiles: [{ ...validTileState, terrain: 'water' }],
        entities: [{ ...validEntityState, entityId: 'entity-tree', actorId: null, kind: 'tree' }],
      }),
    ).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it.each([
    'worldId',
    'bounds',
    'grid',
    'tiles',
    'surfaces',
    'colliders',
    'entities',
    'controlledActorId',
    'serverTime',
  ])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validWorldSnapshot };
    delete value[key];
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it('rejects unknown extra fields, including the legacy `size`', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, extra: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: { width: 20, height: 15 } })).toBe(false);
  });

  it('rejects the phase-6 snapshot shape (WorldSize + 2D transform tile) — the 6 -> 7 break', () => {
    expect(isWorldSnapshot(phase6WorldSnapshot)).toBe(false);
    expect(isWorldSnapshot({ ...phase6WorldSnapshot, bounds: validWorldBounds })).toBe(false);
    expect(isWorldSnapshot({ ...phase6WorldSnapshot, grid: validGridSpec })).toBe(false);
  });

  it('rejects the phase-7 snapshot shape (no surfaces/colliders) — the 7 -> 8 break', () => {
    expect(isWorldSnapshot(phase7WorldSnapshot)).toBe(false);
    expect(
      isWorldSnapshot({ ...phase7WorldSnapshot, tiles: [] }),
    ).toBe(false);
  });

  it('REJECTS a tile carrying a `level` inside a snapshot (no integer-level model)', () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        tiles: [{ cell: validCellCoord, terrain: 'grass', level: 0 }],
      }),
    ).toBe(false);
  });

  it('rejects a malformed worldId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: null })).toBe(false);
  });

  it('rejects a malformed bounds or grid', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, bounds: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, bounds: { min: validWorldBounds.min } })).toBe(
      false,
    );
    expect(isWorldSnapshot({ ...validWorldSnapshot, grid: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, grid: { ...validGridSpec, cellSize: 0 } })).toBe(
      false,
    );
  });

  it('rejects unknown terrain / entity / surface / collider kinds inside a snapshot (exact-union regression guard)', () => {
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, tiles: [{ ...validTileState, terrain: 'lava' }] }),
    ).toBe(false);
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, entities: [{ ...validEntityState, kind: 'npc' }] }),
    ).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        surfaces: [{ ...validSurfaceState, kind: 'stair' }],
      }),
    ).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        colliders: [{ ...validColliderState, kind: 'tree' }],
      }),
    ).toBe(false);
  });

  it('rejects an unknown shape.kind / missing walkable inside a snapshot', () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        colliders: [
          {
            ...validColliderState,
            shape: { kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1 },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        surfaces: [{ ...validSurfaceState, walkable: undefined }],
      }),
    ).toBe(false);
  });

  it('rejects surfaces/colliders that are not arrays or contain a malformed item', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, surfaces: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, surfaces: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, surfaces: ['surface-1'] })).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        surfaces: [{ ...validSurfaceState, axisV: { x: 2, y: 0, z: 0 } }],
      }),
    ).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, colliders: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, colliders: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, colliders: ['collider-1'] })).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        colliders: [
          {
            ...validColliderState,
            shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: 0, z: 4.5 } },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects entities/tiles that are not arrays or that contain a malformed item', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: ['entity-1'] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: ['grass'] })).toBe(false);
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        tiles: [{ cell: validCellCoord, terrain: 'grass', transform: { x: 1, y: 2 } }],
      }),
    ).toBe(false);
  });

  it('rejects a malformed controlledActorId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: undefined })).toBe(false);
  });

  it('rejects a non-ISO serverTime', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 'yesterday' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 123 })).toBe(false);
  });
});

describe('parseWorldSnapshot', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseWorldSnapshot(validWorldSnapshot)).toBe(validWorldSnapshot);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldSnapshot({ size: { width: 20, height: 15 } }));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the phase-6 snapshot shape (WorldSize + 2D transform tile)', () => {
    const error = captureParseError(() => parseWorldSnapshot(phase6WorldSnapshot));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
  });

  it('rejects the phase-7 snapshot shape (no surfaces/colliders)', () => {
    const error = captureParseError(() => parseWorldSnapshot(phase7WorldSnapshot));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
  });
});

describe('isGetWorldResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isGetWorldResponse({ world: validWorldSnapshot })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGetWorldResponse(value)).toBe(false);
  });

  it('rejects a missing world and unknown extra fields', () => {
    expect(isGetWorldResponse({})).toBe(false);
    expect(isGetWorldResponse({ world: validWorldSnapshot, extra: true })).toBe(false);
  });

  it('rejects a malformed world snapshot', () => {
    expect(isGetWorldResponse({ world: { ...validWorldSnapshot, extra: 1 } })).toBe(false);
    expect(isGetWorldResponse({ world: null })).toBe(false);
  });

  it('rejects the phase-6 snapshot shape inside `world`', () => {
    expect(isGetWorldResponse({ world: phase6WorldSnapshot })).toBe(false);
    expect(isGetWorldResponse({ world: { ...phase6WorldSnapshot, bounds: validWorldBounds } })).toBe(
      false,
    );
  });

  it('rejects the phase-7 snapshot shape inside `world`', () => {
    expect(isGetWorldResponse({ world: phase7WorldSnapshot })).toBe(false);
  });
});

describe('parseGetWorldResponse', () => {
  it('returns the value unchanged when valid', () => {
    const value = { world: validWorldSnapshot };
    expect(parseGetWorldResponse(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGetWorldResponse({}));
    expect(error.message).toBe('Invalid GetWorldResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the phase-6 snapshot shape', () => {
    const error = captureParseError(() => parseGetWorldResponse({ world: phase6WorldSnapshot }));
    expect(error.message).toBe('Invalid GetWorldResponse payload');
  });
});
