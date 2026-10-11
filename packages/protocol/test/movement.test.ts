import { describe, expect, it } from 'vitest';

import {
  isMoveDirection,
  isMovePlayerCommand,
  isMovePlayerResponse,
  isMovePlayerResult,
  parseMoveDirection,
  parseMovePlayerCommand,
  parseMovePlayerResponse,
  parseMovePlayerResult,
} from '../src/index.ts';
import { captureParseError, validMovePlayerResult, validPlayer } from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

const validCommand = { playerId: 'player-1', direction: 'north' };

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

describe('isMovePlayerCommand', () => {
  it('accepts a well-formed command', () => {
    expect(isMovePlayerCommand(validCommand)).toBe(true);
    expect(isMovePlayerCommand({ ...validCommand, direction: 'west' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMovePlayerCommand(value)).toBe(false);
  });

  it.each(['playerId', 'direction'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validCommand };
    delete value[key];
    expect(isMovePlayerCommand(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isMovePlayerCommand({ ...validCommand, extra: 1 })).toBe(false);
  });

  it('rejects an empty playerId and a bad direction', () => {
    expect(isMovePlayerCommand({ ...validCommand, playerId: '' })).toBe(false);
    expect(isMovePlayerCommand({ ...validCommand, playerId: null })).toBe(false);
    expect(isMovePlayerCommand({ ...validCommand, direction: 'up' })).toBe(false);
    expect(isMovePlayerCommand({ ...validCommand, direction: 2 })).toBe(false);
  });
});

describe('parseMovePlayerCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMovePlayerCommand(validCommand)).toBe(validCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseMovePlayerCommand({ ...validCommand, playerId: '' }));
    expect(error.message).toBe('Invalid MovePlayerCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isMovePlayerResult', () => {
  it('accepts a well-formed result', () => {
    expect(isMovePlayerResult(validMovePlayerResult)).toBe(true);
    expect(isMovePlayerResult({ ...validMovePlayerResult, moved: false })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMovePlayerResult(value)).toBe(false);
  });

  it.each(['player', 'moved', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validMovePlayerResult };
    delete value[key];
    expect(isMovePlayerResult(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isMovePlayerResult({ ...validMovePlayerResult, extra: 1 })).toBe(false);
    expect(isMovePlayerResult({ ...validMovePlayerResult, moved: 'true' })).toBe(false);
    expect(isMovePlayerResult({ ...validMovePlayerResult, moved: 1 })).toBe(false);
    expect(isMovePlayerResult({ ...validMovePlayerResult, serverTime: 'yesterday' })).toBe(false);
  });

  it('rejects a malformed player', () => {
    expect(isMovePlayerResult({ ...validMovePlayerResult, player: { id: '' } })).toBe(false);
    expect(isMovePlayerResult({ ...validMovePlayerResult, player: validPlayer.name })).toBe(false);
  });
});

describe('parseMovePlayerResult', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMovePlayerResult(validMovePlayerResult)).toBe(validMovePlayerResult);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseMovePlayerResult({ ...validMovePlayerResult, moved: 'true' }),
    );
    expect(error.message).toBe('Invalid MovePlayerResult payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isMovePlayerResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isMovePlayerResponse({ result: validMovePlayerResult })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMovePlayerResponse(value)).toBe(false);
  });

  it('rejects a missing result and unknown extra fields', () => {
    expect(isMovePlayerResponse({})).toBe(false);
    expect(isMovePlayerResponse({ result: validMovePlayerResult, extra: true })).toBe(false);
  });

  it('rejects a malformed result', () => {
    expect(isMovePlayerResponse({ result: { ...validMovePlayerResult, extra: 1 } })).toBe(false);
    expect(isMovePlayerResponse({ result: [] })).toBe(false);
  });
});

describe('parseMovePlayerResponse', () => {
  it('returns the value unchanged when valid', () => {
    const value = { result: validMovePlayerResult };
    expect(parseMovePlayerResponse(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseMovePlayerResponse({}));
    expect(error.message).toBe('Invalid MovePlayerResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
