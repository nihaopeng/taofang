import { describe, expect, it } from 'vitest';

import {
  isBlockChangedEvent,
  isEntityRemovedEvent,
  isEntitySpawnedEvent,
  isGameEvent,
  isTransformChangedEvent,
  parseBlockChangedEvent,
  parseEntityRemovedEvent,
  parseEntitySpawnedEvent,
  parseGameEvent,
  parseTransformChangedEvent,
} from '../src/index.ts';
import type { GameEvent, Transform } from '../src/index.ts';
import {
  captureParseError,
  validBlockChangedEvent,
  validEntityRemovedEvent,
  validEntitySpawnedEvent,
  validEntityState,
  validTransformChangedEvent,
} from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isEntitySpawnedEvent', () => {
  it('accepts a well-formed event', () => {
    expect(isEntitySpawnedEvent(validEntitySpawnedEvent)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isEntitySpawnedEvent(value)).toBe(false);
  });

  it.each(['type', 'entity'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validEntitySpawnedEvent };
    delete value[key];
    expect(isEntitySpawnedEvent(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isEntitySpawnedEvent({ ...validEntitySpawnedEvent, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type discriminant', () => {
    expect(isEntitySpawnedEvent({ ...validEntitySpawnedEvent, type: 'entity.spawn' })).toBe(false);
    expect(isEntitySpawnedEvent({ ...validEntitySpawnedEvent, type: 'entity.removed' })).toBe(false);
  });

  it('rejects a malformed entity', () => {
    expect(isEntitySpawnedEvent({ ...validEntitySpawnedEvent, entity: null })).toBe(false);
    expect(
      isEntitySpawnedEvent({ ...validEntitySpawnedEvent, entity: { ...validEntityState, kind: 'npc' } }),
    ).toBe(false);
    expect(isEntitySpawnedEvent({ ...validEntitySpawnedEvent, entity: [] })).toBe(false);
  });
});

describe('parseEntitySpawnedEvent', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseEntitySpawnedEvent(validEntitySpawnedEvent)).toBe(validEntitySpawnedEvent);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseEntitySpawnedEvent({ type: 'entity.spawned' }));
    expect(error.message).toBe('Invalid EntitySpawnedEvent payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isEntityRemovedEvent', () => {
  it('accepts a well-formed event', () => {
    expect(isEntityRemovedEvent(validEntityRemovedEvent)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isEntityRemovedEvent(value)).toBe(false);
  });

  it.each(['type', 'entityId'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validEntityRemovedEvent };
    delete value[key];
    expect(isEntityRemovedEvent(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type discriminant', () => {
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, type: 'entity.remove' })).toBe(false);
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, type: 'transform.changed' })).toBe(
      false,
    );
  });

  it('rejects a malformed entityId', () => {
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, entityId: '' })).toBe(false);
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, entityId: 1 })).toBe(false);
    expect(isEntityRemovedEvent({ ...validEntityRemovedEvent, entityId: null })).toBe(false);
  });
});

describe('parseEntityRemovedEvent', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseEntityRemovedEvent(validEntityRemovedEvent)).toBe(validEntityRemovedEvent);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseEntityRemovedEvent({ type: 'entity.removed' }));
    expect(error.message).toBe('Invalid EntityRemovedEvent payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isTransformChangedEvent', () => {
  it('accepts a well-formed event', () => {
    expect(isTransformChangedEvent(validTransformChangedEvent)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isTransformChangedEvent(value)).toBe(false);
  });

  it.each(['type', 'entityId', 'transform'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validTransformChangedEvent };
    delete value[key];
    expect(isTransformChangedEvent(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isTransformChangedEvent({ ...validTransformChangedEvent, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type discriminant', () => {
    expect(isTransformChangedEvent({ ...validTransformChangedEvent, type: 'transform.change' })).toBe(
      false,
    );
    expect(isTransformChangedEvent({ ...validTransformChangedEvent, type: 'entity.removed' })).toBe(
      false,
    );
  });

  it('rejects malformed entityId / transform', () => {
    expect(isTransformChangedEvent({ ...validTransformChangedEvent, entityId: '' })).toBe(false);
    expect(isTransformChangedEvent({ ...validTransformChangedEvent, transform: null })).toBe(false);
    expect(
      isTransformChangedEvent({ ...validTransformChangedEvent, transform: { x: 1.5, y: 2 } }),
    ).toBe(false);
  });
});

describe('parseTransformChangedEvent', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTransformChangedEvent(validTransformChangedEvent)).toBe(validTransformChangedEvent);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTransformChangedEvent({ type: 'transform.changed' }));
    expect(error.message).toBe('Invalid TransformChangedEvent payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isBlockChangedEvent', () => {
  it('accepts a well-formed block change', () => {
    expect(isBlockChangedEvent(validBlockChangedEvent)).toBe(true);
  });

  it('ACCEPTS `air` to mean the block was removed', () => {
    expect(isBlockChangedEvent({ ...validBlockChangedEvent, kind: 'air' })).toBe(true);
  });

  it('rejects missing keys, complete unknowns, and a 2D coord', () => {
    const missing: Record<string, unknown> = { ...validBlockChangedEvent };
    delete missing.orientation;
    expect(isBlockChangedEvent(missing)).toBe(false);
    expect(isBlockChangedEvent({ ...validBlockChangedEvent, coord: { x: 1, z: 2 } })).toBe(false);
    expect(isBlockChangedEvent({ ...validBlockChangedEvent, kind: 'lava' })).toBe(false);
    expect(isBlockChangedEvent({ ...validBlockChangedEvent, orientation: 45 })).toBe(false);
    expect(isBlockChangedEvent({ ...validBlockChangedEvent, extra: 1 })).toBe(false);
    expect(isBlockChangedEvent(null)).toBe(false);
  });
});

describe('parseBlockChangedEvent', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockChangedEvent(validBlockChangedEvent)).toBe(validBlockChangedEvent);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseBlockChangedEvent({ type: 'block.changed' }));
    expect(error.message).toBe('Invalid BlockChangedEvent payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isGameEvent', () => {
  it('accepts every known event member', () => {
    expect(isGameEvent(validEntitySpawnedEvent)).toBe(true);
    expect(isGameEvent(validEntityRemovedEvent)).toBe(true);
    expect(isGameEvent(validTransformChangedEvent)).toBe(true);
    expect(isGameEvent(validBlockChangedEvent)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGameEvent(value)).toBe(false);
  });

  it('rejects an unknown type discriminant', () => {
    expect(isGameEvent({ type: 'entity.moved', entityId: 'e1', transform: { x: 0, y: 0 } })).toBe(
      false,
    );
    expect(isGameEvent({ type: 'unknown' })).toBe(false);
  });
});

describe('parseGameEvent', () => {
  it('parses each member into the discriminated union without a cast', () => {
    const spawned: GameEvent = parseGameEvent(validEntitySpawnedEvent);
    const removed: GameEvent = parseGameEvent(validEntityRemovedEvent);
    const changed: GameEvent = parseGameEvent(validTransformChangedEvent);

    if (spawned.type === 'entity.spawned') {
      expect(spawned.entity).toBe(validEntityState);
    }
    if (removed.type === 'entity.removed') {
      expect(removed.entityId).toBe('entity-1');
    }
    if (changed.type === 'transform.changed') {
      const transform: Transform = changed.transform;
      expect(transform).toBe(validTransformChangedEvent.transform);
    }
  });

  it('throws ProtocolParseError for an unknown type discriminant', () => {
    const error = captureParseError(() => parseGameEvent({ type: 'entity.moved' }));
    expect(error.message).toBe('Invalid GameEvent payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('parses the block-change member without a cast', () => {
    const changed: GameEvent = parseGameEvent(validBlockChangedEvent);
    if (changed.type === 'block.changed') {
      expect(changed.kind).toBe('stone');
      expect(changed.coord).toEqual({ x: 2, y: 0, z: 3 });
    } else {
      throw new Error('unreachable: expected block.changed');
    }
  });

  it('throws ProtocolParseError for non-objects', () => {
    expect(captureParseError(() => parseGameEvent(null)).message).toBe('Invalid GameEvent payload');
    expect(captureParseError(() => parseGameEvent('entity.spawned')).message).toBe(
      'Invalid GameEvent payload',
    );
  });
});

/**
 * Type-level exactness guard: `GameEvent` must stay exactly four members. The
 * literal tuple and the `Exact` comparison fail `tsc` if a member is added or
 * removed, so the event vocabulary is enforced by the compiler.
 */
const gameEventTypes = [
  'entity.spawned',
  'entity.removed',
  'transform.changed',
  'block.changed',
] as const;
type ListedGameEventType = (typeof gameEventTypes)[number];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Exported so `noUnusedLocals` cannot swallow the compile-time exactness proof. */
export const gameEventTypesAreExact: Exact<GameEvent['type'], ListedGameEventType> = true;

describe('GameEvent exact shape', () => {
  it('is exactly four members and has no catch-all', () => {
    expect(gameEventTypesAreExact).toBe(true);
    expect(gameEventTypes).toHaveLength(4);
  });
});
