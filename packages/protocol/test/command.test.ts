import { describe, expect, it } from 'vitest';

import {
  isActorMoveCommand,
  isGameCommand,
  isSubmitCommandResponse,
  parseActorMoveCommand,
  parseGameCommand,
  parseSubmitCommandResponse,
} from '../src/index.ts';
import type { GameCommand, MoveDirection } from '../src/index.ts';
import {
  captureParseError,
  validActorMoveCommand,
  validSubmitCommandResponse,
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

describe('isActorMoveCommand', () => {
  it('accepts a well-formed command', () => {
    expect(isActorMoveCommand(validActorMoveCommand)).toBe(true);
    expect(isActorMoveCommand({ type: 'actor.move', direction: 'west' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isActorMoveCommand(value)).toBe(false);
  });

  it.each(['type', 'direction'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validActorMoveCommand };
    delete value[key];
    expect(isActorMoveCommand(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isActorMoveCommand({ ...validActorMoveCommand, extra: 1 })).toBe(false);
  });

  it('rejects an attempted actor field (client may not name the actor)', () => {
    expect(isActorMoveCommand({ actorId: 'actor-1', direction: 'east' })).toBe(false);
    expect(isActorMoveCommand({ playerId: 'p', direction: 'east' })).toBe(false);
    expect(isActorMoveCommand({ ...validActorMoveCommand, actorId: 'actor-1' })).toBe(false);
  });

  it('rejects a bad type discriminant or a bad direction', () => {
    expect(isActorMoveCommand({ type: 'actor.walk', direction: 'east' })).toBe(false);
    expect(isActorMoveCommand({ type: 'move', direction: 'east' })).toBe(false);
    expect(isActorMoveCommand({ type: 1, direction: 'east' })).toBe(false);
    expect(isActorMoveCommand({ type: 'actor.move', direction: 'up' })).toBe(false);
    expect(isActorMoveCommand({ type: 'actor.move', direction: 2 })).toBe(false);
  });
});

describe('parseActorMoveCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseActorMoveCommand(validActorMoveCommand)).toBe(validActorMoveCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseActorMoveCommand({ type: 'actor.move', direction: 'up' }),
    );
    expect(error.message).toBe('Invalid ActorMoveCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isGameCommand', () => {
  it('accepts the known command', () => {
    expect(isGameCommand(validActorMoveCommand)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGameCommand(value)).toBe(false);
  });

  it('rejects an unknown type discriminant', () => {
    expect(isGameCommand({ type: 'actor.jump', direction: 'north' })).toBe(false);
    expect(isGameCommand({ type: 'unknown' })).toBe(false);
  });

  it('rejects the phase-3 shapes (no `type`, and named-actor fields)', () => {
    // Phase-3 `MoveActorCommand` was a flat `{ direction }` with no discriminant.
    expect(isGameCommand({ direction: 'north' })).toBe(false);
    // Phase-3 player-shaped command.
    expect(isGameCommand({ playerId: 'player-1', direction: 'north' })).toBe(false);
    // Flat actor field on an otherwise valid shape.
    expect(isGameCommand({ actorId: 'actor-1', direction: 'north' })).toBe(false);
    expect(isGameCommand({ ...validActorMoveCommand, actorId: 'actor-1' })).toBe(false);
    expect(isGameCommand({ ...validActorMoveCommand, playerId: 'player-1' })).toBe(false);
  });
});

describe('parseGameCommand', () => {
  it('parses a command into the discriminated union without a cast', () => {
    const value: unknown = { type: 'actor.move', direction: 'east' };
    const command: GameCommand = parseGameCommand(value);
    if (command.type === 'actor.move') {
      const direction: MoveDirection = command.direction;
      expect(direction).toBe('east');
    } else {
      throw new Error('unreachable: single-member union should narrow');
    }
  });

  it('throws ProtocolParseError for an unknown type discriminant', () => {
    const error = captureParseError(() => parseGameCommand({ type: 'actor.jump' }));
    expect(error.message).toBe('Invalid GameCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('throws ProtocolParseError for both phase-3 shapes', () => {
    expect(captureParseError(() => parseGameCommand({ direction: 'north' })).message).toBe(
      'Invalid GameCommand payload',
    );
    expect(
      captureParseError(() => parseGameCommand({ playerId: 'player-1', direction: 'north' })).message,
    ).toBe('Invalid GameCommand payload');
    expect(
      captureParseError(() => parseGameCommand({ actorId: 'actor-1', direction: 'north' })).message,
    ).toBe('Invalid GameCommand payload');
  });

  it('rejects MoveActorCommand-shaped payloads as a regression guard', () => {
    // The phase-3 MoveActorCommand is no longer accepted anywhere.
    expect(isActorMoveCommand({ direction: 'north' })).toBe(false);
    expect(isGameCommand({ direction: 'north' })).toBe(false);
    expect(() => parseGameCommand({ direction: 'north' })).toThrow();
  });
});

describe('isSubmitCommandResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isSubmitCommandResponse(validSubmitCommandResponse)).toBe(true);
  });

  it('accepts an empty events array (a refused command is the empty delta)', () => {
    expect(isSubmitCommandResponse({ events: [], serverTime: '2025-01-02T03:04:05.000Z' })).toBe(
      true,
    );
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isSubmitCommandResponse(value)).toBe(false);
  });

  it.each(['events', 'serverTime'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validSubmitCommandResponse };
    delete value[key];
    expect(isSubmitCommandResponse(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isSubmitCommandResponse({ ...validSubmitCommandResponse, moved: true })).toBe(false);
  });

  it('rejects a non-array events field and malformed events', () => {
    expect(isSubmitCommandResponse({ ...validSubmitCommandResponse, events: {} })).toBe(false);
    expect(isSubmitCommandResponse({ ...validSubmitCommandResponse, events: null })).toBe(false);
    expect(
      isSubmitCommandResponse({ ...validSubmitCommandResponse, events: [{ type: 'unknown' }] }),
    ).toBe(false);
    expect(
      isSubmitCommandResponse({
        ...validSubmitCommandResponse,
        events: [{ ...validTransformChangedEvent, transform: { x: 1.5, y: 2 } }],
      }),
    ).toBe(false);
  });

  it('rejects a non-ISO serverTime', () => {
    expect(isSubmitCommandResponse({ ...validSubmitCommandResponse, serverTime: 'now' })).toBe(false);
  });
});

describe('parseSubmitCommandResponse', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseSubmitCommandResponse(validSubmitCommandResponse)).toBe(validSubmitCommandResponse);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseSubmitCommandResponse({ events: [] }));
    expect(error.message).toBe('Invalid SubmitCommandResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
