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
  it('accepts a well-formed Transform', () => {
    expect(isTransform(validTransform)).toBe(true);
  });

  it('accepts zero and negative integers (bounds are not a Protocol concern)', () => {
    expect(isTransform({ x: 0, y: 0 })).toBe(true);
    expect(isTransform({ x: -5, y: -12 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isTransform(value)).toBe(false);
  });

  it.each(['x', 'y'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validTransform };
    delete value[key];
    expect(isTransform(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isTransform({ ...validTransform, z: 1 })).toBe(false);
  });

  it('rejects wrong field types and non-integers', () => {
    expect(isTransform({ ...validTransform, x: '3' })).toBe(false);
    expect(isTransform({ ...validTransform, y: null })).toBe(false);
    expect(isTransform({ ...validTransform, x: 1.5 })).toBe(false);
    expect(isTransform({ ...validTransform, y: Number.NaN })).toBe(false);
    expect(isTransform({ ...validTransform, x: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('parseTransform', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTransform(validTransform)).toBe(validTransform);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTransform({ ...validTransform, x: 1.5 }));
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
    expect(isEntityState({ ...validEntityState, transform: { x: 1 } })).toBe(false);
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
