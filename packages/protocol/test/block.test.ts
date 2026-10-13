import { describe, expect, it } from 'vitest';

import {
  isBlockKind,
  isBlockOrientation,
  isBlockState,
  isYawStep,
  parseBlockKind,
  parseBlockOrientation,
  parseBlockState,
  parseYawStep,
} from '../src/index.ts';
import { captureParseError, validBlockState, validCellCoord } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isBlockKind', () => {
  it('accepts exactly the closed union (air plus the renderable kinds)', () => {
    for (const kind of ['air', 'grass', 'soil', 'stone', 'path', 'water', 'slab', 'stairs', 'ramp']) {
      expect(isBlockKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown value even though the union grew (exact-union regression guard)', () => {
    expect(isBlockKind('lava')).toBe(false);
    expect(isBlockKind('Grass')).toBe(false);
    expect(isBlockKind('')).toBe(false);
    expect(isBlockKind(1)).toBe(false);
    expect(isBlockKind(null)).toBe(false);
  });
});

describe('parseBlockKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockKind('ramp')).toBe('ramp');
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseBlockKind('lava'));
    expect(error.message).toBe('Invalid BlockKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isBlockOrientation / isYawStep', () => {
  it('accepts exactly the four quarter turns', () => {
    for (const step of [0, 90, 180, 270]) {
      expect(isBlockOrientation(step)).toBe(true);
      expect(isYawStep(step)).toBe(true);
    }
  });

  it('rejects any other angle, a string angle, and non-numbers', () => {
    expect(isBlockOrientation(45)).toBe(false);
    expect(isBlockOrientation(360)).toBe(false);
    expect(isBlockOrientation(-90)).toBe(false);
    expect(isBlockOrientation('90')).toBe(false);
    expect(isBlockOrientation(null)).toBe(false);
    expect(isBlockOrientation({ degrees: 90 })).toBe(false);
  });
});

describe('parseBlockOrientation / parseYawStep', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockOrientation(180)).toBe(180);
    expect(parseYawStep(270)).toBe(270);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    expect(captureParseError(() => parseBlockOrientation(45)).message).toBe(
      'Invalid BlockOrientation payload',
    );
    expect(captureParseError(() => parseYawStep(45)).message).toBe('Invalid YawStep payload');
  });
});

describe('isBlockState', () => {
  it('accepts a well-formed BlockState', () => {
    expect(isBlockState(validBlockState)).toBe(true);
    expect(isBlockState({ ...validBlockState, kind: 'stairs', orientation: 270 })).toBe(true);
  });

  it('ACCEPTS `air` (a block-change event uses it to mean removed)', () => {
    expect(isBlockState({ ...validBlockState, kind: 'air' })).toBe(true);
  });

  it('REQUIRES `orientation` (a directional block must not silently lose its facing)', () => {
    const missing: Record<string, unknown> = { ...validBlockState };
    delete missing.orientation;
    expect(isBlockState(missing)).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isBlockState(value)).toBe(false);
  });

  it.each(['coord', 'kind', 'orientation'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validBlockState };
    delete value[key];
    expect(isBlockState(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isBlockState({ ...validBlockState, shape: { kind: 'aabb' } })).toBe(false);
    expect(isBlockState({ ...validBlockState, color: 'green' })).toBe(false);
    expect(isBlockState({ ...validBlockState, level: 0 })).toBe(false);
  });

  it('rejects a 2D coord, a bad kind, and a non-quarter-turn orientation', () => {
    expect(isBlockState({ ...validBlockState, coord: { x: 1, z: 2 } })).toBe(false);
    expect(isBlockState({ ...validBlockState, coord: { x: 1, y: 2 } })).toBe(false);
    expect(isBlockState({ ...validBlockState, kind: 'lava' })).toBe(false);
    expect(isBlockState({ ...validBlockState, orientation: 45 })).toBe(false);
    expect(isBlockState({ ...validBlockState, orientation: '0' })).toBe(false);
  });
});

describe('parseBlockState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockState(validBlockState)).toBe(validBlockState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseBlockState({ ...validBlockState, kind: 'lava' }));
    expect(error.message).toBe('Invalid BlockState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('BlockState has no appearance/collision vocabulary', () => {
  it('rejects every presentation/server-side extra key', () => {
    for (const key of ['material', 'asset', 'texture', 'color', 'collision', 'solid', 'walkable']) {
      expect(isBlockState({ ...validBlockState, [key]: true })).toBe(false);
    }
    expect(validBlockState.coord).toEqual(validCellCoord);
  });
});
