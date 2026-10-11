import { describe, expect, it } from 'vitest';

import {
  isSubmitCommandResponse,
  isTransformChangedEvent,
  isWorldSnapshot,
  parseActorId,
  parseEntityId,
} from '@starvalley/protocol';
import type { ActorId, GameCommand, MoveDirection } from '@starvalley/protocol';

import { DEFAULT_WORLD_SIZE, UnknownActorError, createWorldManager } from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

/** The default known actor/entity ids, produced through the protocol parsers (branded). */
const ACTOR_ID = parseActorId('actor-1');
const ENTITY_ID = parseEntityId('entity-1');

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

/** Build a `GameCommand`; a command deliberately carries no actor field. */
function actorMove(direction: MoveDirection): GameCommand {
  return { type: 'actor.move', direction };
}

describe('DEFAULT_WORLD_SIZE', () => {
  it('is the frozen default', () => {
    expect(DEFAULT_WORLD_SIZE).toEqual({ width: 12, height: 8 });
  });
});

describe('createWorldManager defaults', () => {
  it('starts the single character entity at the world centre', () => {
    const manager = createWorldManager();

    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual({
      size: { width: 12, height: 8 },
      entities: [
        {
          entityId: 'entity-1',
          actorId: 'actor-1',
          kind: 'character',
          transform: { x: 6, y: 4 },
          visible: true,
        },
      ],
      controlledActorId: 'actor-1',
      serverTime: expect.any(String),
    });
  });

  it('snapshot is Protocol-valid', () => {
    const manager = createWorldManager();
    expect(isWorldSnapshot(manager.getSnapshot({ actorId: ACTOR_ID }))).toBe(true);
  });

  it('uses the branded ActorId/EntityId parsers for the default identity', () => {
    const manager = createWorldManager();
    const [entity] = manager.getSnapshot({ actorId: ACTOR_ID }).entities;

    // The branded values parsed from the same strings are accepted and echoed back.
    expect(entity.actorId).toBe(ACTOR_ID);
    expect(entity.actorId).toBe(parseActorId('actor-1'));
    expect(entity.entityId).toBe(ENTITY_ID);
    expect(entity.entityId).toBe(parseEntityId('entity-1'));
  });

  it('honours custom worldSize, actorId and entityId', () => {
    const customActorId = parseActorId('farmer-42');
    const customEntityId = parseEntityId('entity-42');
    const manager = createWorldManager({
      worldSize: { width: 5, height: 3 },
      actorId: customActorId,
      entityId: customEntityId,
    });

    const snapshot = manager.getSnapshot({ actorId: customActorId });
    expect(snapshot).toEqual({
      size: { width: 5, height: 3 },
      entities: [
        {
          entityId: 'entity-42',
          actorId: 'farmer-42',
          kind: 'character',
          transform: { x: 2, y: 1 },
          visible: true,
        },
      ],
      controlledActorId: 'farmer-42',
      serverTime: expect.any(String),
    });
    // The Phase-4 EntityState contract carries no display name: the entity
    // exposes exactly these five keys and nothing else.
    expect(Object.keys(snapshot.entities[0]).sort()).toEqual(
      ['actorId', 'entityId', 'kind', 'transform', 'visible'].sort(),
    );
  });
});

describe('snapshot shape', () => {
  it('exposes entities + controlledActorId and no phase-3 actor/player key', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(Object.keys(snapshot).sort()).toEqual(
      ['controlledActorId', 'entities', 'serverTime', 'size'].sort(),
    );
    expect(snapshot).not.toHaveProperty('actor');
    expect(snapshot).not.toHaveProperty('player');
  });

  it('entity has exactly entityId/actorId/kind/transform/visible, matching the configured actor', () => {
    const manager = createWorldManager();
    const [entity] = manager.getSnapshot({ actorId: ACTOR_ID }).entities;

    expect(Object.keys(entity).sort()).toEqual(
      ['actorId', 'entityId', 'kind', 'transform', 'visible'].sort(),
    );
    expect(entity.actorId).toBe(ACTOR_ID);
    expect(entity.kind).toBe('character');
    expect(entity.transform).toEqual({ x: 6, y: 4 });
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
  const cases: Array<{ direction: MoveDirection; to: { x: number; y: number } }> = [
    { direction: 'north', to: { x: 6, y: 3 } },
    { direction: 'south', to: { x: 6, y: 5 } },
    { direction: 'east', to: { x: 7, y: 4 } },
    { direction: 'west', to: { x: 5, y: 4 } },
  ];

  it.each(cases)(
    '$direction emits exactly one transform.changed event carrying the NEW transform',
    ({ direction, to }) => {
      const clock = fakeClock(START);
      const manager = createWorldManager({ clock: clock.now });

      const result = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove(direction) });

      expect(result).toEqual({
        events: [
          { type: 'transform.changed', entityId: ENTITY_ID, transform: to },
        ],
        serverTime: START.toISOString(),
      });
      expect(result.events).toHaveLength(1);
      expect(isTransformChangedEvent(result.events[0])).toBe(true);
      expect(isSubmitCommandResponse(result)).toBe(true);

      // Authoritative state advanced too, and the snapshot reflects the event.
      expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual(to);
    },
  );
});

describe('edge refusal', () => {
  it('refuses a west step at x=0 with events: [] and leaves the snapshot unchanged', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 }, clock: clock.now });
    // Centre is (1,1). Walk west once to x=0.
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') }).events).toHaveLength(1);
    const before = manager.getSnapshot({ actorId: ACTOR_ID });

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') });

    expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 0, y: 1 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual(
      before.entities[0].transform,
    );

    // Recoverable: a valid move still works and emits an event.
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') }).events).toHaveLength(1);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 1 });
  });

  it('refuses an east step at x=width-1 with events: [] and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') }).events).toHaveLength(1); // x=2
    const before = manager.getSnapshot({ actorId: ACTOR_ID });

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });

    expect(refused.events).toEqual([]);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 2, y: 1 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual(
      before.entities[0].transform,
    );

    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') }).events).toHaveLength(1);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 1 });
  });

  it('refuses a north step at y=0 with events: [] and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events).toHaveLength(1); // y=0
    const before = manager.getSnapshot({ actorId: ACTOR_ID });

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });

    expect(refused.events).toEqual([]);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 0 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual(
      before.entities[0].transform,
    );

    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') }).events).toHaveLength(1);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 1 });
  });

  it('refuses a south step at y=height-1 with events: [] and stays recoverable', () => {
    const manager = createWorldManager({ worldSize: { width: 3, height: 3 } });
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') }).events).toHaveLength(1); // y=2
    const before = manager.getSnapshot({ actorId: ACTOR_ID });

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') });

    expect(refused.events).toEqual([]);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 2 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual(
      before.entities[0].transform,
    );

    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events).toHaveLength(1);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 1, y: 1 });
  });

  it('does not throw for an out-of-bounds step and reports an empty event list', () => {
    const manager = createWorldManager({ worldSize: { width: 1, height: 1 } });
    expect(() =>
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }),
    ).not.toThrow();
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events).toEqual([]);
  });
});

describe('UnknownActorError', () => {
  it('submitCommand throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.submitCommand({ actorId: ghost, command: actorMove('north') });
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
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }),
    ).toThrow(UnknownActorError);
    expect(() => manager.getSnapshot({ actorId: ACTOR_ID })).toThrow(UnknownActorError);
    expect(
      manager.submitCommand({ actorId: customActorId, command: actorMove('north') }).events,
    ).toHaveLength(1);
  });
});

describe('typed-input actor scoping', () => {
  it('uses the ActorId from the typed input, not the command', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    const result = manager.submitCommand({ actorId: customActorId, command: actorMove('east') });
    const [event] = result.events;
    expect(event.type).toBe('transform.changed');

    const snapshot = manager.getSnapshot({ actorId: customActorId });
    expect(snapshot.controlledActorId).toBe(customActorId);
    expect(snapshot.entities[0].actorId).toBe(customActorId);
    // The branded value survives the round-trip.
    const entityActorId: ActorId | null = snapshot.entities[0].actorId;
    expect(entityActorId).toBe(customActorId);
  });

  it('a command carries only type + direction, never an actor field', () => {
    const command = actorMove('north');
    expect(Object.keys(command).sort()).toEqual(['direction', 'type']);
  });
});

describe('serverTime', () => {
  it('is deterministic from an injected clock and reflects the call time', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:05.000Z');

    clock.advance(1_000);
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).serverTime,
    ).toBe('2025-01-02T03:04:06.000Z');

    // A refused step still stamps the call time.
    const edgeManager = createWorldManager({ worldSize: { width: 1, height: 1 }, clock: clock.now });
    const refused = edgeManager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });
    expect(refused.events).toEqual([]);
    expect(refused.serverTime).toBe('2025-01-02T03:04:06.000Z');

    clock.advance(1_000);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:07.000Z');
  });
});

describe('defensive copies', () => {
  it('mutating a snapshot does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    snapshot.entities[0].transform.x = 999;
    snapshot.entities[0].transform.y = 999;
    snapshot.entities[0].actorId = parseActorId('hacked');
    snapshot.entities.push({ ...snapshot.entities[0] });
    snapshot.size.width = 999;
    snapshot.controlledActorId = parseActorId('hacked');

    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual({
      size: { width: 12, height: 8 },
      entities: [
        {
          entityId: 'entity-1',
          actorId: 'actor-1',
          kind: 'character',
          transform: { x: 6, y: 4 },
          visible: true,
        },
      ],
      controlledActorId: 'actor-1',
      serverTime: expect.any(String),
    });
  });

  it('mutating a submitCommand result does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const result = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const [event] = result.events;
    if (event.type === 'transform.changed') {
      event.transform.x = -50;
      event.transform.y = -50;
    }
    result.events.push({ type: 'transform.changed', entityId: ENTITY_ID, transform: { x: 1, y: 1 } });

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(snapshot.entities[0].transform).toEqual({ x: 7, y: 4 });

    // The manager still advances correctly afterwards.
    const next = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const [nextEvent] = next.events;
    expect(nextEvent.type).toBe('transform.changed');
    if (nextEvent.type === 'transform.changed') {
      expect(nextEvent.transform).toEqual({ x: 8, y: 4 });
    }
  });

  it('returns fresh nested objects and arrays each read', () => {
    const manager = createWorldManager();
    const first = manager.getSnapshot({ actorId: ACTOR_ID });
    const second = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(first).not.toBe(second);
    expect(first.size).not.toBe(second.size);
    expect(first.entities).not.toBe(second.entities);
    expect(first.entities[0]).not.toBe(second.entities[0]);
    expect(first.entities[0].transform).not.toBe(second.entities[0].transform);
  });

  it('returns a fresh events array per command call', () => {
    const manager = createWorldManager();
    const first = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const second = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') });

    expect(first.events).not.toBe(second.events);
    expect(first.events[0]).not.toBe(second.events[0]);
  });
});

describe('manager instances', () => {
  it('are independent', () => {
    const a = createWorldManager();
    const b = createWorldManager({ worldSize: { width: 4, height: 4 } });

    a.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    a.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });

    expect(a.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 8, y: 4 });
    expect(b.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform).toEqual({ x: 2, y: 2 });
    expect(a.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 12, height: 8 });
    expect(b.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 4, height: 4 });
  });
});
