import { describe, expect, it } from 'vitest';

import { isQuat, isVec3, parseQuat, parseVec3 } from '../src/index.ts';
import { captureParseError, validQuat, validVec3 } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isVec3', () => {
  it('accepts a well-formed Vec3', () => {
    expect(isVec3(validVec3)).toBe(true);
    expect(isVec3({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(isVec3({ x: -1.5, y: 2.25, z: 3 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isVec3(value)).toBe(false);
  });

  it.each(['x', 'y', 'z'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validVec3 };
    delete value[key];
    expect(isVec3(value)).toBe(false);
  });

  it('rejects unknown extra fields, including the 2D shape', () => {
    expect(isVec3({ ...validVec3, w: 1 })).toBe(false);
    expect(isVec3({ x: 1, y: 2 })).toBe(false);
  });

  it('rejects a wrong type for each field and non-finite values', () => {
    expect(isVec3({ ...validVec3, x: '3' })).toBe(false);
    expect(isVec3({ ...validVec3, y: null })).toBe(false);
    expect(isVec3({ ...validVec3, z: Number.NaN })).toBe(false);
    expect(isVec3({ ...validVec3, x: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isVec3({ ...validVec3, y: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

describe('parseVec3', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseVec3(validVec3)).toBe(validVec3);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseVec3({ x: 1, y: 2 }));
    expect(error.message).toBe('Invalid Vec3 payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isQuat', () => {
  it('accepts a well-formed Quat, normalised or not', () => {
    expect(isQuat(validQuat)).toBe(true);
    expect(isQuat({ x: 0, y: 2, z: 0, w: 2 })).toBe(true);
    expect(isQuat({ x: -1, y: 2, z: -3, w: 4 })).toBe(true);
  });

  it('rejects a zero quaternion (not a rotation)', () => {
    expect(isQuat({ x: 0, y: 0, z: 0, w: 0 })).toBe(false);
    expect(isQuat({ x: -0, y: 0, z: 0, w: 0 })).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isQuat(value)).toBe(false);
  });

  it.each(['x', 'y', 'z', 'w'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validQuat };
    delete value[key];
    expect(isQuat(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isQuat({ ...validQuat, extra: 1 })).toBe(false);
    expect(isQuat({ ...validQuat, order: 'xyz' })).toBe(false);
  });

  it('rejects a wrong type for each field and non-finite values', () => {
    expect(isQuat({ ...validQuat, x: '0' })).toBe(false);
    expect(isQuat({ ...validQuat, y: null })).toBe(false);
    expect(isQuat({ ...validQuat, z: undefined })).toBe(false);
    expect(isQuat({ ...validQuat, w: Number.NaN })).toBe(false);
    expect(isQuat({ ...validQuat, y: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('parseQuat', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseQuat(validQuat)).toBe(validQuat);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseQuat({ x: 0, y: 0, z: 0, w: 0 }));
    expect(error.message).toBe('Invalid Quat payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
