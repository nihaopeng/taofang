import { describe, expect, it } from 'vitest';

import {
  isCellCoord,
  isGetWorldResponse,
  isGridSpec,
  isTerrainKind,
  isTileState,
  isWorldBounds,
  isWorldSnapshot,
  parseCellCoord,
  parseGetWorldResponse,
  parseGridSpec,
  parseTerrainKind,
  parseTileState,
  parseWorldBounds,
  parseWorldSnapshot,
} from '../src/index.ts';
import {
  captureParseError,
  phase6WorldSnapshot,
  validCellCoord,
  validEntityState,
  validGridSpec,
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

describe('isWorldSnapshot', () => {
  it('accepts a well-formed WorldSnapshot', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
  });

  it('accepts empty tiles and entities lists, and a null controlledActorId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: null })).toBe(true);
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

  it.each(['worldId', 'bounds', 'grid', 'tiles', 'entities', 'controlledActorId', 'serverTime'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validWorldSnapshot };
      delete value[key];
      expect(isWorldSnapshot(value)).toBe(false);
    },
  );

  it('rejects unknown extra fields, including the legacy `size`', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, extra: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: { width: 20, height: 15 } })).toBe(false);
  });

  it('rejects the phase-6 snapshot shape (WorldSize + 2D transform tile) — the 6 -> 7 break', () => {
    expect(isWorldSnapshot(phase6WorldSnapshot)).toBe(false);
    expect(isWorldSnapshot({ ...phase6WorldSnapshot, bounds: validWorldBounds })).toBe(false);
    expect(isWorldSnapshot({ ...phase6WorldSnapshot, grid: validGridSpec })).toBe(false);
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

  it('rejects unknown terrain / entity kind values inside a snapshot (exact-union regression guard)', () => {
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, tiles: [{ ...validTileState, terrain: 'lava' }] }),
    ).toBe(false);
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, entities: [{ ...validEntityState, kind: 'npc' }] }),
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
