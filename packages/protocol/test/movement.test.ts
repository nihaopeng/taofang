import { describe, expect, it } from 'vitest';

import {
  isMoveActorCommand,
  isMoveActorResponse,
  isMoveActorResult,
  isMoveDirection,
  parseMoveActorCommand,
  parseMoveActorResponse,
  parseMoveActorResult,
  parseMoveDirection,
} from '../src/index.ts';
import { captureParseError, validActor, validMoveActorResult } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

const validCommand = { direction: 'north' };

describe('isMoveDirection', () => {
  it.each(['north', 'south', 'east', 'west'])('accepts %s', (direction) => {
    expect(isMoveDirection(direction)).toBe(true);
  });

  it('rejects an unknown direction or wrong type', () => {
    expect(isMoveDirection('up')).toBe(false);
    expect(isMoveDirection('North')).toBe(false);
    expect(isMoveDirection('')).toBe(false);
    expect(isMoveDirection(1)).toBe(false);
    expect(isMoveDirection(null)).toBe(false);
    expect(isMoveDirection(undefined)).toBe(false);
    expect(isMoveDirection([])).toBe(false);
  });
});

describe('parseMoveDirection', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMoveDirection('east')).toBe('east');
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseMoveDirection('up'));
    expect(error.message).toBe('Invalid MoveDirection payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isMoveActorCommand', () => {
  it('accepts a well-formed command', () => {
    expect(isMoveActorCommand(validCommand)).toBe(true);
    expect(isMoveActorCommand({ direction: 'west' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMoveActorCommand(value)).toBe(false);
  });

  it('rejects a missing direction', () => {
    expect(isMoveActorCommand({})).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isMoveActorCommand({ ...validCommand, extra: 1 })).toBe(false);
  });

  it('rejects an attempted actor field (client may not name the actor)', () => {
    expect(isMoveActorCommand({ actorId: 'actor-1', direction: 'east' })).toBe(false);
    expect(isMoveActorCommand({ playerId: 'p', direction: 'east' })).toBe(false);
  });

  it('rejects a bad direction', () => {
    expect(isMoveActorCommand({ direction: 'up' })).toBe(false);
    expect(isMoveActorCommand({ direction: 2 })).toBe(false);
  });
});

describe('parseMoveActorCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMoveActorCommand(validCommand)).toBe(validCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseMoveActorCommand({ actorId: 'actor-1', direction: 'east' }),
    );
    expect(error.message).toBe('Invalid MoveActorCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isMoveActorResult', () => {
  it('accepts a well-formed result', () => {
    expect(isMoveActorResult(validMoveActorResult)).toBe(true);
    expect(isMoveActorResult({ ...validMoveActorResult, moved: false })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMoveActorResult(value)).toBe(false);
  });

  it.each(['actor', 'moved', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validMoveActorResult };
    delete value[key];
    expect(isMoveActorResult(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isMoveActorResult({ ...validMoveActorResult, extra: 1 })).toBe(false);
    expect(isMoveActorResult({ ...validMoveActorResult, moved: 'true' })).toBe(false);
    expect(isMoveActorResult({ ...validMoveActorResult, moved: 1 })).toBe(false);
    expect(isMoveActorResult({ ...validMoveActorResult, serverTime: 'yesterday' })).toBe(false);
  });

  it('rejects a malformed actor', () => {
    expect(isMoveActorResult({ ...validMoveActorResult, actor: { actorId: '' } })).toBe(false);
    expect(isMoveActorResult({ ...validMoveActorResult, actor: validActor.name })).toBe(false);
  });

  it('rejects the removed player field (requires `actor`)', () => {
    expect(isMoveActorResult({ player: validActor, moved: true, serverTime: validMoveActorResult.serverTime })).toBe(
      false,
    );
  });
});

describe('parseMoveActorResult', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMoveActorResult(validMoveActorResult)).toBe(validMoveActorResult);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseMoveActorResult({ ...validMoveActorResult, moved: 'true' }),
    );
    expect(error.message).toBe('Invalid MoveActorResult payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isMoveActorResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isMoveActorResponse({ result: validMoveActorResult })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMoveActorResponse(value)).toBe(false);
  });

  it('rejects a missing result and unknown extra fields', () => {
    expect(isMoveActorResponse({})).toBe(false);
    expect(isMoveActorResponse({ result: validMoveActorResult, extra: true })).toBe(false);
  });

  it('rejects a malformed result', () => {
    expect(isMoveActorResponse({ result: { ...validMoveActorResult, extra: 1 } })).toBe(false);
    expect(isMoveActorResponse({ result: [] })).toBe(false);
  });
});

describe('parseMoveActorResponse', () => {
  it('returns the value unchanged when valid', () => {
    const value = { result: validMoveActorResult };
    expect(parseMoveActorResponse(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseMoveActorResponse({}));
    expect(error.message).toBe('Invalid MoveActorResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
