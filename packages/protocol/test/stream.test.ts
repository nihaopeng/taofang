import { describe, expect, it } from 'vitest';

import { isWorldStreamMessage, parseWorldStreamMessage } from '../src/index.ts';
import type { GameEventBatch, WorldSnapshot, WorldStreamMessage } from '../src/index.ts';
import {
  captureParseError,
  validEventsStreamMessage,
  validGameEventBatch,
  validSnapshotStreamMessage,
  validWorldSnapshot,
} from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isWorldStreamMessage', () => {
  it('accepts both union members', () => {
    expect(isWorldStreamMessage(validSnapshotStreamMessage)).toBe(true);
    expect(isWorldStreamMessage(validEventsStreamMessage)).toBe(true);
  });

  it('accepts an events frame with an empty batch', () => {
    expect(
      isWorldStreamMessage({
        type: 'events',
        batch: { events: [], serverTime: '2025-01-02T03:04:05.000Z' },
      }),
    ).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldStreamMessage(value)).toBe(false);
  });

  it('rejects an unknown type discriminant', () => {
    expect(isWorldStreamMessage({ type: 'heartbeat' })).toBe(false);
    expect(isWorldStreamMessage({ type: 'unknown' })).toBe(false);
    expect(isWorldStreamMessage({})).toBe(false);
  });

  it.each(['type', 'snapshot'])('rejects a snapshot frame missing %s', (key) => {
    const value: Record<string, unknown> = { ...validSnapshotStreamMessage };
    delete value[key];
    expect(isWorldStreamMessage(value)).toBe(false);
  });

  it.each(['type', 'batch'])('rejects an events frame missing %s', (key) => {
    const value: Record<string, unknown> = { ...validEventsStreamMessage };
    delete value[key];
    expect(isWorldStreamMessage(value)).toBe(false);
  });

  it('rejects a member with the wrong payload key', () => {
    expect(isWorldStreamMessage({ type: 'snapshot', batch: validGameEventBatch })).toBe(false);
    expect(isWorldStreamMessage({ type: 'events', snapshot: validWorldSnapshot })).toBe(false);
  });

  it('rejects unknown extra fields on either frame', () => {
    expect(isWorldStreamMessage({ ...validSnapshotStreamMessage, extra: 1 })).toBe(false);
    expect(isWorldStreamMessage({ ...validEventsStreamMessage, extra: 1 })).toBe(false);
  });

  it('rejects a malformed snapshot or batch payload', () => {
    expect(isWorldStreamMessage({ type: 'snapshot', snapshot: null })).toBe(false);
    expect(
      isWorldStreamMessage({ type: 'snapshot', snapshot: { ...validWorldSnapshot, extra: 1 } }),
    ).toBe(false);
    expect(isWorldStreamMessage({ type: 'events', batch: null })).toBe(false);
    expect(
      isWorldStreamMessage({ type: 'events', batch: { ...validGameEventBatch, extra: 1 } }),
    ).toBe(false);
  });
});

describe('parseWorldStreamMessage', () => {
  it('parses each member into the discriminated union without a cast', () => {
    const snapshot: WorldStreamMessage = parseWorldStreamMessage(validSnapshotStreamMessage);
    const events: WorldStreamMessage = parseWorldStreamMessage(validEventsStreamMessage);

    if (snapshot.type === 'snapshot') {
      const value: WorldSnapshot = snapshot.snapshot;
      expect(value).toBe(validWorldSnapshot);
    } else {
      throw new Error('unreachable');
    }
    if (events.type === 'events') {
      const value: GameEventBatch = events.batch;
      expect(value).toBe(validGameEventBatch);
    } else {
      throw new Error('unreachable');
    }
  });

  it('returns both members unchanged when valid', () => {
    expect(parseWorldStreamMessage(validSnapshotStreamMessage)).toBe(validSnapshotStreamMessage);
    expect(parseWorldStreamMessage(validEventsStreamMessage)).toBe(validEventsStreamMessage);
  });

  it('throws ProtocolParseError for an unknown type discriminant', () => {
    const error = captureParseError(() => parseWorldStreamMessage({ type: 'heartbeat' }));
    expect(error.message).toBe('Invalid WorldStreamMessage payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('throws ProtocolParseError for a malformed member payload', () => {
    expect(
      captureParseError(() => parseWorldStreamMessage({ type: 'snapshot', snapshot: null })).message,
    ).toBe('Invalid snapshot WorldStreamMessage payload');
    expect(
      captureParseError(() => parseWorldStreamMessage({ type: 'events', batch: null })).message,
    ).toBe('Invalid events WorldStreamMessage payload');
  });

  it('throws ProtocolParseError for non-objects', () => {
    expect(captureParseError(() => parseWorldStreamMessage(null)).message).toBe(
      'Invalid WorldStreamMessage payload',
    );
  });
});
