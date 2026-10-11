import { describe, expect, it } from 'vitest';

import { isMoveActorResult, isWorldSnapshot, parseActorId } from '@starvalley/protocol';
import type { ActorId, MoveDirection } from '@starvalley/protocol';

import {
  DEFAULT_WORLD_SIZE,
  UnknownActorError,
  createWorldManager,
} from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

/** The default known actor id, produced through the protocol parser (branded). */
const ACTOR_ID = parseActorId('actor-1');

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
  it('starts the actor at the world centre', () => {
    const manager = createWorldManager();

    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual({
      size: { width: 12, height: 8 },
      actor: {
        actorId: 'actor-1',
        name: 'Player',
        position: { x: 6, y: 4 },
      },
      serverTime: expect.any(String),
    });
  });

  it('snapshot is Protocol-valid', () => {
    const manager = createWorldManager();
    expect(isWorldSnapshot(manager.getSnapshot({ actorId: ACTOR_ID }))).toBe(true);
  });

  it('uses the branded ActorId from parseActorId as the default identity', () => {
    const manager = createWorldManager();
    const { actor } = manager.getSnapshot({ actorId: ACTOR_ID });

    // The branded value parsed from the same string is accepted and echoed back.
    expect(actor.actorId).toBe(ACTOR_ID);
    expect(actor.actorId).toBe(parseActorId('actor-1'));
  });

  it('honours custom worldSize, actorId and actorName', () => {
    const customActorId = parseActorId('farmer-42');
    const manager = createWorldManager({
      worldSize: { width: 5, height: 3 },
      actorId: customActorId,
      actorName: 'Abigail',
    });

    expect(manager.getSnapshot({ actorId: customActorId })).toEqual({
      size: { width: 5, height: 3 },
      actor: { actorId: 'farmer-42', name: 'Abigail', position: { x: 2, y: 1 } },
      serverTime: expect.any(String),
    });
  });

  it('returns a snapshot shaped as { size, actor, serverTime } with no player key', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(Object.keys(snapshot).sort()).toEqual(['actor', 'serverTime', 'size'].sort());
    expect('player' in snapshot).toBe(false);
    expect(snapshot).not.toHaveProperty('player');
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

    const result = manager.moveActor({ actorId: ACTOR_ID, command: { direction } });

    expect(result).toEqual({
      actor: { actorId: 'actor-1', name: 'Player', position: to },
      moved: true,
      serverTime: START.toISOString(),
    });
    expect(isMoveActorResult(result)).toBe(true);

    // Authoritative state advanced too.
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual(to);
    // The starting centre is what we expected.
    expect(from).toEqual({ x: 6, y: 4 });
  });
});

describe('edge refusal', () => {
  it('refuses a west step at x=0, leaves position unchanged, and stays recoverable', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 }, clock: clock.now });
    // Centre is (1,1). Walk west once to x=0.
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'west' } }).moved).toBe(true);

    const refused = manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'west' } });

    expect(refused).toEqual({
      actor: { actorId: 'actor-1', name: 'Player', position: { x: 0, y: 1 } },
      moved: false,
      serverTime: START.toISOString(),
    });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 0, y: 1 });

    // Recoverable: a valid move still works.
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } }).moved).toBe(true);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses an east step at x=width-1, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } }).moved).toBe(true); // x=2

    const refused = manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } });

    expect(refused.moved).toBe(false);
    expect(refused.actor.position).toEqual({ x: 2, y: 1 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 2, y: 1 });

    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'west' } }).moved).toBe(true);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses a north step at y=0, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } }).moved).toBe(true); // y=0

    const refused = manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } });

    expect(refused.moved).toBe(false);
    expect(refused.actor.position).toEqual({ x: 1, y: 0 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 0 });

    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'south' } }).moved).toBe(true);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 1 });
  });

  it('refuses a south step at y=height-1, leaves position unchanged, and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'south' } }).moved).toBe(true); // y=2

    const refused = manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'south' } });

    expect(refused.moved).toBe(false);
    expect(refused.actor.position).toEqual({ x: 1, y: 2 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 2 });

    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } }).moved).toBe(true);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 1, y: 1 });
  });

  it('does not throw for an out-of-bounds step', () => {
    const manager = createWorldManager({ worldSize: { width: 1, height: 1 } });
    expect(() => manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } })).not.toThrow();
    expect(manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } }).moved).toBe(false);
  });
});

describe('UnknownActorError', () => {
  it('moveActor throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.moveActor({ actorId: ghost, command: { direction: 'north' } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownActorError);
    const error = caught as UnknownActorError;
    expect(error.name).toBe('UnknownActorError');
    expect(error.actorId).toBe('ghost');
  });

  it('getSnapshot throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.getSnapshot({ actorId: ghost });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownActorError);
    const error = caught as UnknownActorError;
    expect(error.name).toBe('UnknownActorError');
    expect(error.actorId).toBe(ghost);
  });

  it('accepts the configured actorId even when overridden', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    expect(() =>
      manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } }),
    ).toThrow(UnknownActorError);
    expect(() => manager.getSnapshot({ actorId: ACTOR_ID })).toThrow(UnknownActorError);
    expect(
      manager.moveActor({ actorId: customActorId, command: { direction: 'north' } }).moved,
    ).toBe(true);
  });
});

describe('typed-input actor scoping', () => {
  it('uses the ActorId from the typed input, not the command', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    const result = manager.moveActor({ actorId: customActorId, command: { direction: 'east' } });
    expect(result.actor.actorId).toBe(customActorId);

    const snapshot = manager.getSnapshot({ actorId: customActorId });
    expect(snapshot.actor.actorId).toBe(customActorId);
    // The branded value survives the round-trip.
    const actorIdAsActorId: ActorId = snapshot.actor.actorId;
    expect(actorIdAsActorId).toBe(customActorId);
  });
});

describe('serverTime', () => {
  it('is deterministic from an injected clock and reflects the call time', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:05.000Z');

    clock.advance(1_000);
    expect(
      manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } }).serverTime,
    ).toBe('2025-01-02T03:04:06.000Z');

    // A refused step still stamps the call time.
    const edgeManager = createWorldManager({ worldSize: { width: 1, height: 1 }, clock: clock.now });
    const refused = edgeManager.moveActor({ actorId: ACTOR_ID, command: { direction: 'north' } });
    expect(refused.moved).toBe(false);
    expect(refused.serverTime).toBe('2025-01-02T03:04:06.000Z');

    clock.advance(1_000);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:07.000Z');
  });
});

describe('defensive copies', () => {
  it('mutating a snapshot does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    snapshot.actor.position.x = 999;
    snapshot.actor.name = 'Hacked';
    snapshot.size.width = 999;

    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual({
      size: { width: 12, height: 8 },
      actor: { actorId: 'actor-1', name: 'Player', position: { x: 6, y: 4 } },
      serverTime: expect.any(String),
    });
  });

  it('mutating a move result does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const result = manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } });
    result.actor.position.x = -50;
    result.actor.position.y = -50;
    result.moved = false;

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(snapshot.actor.position).toEqual({ x: 7, y: 4 });

    // The manager still advances correctly afterwards.
    expect(
      manager.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } }).actor.position,
    ).toEqual({ x: 8, y: 4 });
  });

  it('returns fresh nested position objects each read', () => {
    const manager = createWorldManager();
    const first = manager.getSnapshot({ actorId: ACTOR_ID });
    const second = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(first.actor.position).not.toBe(second.actor.position);
    expect(first.actor).not.toBe(second.actor);
    expect(first.size).not.toBe(second.size);
  });
});

describe('manager instances', () => {
  it('are independent', () => {
    const a = createWorldManager();
    const b = createWorldManager({ worldSize: { width: 4, height: 4 } });

    a.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } });
    a.moveActor({ actorId: ACTOR_ID, command: { direction: 'east' } });

    expect(a.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 8, y: 4 });
    expect(b.getSnapshot({ actorId: ACTOR_ID }).actor.position).toEqual({ x: 2, y: 2 });
    expect(a.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 12, height: 8 });
    expect(b.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 4, height: 4 });
  });
});
