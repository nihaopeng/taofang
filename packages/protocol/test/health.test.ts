import { describe, expect, it } from 'vitest';

import { isHealthStatus, parseHealthStatus } from '../src/index.ts';
import { captureParseError } from './support.ts';

const validHealth = {
  status: 'ok',
  uptimeSeconds: 0,
  serverTime: '2025-01-02T03:04:05.000Z',
};

const invalidValues: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'ok'],
  ['an array', []],
];

describe('isHealthStatus', () => {
  it('accepts a well-formed HealthStatus', () => {
    expect(isHealthStatus(validHealth)).toBe(true);
  });

  it('accepts fractional non-negative uptime', () => {
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: 12.5 })).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_label, value) => {
    expect(isHealthStatus(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isHealthStatus({ ...validHealth, extra: 1 })).toBe(false);
  });

  it.each(['status', 'uptimeSeconds', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validHealth };
    delete value[key];
    expect(isHealthStatus(value)).toBe(false);
  });

  it('rejects a status other than "ok"', () => {
    expect(isHealthStatus({ ...validHealth, status: 'down' })).toBe(false);
    expect(isHealthStatus({ ...validHealth, status: 'OK' })).toBe(false);
  });

  it('rejects negative or non-finite uptimeSeconds', () => {
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: -1 })).toBe(false);
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: -0.001 })).toBe(false);
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: Number.NaN })).toBe(false);
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: '5' })).toBe(false);
    expect(isHealthStatus({ ...validHealth, uptimeSeconds: null })).toBe(false);
  });

  it('rejects non-ISO serverTime', () => {
    expect(isHealthStatus({ ...validHealth, serverTime: 'yesterday' })).toBe(false);
    expect(isHealthStatus({ ...validHealth, serverTime: '2025-02-30T00:00:00Z' })).toBe(false);
  });
});

describe('parseHealthStatus', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseHealthStatus(validHealth)).toBe(validHealth);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseHealthStatus({ ...validHealth, status: 'down' }));
    expect(error.message).toBe('Invalid HealthStatus payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
