import { describe, expect, it } from 'vitest';

import {
  ProtocolParseError,
  toProtocolError,
  type ProtocolErrorCode,
} from '../src/index.ts';

describe('toProtocolError', () => {
  it('wraps code and message in the wire shape', () => {
    expect(toProtocolError('NOT_FOUND', 'missing')).toEqual({
      error: { code: 'NOT_FOUND', message: 'missing' },
    });
  });

  it('preserves every protocol error code', () => {
    const codes: ProtocolErrorCode[] = [
      'BAD_REQUEST',
      'NOT_FOUND',
      'METHOD_NOT_ALLOWED',
      'CONFLICT',
      'INTERNAL_ERROR',
    ];
    for (const code of codes) {
      expect(toProtocolError(code, 'x')).toEqual({ error: { code, message: 'x' } });
    }
  });

  it('round-trips the new CONFLICT code (valid request, illegal against current state)', () => {
    const payload = toProtocolError('CONFLICT', 'target out of range');
    expect(payload.error.code).toBe('CONFLICT');
    expect(payload).toEqual({ error: { code: 'CONFLICT', message: 'target out of range' } });
    // The `ProtocolParseError` code slot is typed as `ProtocolErrorCode`, so
    // `CONFLICT` must be accepted there too (the "guard" side of the vocabulary).
    expect(new ProtocolParseError('conflict', 'CONFLICT').code).toBe('CONFLICT');
  });
});

describe('ProtocolParseError', () => {
  it('defaults to BAD_REQUEST and carries its name and message', () => {
    const error = new ProtocolParseError('bad payload');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProtocolParseError);
    expect(error.name).toBe('ProtocolParseError');
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('bad payload');
  });

  it('accepts an explicit code', () => {
    const error = new ProtocolParseError('nope', 'INTERNAL_ERROR');
    expect(error.code).toBe('INTERNAL_ERROR');
  });
});
