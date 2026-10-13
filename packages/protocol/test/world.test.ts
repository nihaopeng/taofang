import { describe, expect, it } from 'vitest';

import {
  isGetWorldResponse,
  isWorldBounds,
  isWorldSnapshot,
  parseGetWorldResponse,
  parseWorldBounds,
  parseWorldSnapshot,
} from '../src/index.ts';
import {
  captureParseError,
  v8WorldSnapshot,
  validBlockGrid,
  validBlockState,
  validEntityState,
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

describe('isWorldSnapshot (v9 block-spatial shape)', () => {
  it('accepts a well-formed v9 snapshot', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
  });

  it('accepts an empty sparse block list and an empty entity list', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, blocks: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: null })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it.each([
    'worldId',
    'bounds',
    'blockGrid',
    'blocks',
    'entities',
    'controlledActorId',
    'serverTime',
  ])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validWorldSnapshot };
    delete value[key];
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it('rejects unknown extra fields, including the removed grid/tiles/surfaces/colliders', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, extra: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, grid: validBlockGrid })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, surfaces: [] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, colliders: [] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, chunks: [] })).toBe(false);
  });

  it('REJECTS a sparse block list that explicitly carries an `air` entry', () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        blocks: [{ ...validBlockState, kind: 'air' }],
      }),
    ).toBe(false);
    // Even alongside a real block, the air entry is fatal.
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        blocks: [validBlockState, { coord: { x: 9, y: 0, z: 9 }, kind: 'air', orientation: 0 }],
      }),
    ).toBe(false);
  });

  it('REJECTS duplicate absolute coords (the block list is a sparse map)', () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        blocks: [validBlockState, { ...validBlockState, kind: 'stone' }],
      }),
    ).toBe(false);
    // The same cell at a different coordinate is fine.
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        blocks: [validBlockState, { ...validBlockState, coord: { x: 3, y: 0, z: 3 } }],
      }),
    ).toBe(true);
  });

  it('rejects a malformed blocks array, block entry, or 2D block coord', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, blocks: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, blocks: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, blocks: ['grass'] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, blocks: [{ ...validBlockState, kind: 'lava' }] })).toBe(
      false,
    );
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, blocks: [{ ...validBlockState, coord: { x: 1, z: 2 } }] }),
    ).toBe(false);
  });

  it('rejects the v8 (phase-14) snapshot shape — the 8 -> 9 break', () => {
    expect(isWorldSnapshot(v8WorldSnapshot)).toBe(false);
    expect(isWorldSnapshot({ ...v8WorldSnapshot, blockGrid: validBlockGrid })).toBe(false);
    expect(isWorldSnapshot({ ...v8WorldSnapshot, blocks: [validBlockState] })).toBe(false);
  });

  it('rejects a malformed worldId or blockGrid', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, bounds: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, blockGrid: null })).toBe(false);
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, blockGrid: { ...validBlockGrid, cellSize: 0 } }),
    ).toBe(false);
  });

  it('rejects an unknown entity kind inside a snapshot (exact-union regression guard)', () => {
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, entities: [{ ...validEntityState, kind: 'npc' }] }),
    ).toBe(false);
  });

  it('rejects a malformed controlledActorId or serverTime', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: undefined })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 'yesterday' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 123 })).toBe(false);
  });

  it('does not leak occupancy onto the snapshot (occupancy is server-only)', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, occupancy: [] })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, occupiedCells: [] })).toBe(false);
  });
});

describe('parseWorldSnapshot', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseWorldSnapshot(validWorldSnapshot)).toBe(validWorldSnapshot);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldSnapshot({ blocks: [] }));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the v8 snapshot shape and an air-carrying block list', () => {
    expect(captureParseError(() => parseWorldSnapshot(v8WorldSnapshot)).message).toBe(
      'Invalid WorldSnapshot payload',
    );
    expect(
      captureParseError(() =>
        parseWorldSnapshot({ ...validWorldSnapshot, blocks: [{ ...validBlockState, kind: 'air' }] }),
      ).message,
    ).toBe('Invalid WorldSnapshot payload');
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

  it('rejects a malformed world snapshot, including the v8 shape', () => {
    expect(isGetWorldResponse({ world: { ...validWorldSnapshot, extra: 1 } })).toBe(false);
    expect(isGetWorldResponse({ world: null })).toBe(false);
    expect(isGetWorldResponse({ world: v8WorldSnapshot })).toBe(false);
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

  it('rejects the v8 snapshot shape', () => {
    const error = captureParseError(() => parseGetWorldResponse({ world: v8WorldSnapshot }));
    expect(error.message).toBe('Invalid GetWorldResponse payload');
  });
});
