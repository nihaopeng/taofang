import { describe, expect, it } from 'vitest';

import {
  isGameInfo,
  isGetGameInfoResponse,
  parseGameInfo,
  parseGetGameInfoResponse,
} from '../src/index.ts';
import { captureParseError, validGameInfo } from './support.ts';

const invalidValues: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'game-info'],
  ['a boolean', true],
  ['an array', []],
];

describe('isGameInfo', () => {
  it('accepts a well-formed GameInfo', () => {
    expect(isGameInfo(validGameInfo)).toBe(true);
  });

  it('accepts a timestamp without fractional seconds', () => {
    expect(isGameInfo({ ...validGameInfo, serverTime: '2025-01-02T03:04:05Z' })).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_label, value) => {
    expect(isGameInfo(value)).toBe(false);
  });

  it('rejects each unknown extra field', () => {
    expect(isGameInfo({ ...validGameInfo, extra: 1 })).toBe(false);
  });

  it.each(['gameName', 'serverVersion', 'protocolVersion', 'serverTime'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validGameInfo };
      delete value[key];
      expect(isGameInfo(value)).toBe(false);
    },
  );

  it('rejects wrong field types', () => {
    expect(isGameInfo({ ...validGameInfo, gameName: 1 })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, serverVersion: null })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: '1' })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, serverTime: 123 })).toBe(false);
  });

  it('requires a finite integer protocolVersion', () => {
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 1.5 })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: Number.NaN })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 0 })).toBe(true);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 999 })).toBe(true);
  });

  it('does not couple the guard to the current PROTOCOL_VERSION', () => {
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 2 })).toBe(true);
  });

  it.each([
    'not-a-date',
    '',
    '2025-01-02',
    '2025-01-02T03:04:05+00:00',
    '2025-01-02T03:04:05.1234Z',
    '2025-13-01T00:00:00Z',
    '2025-02-30T00:00:00Z',
  ])('rejects non-ISO serverTime %s', (serverTime) => {
    expect(isGameInfo({ ...validGameInfo, serverTime })).toBe(false);
  });
});

describe('parseGameInfo', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseGameInfo(validGameInfo)).toBe(validGameInfo);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGameInfo({ ...validGameInfo, extra: 1 }));
    expect(error.message).toBe('Invalid GameInfo payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isGetGameInfoResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isGetGameInfoResponse({ gameInfo: validGameInfo })).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_label, value) => {
    expect(isGetGameInfoResponse(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isGetGameInfoResponse({ gameInfo: validGameInfo, extra: true })).toBe(false);
  });

  it('rejects a missing gameInfo', () => {
    expect(isGetGameInfoResponse({})).toBe(false);
  });

  it('rejects a malformed gameInfo', () => {
    expect(isGetGameInfoResponse({ gameInfo: { ...validGameInfo, extra: 1 } })).toBe(false);
    expect(isGetGameInfoResponse({ gameInfo: [] })).toBe(false);
  });
});

describe('parseGetGameInfoResponse', () => {
  it('returns the value unchanged when valid', () => {
    const value = { gameInfo: validGameInfo };
    expect(parseGetGameInfoResponse(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGetGameInfoResponse({}));
    expect(error.message).toBe('Invalid GetGameInfoResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
