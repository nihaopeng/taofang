import { describe, expect, it } from 'vitest';

import { isGameInfo, isHealthStatus, PROTOCOL_VERSION } from '@starvalley/protocol';

import { createGameInfoManager, SERVER_VERSION } from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

/** Deterministic, mutable clock for exercising time-dependent semantics. */
function fakeClock(start: Date) {
  let current = start;
  return {
    now: (): Date => current,
    set: (date: Date): void => {
      current = date;
    },
    advance: (milliseconds: number): void => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe('SERVER_VERSION', () => {
  it('is the phase-1 server build version', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
  });
});

describe('createGameInfoManager defaults', () => {
  it('defaults gameName and serverVersion and reports the protocol version', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now });

    expect(manager.getGameInfo()).toEqual({
      gameName: 'Starvalley',
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: START.toISOString(),
    });
  });

  it('honours explicit gameName and serverVersion overrides', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({
      clock: clock.now,
      gameName: 'Starvalley Test',
      serverVersion: '9.9.9',
    });

    expect(manager.getGameInfo()).toEqual({
      gameName: 'Starvalley Test',
      serverVersion: '9.9.9',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: START.toISOString(),
    });
  });
});

describe('getGameInfo', () => {
  it('returns an exact, Protocol-valid GameInfo using the injected clock', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now, startedAt: START });
    clock.set(new Date('2025-01-02T04:00:00.000Z'));

    const info = manager.getGameInfo();

    expect(info).toEqual({
      gameName: 'Starvalley',
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2025-01-02T04:00:00.000Z',
    });
    expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(isGameInfo(info)).toBe(true);
  });

  it('reports a valid ISO-8601 UTC serverTime across clock values', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now });

    for (const iso of ['2025-06-15T12:00:00.000Z', '2030-12-31T23:59:59.999Z']) {
      clock.set(new Date(iso));
      const { serverTime } = manager.getGameInfo();
      expect(serverTime).toBe(iso);
      expect(new Date(serverTime).toISOString()).toBe(serverTime);
    }
  });
});

describe('getHealth', () => {
  it('returns an exact, Protocol-valid HealthStatus at start', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now, startedAt: START });

    const health = manager.getHealth();

    expect(health).toEqual({
      status: 'ok',
      uptimeSeconds: 0,
      serverTime: START.toISOString(),
    });
    expect(isHealthStatus(health)).toBe(true);
  });

  it('computes uptime from injected now', () => {
    const manager = createGameInfoManager({ clock: fakeClock(START).now, startedAt: START });

    expect(manager.getHealth(new Date('2025-01-02T03:04:10.000Z'))).toEqual({
      status: 'ok',
      uptimeSeconds: 5,
      serverTime: '2025-01-02T03:04:10.000Z',
    });
  });

  it('uses the clock when now is omitted', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now, startedAt: START });
    clock.advance(90_000);

    expect(manager.getHealth()).toEqual({
      status: 'ok',
      uptimeSeconds: 90,
      serverTime: '2025-01-02T03:05:35.000Z',
    });
  });

  it('floors fractional seconds', () => {
    const manager = createGameInfoManager({ clock: fakeClock(START).now, startedAt: START });

    expect(manager.getHealth(new Date(START.getTime() + 1_999)).uptimeSeconds).toBe(1);
    expect(manager.getHealth(new Date(START.getTime() + 1_000)).uptimeSeconds).toBe(1);
    expect(manager.getHealth(new Date(START.getTime() + 999)).uptimeSeconds).toBe(0);
  });

  it('never reports negative uptime when now precedes startedAt', () => {
    const manager = createGameInfoManager({ clock: fakeClock(START).now, startedAt: START });

    const health = manager.getHealth(new Date(START.getTime() - 60_000));

    expect(health.uptimeSeconds).toBe(0);
    expect(isHealthStatus(health)).toBe(true);
  });

  it('grows monotonically as the fake clock advances', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now, startedAt: START });

    expect(manager.getHealth().uptimeSeconds).toBe(0);
    clock.advance(1_000);
    expect(manager.getHealth().uptimeSeconds).toBe(1);
    clock.advance(59_000);
    expect(manager.getHealth().uptimeSeconds).toBe(60);
    clock.advance(3_600_000);
    expect(manager.getHealth().uptimeSeconds).toBe(3660);
  });
});

describe('startedAt default', () => {
  it('captures clock() once at creation time, not lazily', () => {
    const clock = fakeClock(START);
    const manager = createGameInfoManager({ clock: clock.now });

    clock.advance(30_000);

    expect(manager.getHealth().uptimeSeconds).toBe(30);
    expect(manager.getHealth().serverTime).toBe('2025-01-02T03:04:35.000Z');
  });
});

describe('manager instances', () => {
  it('are independent: separate clocks, start instants, and identity', () => {
    const clockA = fakeClock(START);
    const clockB = fakeClock(new Date('2026-03-04T05:06:07.000Z'));

    const a = createGameInfoManager({ clock: clockA.now, gameName: 'Farm A' });
    const b = createGameInfoManager({
      clock: clockB.now,
      startedAt: new Date('2026-03-04T05:00:00.000Z'),
      gameName: 'Farm B',
      serverVersion: '2.0.0',
    });

    clockA.advance(10_000);
    clockB.advance(20_000);

    expect(a.getGameInfo()).toEqual({
      gameName: 'Farm A',
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2025-01-02T03:04:15.000Z',
    });
    expect(b.getGameInfo()).toEqual({
      gameName: 'Farm B',
      serverVersion: '2.0.0',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '2026-03-04T05:06:27.000Z',
    });

    expect(a.getHealth().uptimeSeconds).toBe(10);
    expect(b.getHealth().uptimeSeconds).toBe(387);
    expect(a.getHealth()).not.toEqual(b.getHealth());
  });
});
