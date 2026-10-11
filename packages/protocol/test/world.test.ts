import { describe, expect, it } from 'vitest';

import {
  isActor,
  isGetWorldResponse,
  isPosition,
  isWorldSize,
  isWorldSnapshot,
  parseActor,
  parseGetWorldResponse,
  parsePosition,
  parseWorldSize,
  parseWorldSnapshot,
} from '../src/index.ts';
import { captureParseError, validActor, validPosition, validWorldSnapshot } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isPosition', () => {
  it('accepts a well-formed Position', () => {
    expect(isPosition(validPosition)).toBe(true);
  });

  it('accepts zero and negative integers (bounds are not a Protocol concern)', () => {
    expect(isPosition({ x: 0, y: 0 })).toBe(true);
    expect(isPosition({ x: -5, y: -12 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isPosition(value)).toBe(false);
  });

  it.each(['x', 'y'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validPosition };
    delete value[key];
    expect(isPosition(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isPosition({ ...validPosition, z: 1 })).toBe(false);
  });

  it('rejects wrong field types and non-integers', () => {
    expect(isPosition({ ...validPosition, x: '3' })).toBe(false);
    expect(isPosition({ ...validPosition, y: null })).toBe(false);
    expect(isPosition({ ...validPosition, x: 1.5 })).toBe(false);
    expect(isPosition({ ...validPosition, y: Number.NaN })).toBe(false);
    expect(isPosition({ ...validPosition, x: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('parsePosition', () => {
  it('returns the value unchanged when valid', () => {
    expect(parsePosition(validPosition)).toBe(validPosition);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parsePosition({ ...validPosition, x: 1.5 }));
    expect(error.message).toBe('Invalid Position payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isWorldSize', () => {
  it('accepts a well-formed WorldSize', () => {
    expect(isWorldSize({ width: 20, height: 15 })).toBe(true);
  });

  it('rejects zero, negative, and non-integer dimensions', () => {
    expect(isWorldSize({ width: 0, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: 0 })).toBe(false);
    expect(isWorldSize({ width: -1, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: -4 })).toBe(false);
    expect(isWorldSize({ width: 1.5, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: Number.NaN })).toBe(false);
    expect(isWorldSize({ width: Number.POSITIVE_INFINITY, height: 15 })).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSize(value)).toBe(false);
  });

  it.each(['width', 'height'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { width: 20, height: 15 };
    delete value[key];
    expect(isWorldSize(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isWorldSize({ width: 20, height: 15, depth: 2 })).toBe(false);
    expect(isWorldSize({ width: '20', height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: null })).toBe(false);
  });
});

describe('parseWorldSize', () => {
  it('returns the value unchanged when valid', () => {
    const value = { width: 20, height: 15 };
    expect(parseWorldSize(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldSize({ width: 0, height: 15 }));
    expect(error.message).toBe('Invalid WorldSize payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isActor', () => {
  it('accepts a well-formed Actor', () => {
    expect(isActor(validActor)).toBe(true);
  });

  it('accepts an empty name but rejects an empty actorId', () => {
    expect(isActor({ ...validActor, name: '' })).toBe(true);
    expect(isActor({ ...validActor, actorId: '' })).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isActor(value)).toBe(false);
  });

  it.each(['actorId', 'name', 'position'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validActor };
    delete value[key];
    expect(isActor(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isActor({ ...validActor, extra: true })).toBe(false);
    expect(isActor({ ...validActor, actorId: 1 })).toBe(false);
    expect(isActor({ ...validActor, name: null })).toBe(false);
    expect(isActor({ ...validActor, position: [] })).toBe(false);
  });

  it('rejects the removed player shape (bare `id`, no `actorId`)', () => {
    expect(isActor({ id: 'actor-1', name: 'Alex', position: validPosition })).toBe(false);
  });

  it('rejects a malformed position', () => {
    expect(isActor({ ...validActor, position: { ...validPosition, x: 0.5 } })).toBe(false);
  });
});

describe('parseActor', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseActor(validActor)).toBe(validActor);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseActor({ ...validActor, actorId: '' }));
    expect(error.message).toBe('Invalid Actor payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isWorldSnapshot', () => {
  it('accepts a well-formed WorldSnapshot', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it.each(['size', 'actor', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validWorldSnapshot };
    delete value[key];
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, extra: 1 })).toBe(false);
  });

  it('rejects a malformed size', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: { width: 20, height: 15, extra: 1 } })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: { width: 0, height: 15 } })).toBe(false);
  });

  it('rejects the obsolete nested world shape', () => {
    expect(
      isWorldSnapshot({
        world: { size: { width: 20, height: 15 } },
        actor: validActor,
        serverTime: validWorldSnapshot.serverTime,
      }),
    ).toBe(false);
  });

  it('rejects the removed player-shaped snapshot (requires `actor`)', () => {
    expect(
      isWorldSnapshot({
        size: { width: 20, height: 15 },
        player: validActor,
        serverTime: validWorldSnapshot.serverTime,
      }),
    ).toBe(false);
  });

  it('rejects a malformed actor', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, actor: { actorId: '' } })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, actor: [] })).toBe(false);
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
    const error = captureParseError(() => parseWorldSnapshot({ size: {} }));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the obsolete nested world shape', () => {
    const error = captureParseError(() =>
      parseWorldSnapshot({
        world: { size: { width: 20, height: 15 } },
        actor: validActor,
        serverTime: validWorldSnapshot.serverTime,
      }),
    );
    expect(error.message).toBe('Invalid WorldSnapshot payload');
  });

  it('rejects the removed player-shaped snapshot (requires `actor`)', () => {
    const error = captureParseError(() =>
      parseWorldSnapshot({
        size: { width: 20, height: 15 },
        player: validActor,
        serverTime: validWorldSnapshot.serverTime,
      }),
    );
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

  it('rejects the removed player-shaped snapshot inside `world`', () => {
    expect(
      isGetWorldResponse({
        world: {
          size: { width: 20, height: 15 },
          player: validActor,
          serverTime: validWorldSnapshot.serverTime,
        },
      }),
    ).toBe(false);
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

  it('rejects the obsolete nested world shape', () => {
    const error = captureParseError(() =>
      parseGetWorldResponse({
        world: {
          world: { size: { width: 20, height: 15 } },
          actor: validActor,
          serverTime: validWorldSnapshot.serverTime,
        },
      }),
    );
    expect(error.message).toBe('Invalid GetWorldResponse payload');
  });

  it('rejects the removed player-shaped snapshot inside `world`', () => {
    const error = captureParseError(() =>
      parseGetWorldResponse({
        world: {
          size: { width: 20, height: 15 },
          player: validActor,
          serverTime: validWorldSnapshot.serverTime,
        },
      }),
    );
    expect(error.message).toBe('Invalid GetWorldResponse payload');
  });
});
