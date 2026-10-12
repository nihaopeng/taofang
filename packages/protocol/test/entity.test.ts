import { describe, expect, it } from 'vitest';

import {
  isEntityKind,
  isEntityState,
  isTransform,
  parseEntityKind,
  parseEntityState,
  parseTransform,
} from '../src/index.ts';
import { captureParseError, validEntityState, validTransform } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isTransform', () => {
  it('accepts a well-formed 3D Transform', () => {
    expect(isTransform(validTransform)).toBe(true);
  });

  it('accepts fractional and negative positions (bounds are not a Protocol concern)', () => {
    expect(
      isTransform({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    ).toBe(true);
    expect(
      isTransform({ position: { x: -1.25, y: 3.5, z: -0.001 }, rotation: { x: 1, y: 2, z: 3, w: 4 } }),
    ).toBe(true);
  });

  it('accepts a non-normalised but non-zero quaternion (normalisation is runtime, not wire)', () => {
    expect(
      isTransform({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 2, z: 0, w: 2 } }),
    ).toBe(true);
  });

  it('rejects a zero quaternion (not a rotation)', () => {
    expect(
      isTransform({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 0 } }),
    ).toBe(false);
  });

  it('rejects the old 2D `{ x, y }` tile-coordinate shape', () => {
    expect(isTransform({ x: 3, y: 4 })).toBe(false);
    expect(isTransform({ position: { x: 0, y: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })).toBe(
      false,
    );
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isTransform(value)).toBe(false);
  });

  it.each(['position', 'rotation'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validTransform };
    delete value[key];
    expect(isTransform(value)).toBe(false);
  });

  it('rejects unknown extra fields, including a visual scale', () => {
    expect(isTransform({ ...validTransform, x: 1 })).toBe(false);
    expect(
      isTransform({ ...validTransform, scale: { x: 1, y: 1, z: 1 } }),
    ).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(isTransform({ ...validTransform, position: null })).toBe(false);
    expect(isTransform({ ...validTransform, position: { x: 1, y: 2 } })).toBe(false);
    expect(isTransform({ ...validTransform, position: { x: 1, y: 2, z: '3' } })).toBe(false);
    expect(isTransform({ ...validTransform, position: { x: 1, y: 2, z: Number.NaN } })).toBe(false);
    expect(
      isTransform({ ...validTransform, position: { x: 1, y: 2, z: Number.POSITIVE_INFINITY } }),
    ).toBe(false);
    expect(isTransform({ ...validTransform, rotation: null })).toBe(false);
    expect(isTransform({ ...validTransform, rotation: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(isTransform({ ...validTransform, rotation: { x: 0, y: 0, z: 0, w: '1' } })).toBe(false);
  });
});

describe('parseTransform', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTransform(validTransform)).toBe(validTransform);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTransform({ x: 3, y: 4 }));
    expect(error.message).toBe('Invalid Transform payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isEntityKind', () => {
  it("accepts exactly the current kinds 'character' and 'tree'", () => {
    expect(isEntityKind('character')).toBe(true);
    expect(isEntityKind('tree')).toBe(true);
  });

  it('rejects an unknown value even though the union grew (exact-union regression guard)', () => {
    expect(isEntityKind('npc')).toBe(false);
  });

  it('rejects any other kind or non-string', () => {
    expect(isEntityKind('Character')).toBe(false);
    expect(isEntityKind('npc')).toBe(false);
    expect(isEntityKind('')).toBe(false);
    expect(isEntityKind(1)).toBe(false);
    expect(isEntityKind(null)).toBe(false);
    expect(isEntityKind(undefined)).toBe(false);
  });
});

describe('parseEntityKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseEntityKind('character')).toBe('character');
    expect(parseEntityKind('tree')).toBe('tree');
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseEntityKind('npc'));
    expect(error.message).toBe('Invalid EntityKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isEntityState', () => {
  it('accepts a well-formed EntityState', () => {
    expect(isEntityState(validEntityState)).toBe(true);
  });

  it('accepts a null actorId (entity present, not actor-controllable)', () => {
    expect(isEntityState({ ...validEntityState, actorId: null })).toBe(true);
  });

  it("accepts a 'tree' entity with a null actorId (phase-6 vocabulary)", () => {
    expect(
      isEntityState({ ...validEntityState, entityId: 'entity-tree', actorId: null, kind: 'tree' }),
    ).toBe(true);
  });

  it('rejects a missing actorId (present-and-nullable, not optional)', () => {
    const value: Record<string, unknown> = { ...validEntityState };
    delete value.actorId;
    expect(isEntityState(value)).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isEntityState(value)).toBe(false);
  });

  it.each(['entityId', 'actorId', 'kind', 'transform', 'visible'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validEntityState };
      delete value[key];
      expect(isEntityState(value)).toBe(false);
    },
  );

  it('rejects unknown extra fields', () => {
    expect(isEntityState({ ...validEntityState, name: 'Alex' })).toBe(false);
  });

  it('rejects wrong field types for every field', () => {
    expect(isEntityState({ ...validEntityState, entityId: '' })).toBe(false);
    expect(isEntityState({ ...validEntityState, entityId: 1 })).toBe(false);
    expect(isEntityState({ ...validEntityState, actorId: 1 })).toBe(false);
    expect(isEntityState({ ...validEntityState, actorId: '' })).toBe(false);
    expect(isEntityState({ ...validEntityState, kind: 'npc' })).toBe(false);
    expect(isEntityState({ ...validEntityState, kind: 1 })).toBe(false);
    expect(isEntityState({ ...validEntityState, transform: null })).toBe(false);
    expect(isEntityState({ ...validEntityState, transform: { x: 1, y: 2 } })).toBe(false);
    expect(isEntityState({ ...validEntityState, visible: 'true' })).toBe(false);
    expect(isEntityState({ ...validEntityState, visible: 1 })).toBe(false);
  });
});

describe('parseEntityState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseEntityState(validEntityState)).toBe(validEntityState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseEntityState({ ...validEntityState, kind: 'npc' }));
    expect(error.message).toBe('Invalid EntityState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
