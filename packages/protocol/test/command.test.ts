import { describe, expect, it } from 'vitest';

import {
  isGameCommand,
  isGameEventBatch,
  isMoveIntentCommand,
  parseGameCommand,
  parseGameEventBatch,
  parseMoveIntentCommand,
} from '../src/index.ts';
import type { GameCommand, GameEventBatch, MoveIntentCommand } from '../src/index.ts';
import {
  captureParseError,
  validGameEventBatch,
  validMoveIntentCommand,
  validTransformChangedEvent,
} from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

/** Wrap a movement value in an otherwise valid intent command. */
function intentWith(movement: unknown): Record<string, unknown> {
  return { type: 'actor.moveIntent', movement };
}

describe('moveIntent movement magnitude (via isMoveIntentCommand)', () => {
  it('accepts directions within the unit disc, including stop', () => {
    expect(isMoveIntentCommand(intentWith({ x: 1, z: 0 }))).toBe(true);
    expect(isMoveIntentCommand(intentWith({ x: 0, z: 0 }))).toBe(true);
    expect(isMoveIntentCommand(intentWith({ x: 0.6, z: 0.8 }))).toBe(true);
    expect(isMoveIntentCommand(intentWith({ x: -1, z: 0 }))).toBe(true);
  });

  it('accepts a magnitude exactly 1 and a tiny overshoot within epsilon', () => {
    expect(isMoveIntentCommand(intentWith({ x: 1, z: 0 }))).toBe(true);
    expect(isMoveIntentCommand(intentWith({ x: 1 + 1e-7, z: 0 }))).toBe(true);
  });

  it('rejects a magnitude above 1 beyond epsilon', () => {
    expect(isMoveIntentCommand(intentWith({ x: 1.0001, z: 0 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: 2, z: 0 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: 0.7072, z: 0.7072 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: -1.5, z: 0 }))).toBe(false);
  });

  it('rejects non-finite components', () => {
    expect(isMoveIntentCommand(intentWith({ x: Number.NaN, z: 0 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: Number.POSITIVE_INFINITY, z: 0 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: 0, z: Number.NEGATIVE_INFINITY }))).toBe(false);
  });

  it.each(['x', 'z'])('rejects a missing %s', (key) => {
    const movement: Record<string, unknown> = { x: 1, z: 0 };
    delete movement[key];
    expect(isMoveIntentCommand(intentWith(movement))).toBe(false);
  });

  it('rejects unknown extra fields and a 2D `{ x, y }` shape', () => {
    expect(isMoveIntentCommand(intentWith({ x: 1, z: 0, y: 0 }))).toBe(false);
    expect(isMoveIntentCommand(intentWith({ x: 1, y: 0 }))).toBe(false);
  });

  it('rejects a non-object movement for every non-object', () => {
    for (const [, value] of nonObjects) {
      expect(isMoveIntentCommand(intentWith(value))).toBe(false);
    }
  });
});

describe('isMoveIntentCommand', () => {
  it('accepts a well-formed intent command', () => {
    expect(isMoveIntentCommand(validMoveIntentCommand)).toBe(true);
    expect(isMoveIntentCommand({ type: 'actor.moveIntent', movement: { x: 0, z: 0 } })).toBe(true);
    expect(isMoveIntentCommand({ type: 'actor.moveIntent', movement: { x: 0.5, z: -0.5 } })).toBe(
      true,
    );
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMoveIntentCommand(value)).toBe(false);
  });

  it.each(['type', 'movement'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validMoveIntentCommand };
    delete value[key];
    expect(isMoveIntentCommand(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isMoveIntentCommand({ ...validMoveIntentCommand, extra: 1 })).toBe(false);
  });

  it('rejects an attempted actor field (the client may not name the actor)', () => {
    expect(isMoveIntentCommand({ actorId: 'actor-1', type: 'actor.moveIntent', movement: { x: 1, z: 0 } })).toBe(
      false,
    );
    expect(isMoveIntentCommand({ ...validMoveIntentCommand, actorId: 'actor-1' })).toBe(false);
    expect(isMoveIntentCommand({ ...validMoveIntentCommand, playerId: 'player-1' })).toBe(false);
  });

  it('rejects a bad type discriminant or a malformed movement', () => {
    expect(isMoveIntentCommand({ type: 'actor.move', movement: { x: 1, z: 0 } })).toBe(false);
    expect(isMoveIntentCommand({ type: 'actor.moveIntent', movement: null })).toBe(false);
    expect(isMoveIntentCommand({ type: 'actor.moveIntent', movement: { x: 2 } })).toBe(false);
    expect(isMoveIntentCommand({ type: 1, movement: { x: 1, z: 0 } })).toBe(false);
  });
});

describe('parseMoveIntentCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMoveIntentCommand(validMoveIntentCommand)).toBe(validMoveIntentCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseMoveIntentCommand({ type: 'actor.moveIntent', movement: { x: 2, z: 0 } }),
    );
    expect(error.message).toBe('Invalid MoveIntentCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isGameCommand', () => {
  it('accepts the known command', () => {
    expect(isGameCommand(validMoveIntentCommand)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGameCommand(value)).toBe(false);
  });

  it('rejects an unknown type discriminant, including the deleted `actor.move`', () => {
    expect(isGameCommand({ type: 'actor.jump', movement: { x: 1, z: 0 } })).toBe(false);
    expect(isGameCommand({ type: 'unknown' })).toBe(false);
    expect(isGameCommand({ type: 'actor.move', direction: 'north' })).toBe(false);
  });

  it('rejects the phase-6 shapes (one-tile direction, and named-actor fields)', () => {
    expect(isGameCommand({ type: 'actor.move', direction: 'north' })).toBe(false);
    expect(isGameCommand({ direction: 'north' })).toBe(false);
    expect(isGameCommand({ ...validMoveIntentCommand, actorId: 'actor-1' })).toBe(false);
    expect(isGameCommand({ ...validMoveIntentCommand, playerId: 'player-1' })).toBe(false);
  });
});

describe('parseGameCommand', () => {
  it('parses a command into the discriminated union without a cast', () => {
    const value: unknown = { type: 'actor.moveIntent', movement: { x: -1, z: 0 } };
    const command: GameCommand = parseGameCommand(value);
    if (command.type === 'actor.moveIntent') {
      const movement: { x: number; z: number } = command.movement;
      expect(movement).toEqual({ x: -1, z: 0 });
    } else {
      throw new Error('unreachable: single-member union should narrow');
    }
  });

  it('throws ProtocolParseError for an unknown type discriminant', () => {
    const error = captureParseError(() => parseGameCommand({ type: 'actor.jump' }));
    expect(error.message).toBe('Invalid GameCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('throws ProtocolParseError for the deleted phase-6 move command shape', () => {
    expect(captureParseError(() => parseGameCommand({ type: 'actor.move', direction: 'north' })).message).toBe(
      'Invalid GameCommand payload',
    );
    expect(captureParseError(() => parseGameCommand({ direction: 'north' })).message).toBe(
      'Invalid GameCommand payload',
    );
  });
});

describe('isGameEventBatch', () => {
  it('accepts a well-formed batch', () => {
    expect(isGameEventBatch(validGameEventBatch)).toBe(true);
  });

  it('accepts an empty events array (a refused command / idle tick is the empty delta)', () => {
    expect(isGameEventBatch({ events: [], serverTime: '2025-01-02T03:04:05.000Z' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGameEventBatch(value)).toBe(false);
  });

  it.each(['events', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validGameEventBatch };
    delete value[key];
    expect(isGameEventBatch(value)).toBe(false);
  });

  it('rejects unknown extra fields (including the removed `moved` flag)', () => {
    expect(isGameEventBatch({ ...validGameEventBatch, moved: true })).toBe(false);
  });

  it('rejects a non-array events field and malformed events', () => {
    expect(isGameEventBatch({ ...validGameEventBatch, events: {} })).toBe(false);
    expect(isGameEventBatch({ ...validGameEventBatch, events: null })).toBe(false);
    expect(isGameEventBatch({ ...validGameEventBatch, events: [{ type: 'unknown' }] })).toBe(false);
    expect(
      isGameEventBatch({
        ...validGameEventBatch,
        events: [{ ...validTransformChangedEvent, transform: { x: 1, y: 2 } }],
      }),
    ).toBe(false);
  });

  it('rejects a non-ISO serverTime', () => {
    expect(isGameEventBatch({ ...validGameEventBatch, serverTime: 'now' })).toBe(false);
  });

  it('does not accept the old `SubmitCommandResponse` name as a wire shape', () => {
    // There is no alias: the envelope is `GameEventBatch` and its keys are exact.
    const legacy = { commandResult: { events: [], serverTime: '2025-01-02T03:04:05.000Z' } };
    expect(isGameEventBatch(legacy)).toBe(false);
  });
});

describe('parseGameEventBatch', () => {
  it('returns the value unchanged when valid', () => {
    const batch: GameEventBatch = validGameEventBatch;
    expect(parseGameEventBatch(batch)).toBe(validGameEventBatch);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGameEventBatch({ events: [] }));
    expect(error.message).toBe('Invalid GameEventBatch payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

/**
 * Type-level exactness guard: `GameCommand` must stay exactly one member. The
 * literal tuple and the `Exact` comparison fail `tsc` if a member is added or
 * removed, so "no new instruction" is enforced by the compiler, not just
 * asserted in prose.
 */
const gameCommandTypes = ['actor.moveIntent'] as const;
type ListedGameCommandType = (typeof gameCommandTypes)[number];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Exported so `noUnusedLocals` cannot swallow the compile-time exactness proof. */
export const gameCommandTypesAreExact: Exact<GameCommand['type'], ListedGameCommandType> = true;

/** Keep `MoveIntentCommand` referenced so the union member is not a swallowed local. */
export const moveIntentCommandType: MoveIntentCommand['type'] = 'actor.moveIntent';

describe('GameCommand exact shape', () => {
  it('is exactly one member (`actor.moveIntent`) and has no catch-all', () => {
    expect(gameCommandTypesAreExact).toBe(true);
    expect(gameCommandTypes).toHaveLength(1);
    expect(gameCommandTypes[0]).toBe('actor.moveIntent');
    expect(moveIntentCommandType).toBe('actor.moveIntent');
  });
});
