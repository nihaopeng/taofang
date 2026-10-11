import { describe, expect, it } from 'vitest';

import { isMoveDirection, parseMoveDirection } from '../src/index.ts';
import { captureParseError } from './support.ts';

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
