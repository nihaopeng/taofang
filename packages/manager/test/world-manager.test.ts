import { describe, expect, it } from 'vitest';

import { isMovePlayerResult, isWorldSnapshot } from '@starvalley/protocol';
import type { MoveDirection } from '@starvalley/protocol';

import {
  DEFAULT_WORLD_SIZE,
  UnknownPlayerError,
  createWorldManager,
} from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

/** Deterministic, mutable clock for exercising time-dependent semantics. */
function fakeClock(start: Date) {
  let current = start;
  return {
    now: (): Date => current,
    advance: (milliseconds: number): void => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe('DEFAULT_WORLD_SIZE', () => {
  it('is the frozen Phase-2 default', () => {
    expect(DEFAULT_WORLD_SIZE).toEqual({ width: 12, height: 8 });
  });
});

describe('createWorldManager defaults', () => {
  it('starts the player at the world centre', () => {
    const manager = createWorldManager();

    expect(manager.getSnapshot()).toEqual({
      size: { width: 12, height: 8 },
      player: {
        id: 'player-1',
        name: 'Player',
        position: { x: 6, y: 4 },
      },
      serverTime: expect.any(String),
    });
  });

  it('snapshot is Protocol-valid', () => {
    const manager = createWorldManager();
    expect(isWorldSnapshot(manager.getSnapshot())).toBe(true);
  });

  it('honours custom worldSize, playerId and playerName', () => {
    const manager = createWorldManager({
      worldSize: { width: 5, height: 3 },
      playerId: 'farmer-42',
      playerName: 'Abigail',
    });

    expect(manager.getSnapshot()).toEqual({
      size: { width: 5, height: 3 },
      player: { id: 'farmer-42', name: 'Abigail', position: { x: 2, y: 1 } },
      serverTime: expect.any(String),
    });
  });
});

describe('construction validation', () => {
  it.each([
    ['width', { width: 0, height: 8 }],
    ['width', { width: -1, height: 8 }],
    ['width', { width: 1.5, height: 8 }],
    ['width', { width: Number.NaN, height: 8 }],
    ['height', { width: 12, height: 0 }],
    ['height', { width: 12, height: -3 }],
    ['height', { width: 12, height: 2.5 }],
  ])('throws RangeError for a non-positive-integer %s', (_field, worldSize) => {
    expect(() => createWorldManager({ worldSize })).toThrow(RangeError);
  });
});

describe('movement in each direction', () => {
  const cases: Array<{ direction: MoveDirection; from: { x: number; y: number }; to: { x: number; y: number } }> = [
    { direction: 'north', from: { x: 6, y: 4 }, to: { x: 6, y: 3 } },
    { direction: 'south', from: { x: 6, y: 4 }, to: { x: 6, y: 5 } },
    { direction: 'east', from: { x: 6, y: 4 }, to: { x: 7, y: 4 } },
    { direction: 'west', from: { x: 6, y: 4 }, to: { x: 5, y: 4 } },
  ];

  it.each(cases)('$direction moves exactly one tile to rule-computed position', ({ direction, from, to }) => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    const result = manager.movePlayer({ playerId: 'player-1', direction });

    expect(result).toEqual({
      player: { id: 'player-1', name: 'Player', position: to },
      moved: true,
      serverTime: START.toISOString(),
    });
    expect(isMovePlayerResult(result)).toBe(true);

    // Authoritative state advanced too.
    expect(manager.getSnapshot().player.position).toEqual(to);
    // The starting centre is what we expected.
    expect(from).toEqual({ x: 6, y: 4 });
  });
});

describe('edge refusal', () => {
  it('refuses a west step at x=0, leaves position unchanged, and stays recoverable', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 }, clock: clock.now });
    // Centre is (1,1). Walk west once to x=0.
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'west' }).moved).toBe(true);

    const refused = manager.movePlayer({ playerId: 'player-1', direction: 'west' });

    expect(refused).toEqual({
      player: { id: 'player-1', name: 'Player', position: { x: 0, y: 1 } },
      moved: false,
      serverTime: START.toISOString(),
    });
    expect(manager.getSnapshot().player.position).toEqual({ x: 0, y: 1 });

    // Recoverable: a valid move still works.
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'east' }).moved).toBe(true);
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses an east step at x=width-1, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'east' }).moved).toBe(true); // x=2

    const refused = manager.movePlayer({ playerId: 'player-1', direction: 'east' });

    expect(refused.moved).toBe(false);
    expect(refused.player.position).toEqual({ x: 2, y: 1 });
    expect(manager.getSnapshot().player.position).toEqual({ x: 2, y: 1 });

    expect(manager.movePlayer({ playerId: 'player-1', direction: 'west' }).moved).toBe(true);
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses a north step at y=0, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'north' }).moved).toBe(true); // y=0

    const refused = manager.movePlayer({ playerId: 'player-1', direction: 'north' });

    expect(refused.moved).toBe(false);
    expect(refused.player.position).toEqual({ x: 1, y: 0 });
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 0 });

    expect(manager.movePlayer({ playerId: 'player-1', direction: 'south' }).moved).toBe(true);
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses a south step at y=height-1, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'south' }).moved).toBe(true); // y=2

    const refused = manager.movePlayer({ playerId: 'player-1', direction: 'south' });

    expect(refused.moved).toBe(false);
    expect(refused.player.position).toEqual({ x: 1, y: 2 });
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 2 });

    expect(manager.movePlayer({ playerId: 'player-1', direction: 'north' }).moved).toBe(true);
    expect(manager.getSnapshot().player.position).toEqual({ x: 1, y: 1 });
  });

  it('does not throw for an out-of-bounds step', () => {
    const manager = createWorldManager({ worldSize: { width: 1, height: 1 } });
    expect(() => manager.movePlayer({ playerId: 'player-1', direction: 'north' })).not.toThrow();
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'north' }).moved).toBe(false);
  });
});

describe('UnknownPlayerError', () => {
  it('throws for a non-matching playerId and populates playerId', () => {
    const manager = createWorldManager();

    let caught: unknown;
    try {
      manager.movePlayer({ playerId: 'ghost', direction: 'north' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownPlayerError);
    const error = caught as UnknownPlayerError;
    expect(error.name).toBe('UnknownPlayerError');
    expect(error.playerId).toBe('ghost');
  });

  it('accepts the configured playerId even when overridden', () => {
    const manager = createWorldManager({ playerId: 'farmer-7' });

    expect(() => manager.movePlayer({ playerId: 'player-1', direction: 'north' })).toThrow(
      UnknownPlayerError,
    );
    expect(manager.movePlayer({ playerId: 'farmer-7', direction: 'north' }).moved).toBe(true);
  });
});

describe('serverTime', () => {
  it('is deterministic from an injected clock and reflects the call time', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    expect(manager.getSnapshot().serverTime).toBe('2025-01-02T03:04:05.000Z');

    clock.advance(1_000);
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'north' }).serverTime).toBe(
      '2025-01-02T03:04:06.000Z',
    );

    // A refused step still stamps the call time.
    const edgeManager = createWorldManager({ worldSize: { width: 1, height: 1 }, clock: clock.now });
    const refused = edgeManager.movePlayer({ playerId: 'player-1', direction: 'north' });
    expect(refused.moved).toBe(false);
    expect(refused.serverTime).toBe('2025-01-02T03:04:06.000Z');

    clock.advance(1_000);
    expect(manager.getSnapshot().serverTime).toBe('2025-01-02T03:04:07.000Z');
  });
});

describe('defensive copies', () => {
  it('mutating a snapshot does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot();
    snapshot.player.position.x = 999;
    snapshot.player.name = 'Hacked';
    snapshot.size.width = 999;

    expect(manager.getSnapshot()).toEqual({
      size: { width: 12, height: 8 },
      player: { id: 'player-1', name: 'Player', position: { x: 6, y: 4 } },
      serverTime: expect.any(String),
    });
  });

  it('mutating a move result does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const result = manager.movePlayer({ playerId: 'player-1', direction: 'east' });
    result.player.position.x = -50;
    result.player.position.y = -50;
    result.moved = false;

    const snapshot = manager.getSnapshot();
    expect(snapshot.player.position).toEqual({ x: 7, y: 4 });

    // The manager still advances correctly afterwards.
    expect(manager.movePlayer({ playerId: 'player-1', direction: 'east' }).player.position).toEqual({
      x: 8,
      y: 4,
    });
  });

  it('returns fresh nested position objects each read', () => {
    const manager = createWorldManager();
    const first = manager.getSnapshot();
    const second = manager.getSnapshot();
    expect(first.player.position).not.toBe(second.player.position);
    expect(first.player).not.toBe(second.player);
    expect(first.size).not.toBe(second.size);
  });
});

describe('manager instances', () => {
  it('are independent', () => {
    const a = createWorldManager();
    const b = createWorldManager({ worldSize: { width: 4, height: 4 } });

    a.movePlayer({ playerId: 'player-1', direction: 'east' });
    a.movePlayer({ playerId: 'player-1', direction: 'east' });

    expect(a.getSnapshot().player.position).toEqual({ x: 8, y: 4 });
    expect(b.getSnapshot().player.position).toEqual({ x: 2, y: 2 });
    expect(a.getSnapshot().size).toEqual({ width: 12, height: 8 });
    expect(b.getSnapshot().size).toEqual({ width: 4, height: 4 });
  });
});
