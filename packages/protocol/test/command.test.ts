import { describe, expect, it } from 'vitest';

import {
  isActorJumpCommand,
  isBlockRemoveCommand,
  isBlockSetCommand,
  isCommandResponse,
  isEntityPlaceCommand,
  isEntityRemoveCommand,
  isEntityRotateCommand,
  isEntityValidatePlacementCommand,
  isGameCommand,
  isGameEventBatch,
  isInteractCommand,
  isMoveIntentCommand,
  isMoveToCommand,
  isValidatePlacementResponse,
  parseActorJumpCommand,
  parseBlockRemoveCommand,
  parseBlockSetCommand,
  parseCommandResponse,
  parseEntityPlaceCommand,
  parseEntityRemoveCommand,
  parseEntityRotateCommand,
  parseEntityValidatePlacementCommand,
  parseGameCommand,
  parseGameEventBatch,
  parseInteractCommand,
  parseMoveIntentCommand,
  parseMoveToCommand,
  parseValidatePlacementResponse,
} from '../src/index.ts';
import type {
  ActorJumpCommand,
  BlockRemoveCommand,
  BlockSetCommand,
  CommandResponse,
  EntityPlaceCommand,
  EntityRemoveCommand,
  EntityRotateCommand,
  EntityValidatePlacementCommand,
  GameCommand,
  GameEventBatch,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  ValidatePlacementResponse,
} from '../src/index.ts';
import {
  captureParseError,
  validActorJumpCommand,
  validBlockRemoveCommand,
  validBlockSetCommand,
  validEntityPlaceCommand,
  validEntityRemoveCommand,
  validEntityRotateCommand,
  validEntityValidatePlacementCommand,
  validGameEventBatch,
  validInteractCommand,
  validMoveIntentCommand,
  validMoveToCommand,
  validTransformChangedEvent,
  validValidatePlacementResponse,
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

describe('isMoveToCommand', () => {
  it('accepts a well-formed world-space steering goal', () => {
    expect(isMoveToCommand(validMoveToCommand)).toBe(true);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 0, y: 0, z: 0 } })).toBe(true);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 1.5, y: -2.25, z: 3 } })).toBe(
      true,
    );
  });

  it('does NOT bound the target magnitude (reachability is the server\'s business)', () => {
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 1e9, y: -1e9, z: 1e9 } })).toBe(true);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: -99999, y: 12, z: 0.25 } })).toBe(
      true,
    );
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isMoveToCommand(value)).toBe(false);
  });

  it.each(['type', 'target'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validMoveToCommand };
    delete value[key];
    expect(isMoveToCommand(value)).toBe(false);
  });

  it('rejects unknown extra fields (including an actor field)', () => {
    expect(isMoveToCommand({ ...validMoveToCommand, extra: 1 })).toBe(false);
    expect(isMoveToCommand({ ...validMoveToCommand, actorId: 'actor-1' })).toBe(false);
    expect(isMoveToCommand({ ...validMoveToCommand, playerId: 'player-1' })).toBe(false);
  });

  it('rejects a bad type discriminant', () => {
    expect(isMoveToCommand({ type: 'actor.move', target: { x: 1, y: 0, z: 0 } })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveIntent', target: { x: 1, y: 0, z: 0 } })).toBe(false);
    expect(isMoveToCommand({ type: 1, target: { x: 1, y: 0, z: 0 } })).toBe(false);
  });

  it('rejects a malformed target (wrong shape, missing/extra key, wrong type, non-finite)', () => {
    expect(isMoveToCommand({ type: 'actor.moveTo', target: null })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: [] })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: 'origin' })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 1, y: 0 } })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 1, y: 0, z: 0, w: 1 } })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: 1, y: '0', z: 0 } })).toBe(false);
    expect(isMoveToCommand({ type: 'actor.moveTo', target: { x: Number.NaN, y: 0, z: 0 } })).toBe(
      false,
    );
    expect(
      isMoveToCommand({ type: 'actor.moveTo', target: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } }),
    ).toBe(false);
    expect(
      isMoveToCommand({
        type: 'actor.moveTo',
        target: { x: 0, y: 0, z: Number.NEGATIVE_INFINITY },
      }),
    ).toBe(false);
  });
});

describe('parseMoveToCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseMoveToCommand(validMoveToCommand)).toBe(validMoveToCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseMoveToCommand({ type: 'actor.moveTo', target: { x: 1 } }),
    );
    expect(error.message).toBe('Invalid MoveToCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isInteractCommand', () => {
  it('accepts a well-formed interaction request', () => {
    expect(isInteractCommand(validInteractCommand)).toBe(true);
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: 'entity-2' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isInteractCommand(value)).toBe(false);
  });

  it.each(['type', 'targetEntityId'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validInteractCommand };
    delete value[key];
    expect(isInteractCommand(value)).toBe(false);
  });

  it('rejects unknown extra fields (including a position / actor field)', () => {
    expect(isInteractCommand({ ...validInteractCommand, position: { x: 0, y: 0, z: 0 } })).toBe(
      false,
    );
    expect(isInteractCommand({ ...validInteractCommand, actorId: 'actor-1' })).toBe(false);
    expect(isInteractCommand({ ...validInteractCommand, extra: 1 })).toBe(false);
  });

  it('rejects a bad type discriminant', () => {
    expect(isInteractCommand({ type: 'actor.talk', targetEntityId: 'entity-1' })).toBe(false);
    expect(isInteractCommand({ type: 'actor.moveTo', targetEntityId: 'entity-1' })).toBe(false);
    expect(isInteractCommand({ type: true, targetEntityId: 'entity-1' })).toBe(false);
  });

  it('rejects a non-string / empty targetEntityId', () => {
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: '' })).toBe(false);
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: 42 })).toBe(false);
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: null })).toBe(false);
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: undefined })).toBe(false);
    expect(isInteractCommand({ type: 'actor.interact', targetEntityId: { id: 'entity-1' } })).toBe(
      false,
    );
  });
});

describe('parseInteractCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseInteractCommand(validInteractCommand)).toBe(validInteractCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() =>
      parseInteractCommand({ type: 'actor.interact', targetEntityId: '' }),
    );
    expect(error.message).toBe('Invalid InteractCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

/**
 * BOUNDARY test for the phase-8 frozen design, section C: the server must never
 * receive presentation data. Click-to-move and interaction are expressed only as
 * world-space gameplay intents; any screen/NDC/camera/ray/pointer field is
 * rejected because every command guard matches keys exactly. This is what keeps
 * screen coordinates, camera matrices, and ray/plane parameters off the wire.
 */
const presentationFields = ['camera', 'ndc', 'screen', 'pointer', 'ray', 'matrix'] as const;

describe('presentation-field boundary (no screen/camera/ray data on the wire)', () => {
  it.each(presentationFields)('rejects `moveIntent` carrying %s', (field) => {
    const body = { ...validMoveIntentCommand, [field]: { x: 0.5, y: 0.5 } };
    expect(isMoveIntentCommand(body)).toBe(false);
    expect(isGameCommand(body)).toBe(false);
    expect(captureParseError(() => parseGameCommand(body)).code).toBe('BAD_REQUEST');
  });

  it.each(presentationFields)('rejects `moveTo` carrying %s', (field) => {
    const body = { ...validMoveToCommand, [field]: { x: 0.5, y: 0.5 } };
    expect(isMoveToCommand(body)).toBe(false);
    expect(isGameCommand(body)).toBe(false);
    expect(captureParseError(() => parseGameCommand(body)).code).toBe('BAD_REQUEST');
  });

  it.each(presentationFields)('rejects `interact` carrying %s', (field) => {
    const body = { ...validInteractCommand, [field]: { x: 0.5, y: 0.5 } };
    expect(isInteractCommand(body)).toBe(false);
    expect(isGameCommand(body)).toBe(false);
    expect(captureParseError(() => parseGameCommand(body)).code).toBe('BAD_REQUEST');
  });
});

describe('isGameCommand', () => {
  it('accepts every known command', () => {
    expect(isGameCommand(validMoveIntentCommand)).toBe(true);
    expect(isGameCommand(validMoveToCommand)).toBe(true);
    expect(isGameCommand(validInteractCommand)).toBe(true);
    expect(isGameCommand(validActorJumpCommand)).toBe(true);
    expect(isGameCommand(validBlockSetCommand)).toBe(true);
    expect(isGameCommand(validBlockRemoveCommand)).toBe(true);
    expect(isGameCommand(validEntityPlaceCommand)).toBe(true);
    expect(isGameCommand(validEntityRotateCommand)).toBe(true);
    expect(isGameCommand(validEntityRemoveCommand)).toBe(true);
    expect(isGameCommand(validEntityValidatePlacementCommand)).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGameCommand(value)).toBe(false);
  });

  it('rejects an unknown type discriminant, including the deleted `actor.move`', () => {
    expect(isGameCommand({ type: 'actor.dance' })).toBe(false);
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
  it('parses each discriminated-union member without a cast', () => {
    const intent: unknown = { type: 'actor.moveIntent', movement: { x: -1, z: 0 } };
    const parsedIntent: GameCommand = parseGameCommand(intent);
    if (parsedIntent.type === 'actor.moveIntent') {
      const movement: { x: number; z: number } = parsedIntent.movement;
      expect(movement).toEqual({ x: -1, z: 0 });
    } else {
      throw new Error('unreachable: expected actor.moveIntent');
    }

    const goal: unknown = { type: 'actor.moveTo', target: { x: 1, y: 2, z: 3 } };
    const parsedGoal: GameCommand = parseGameCommand(goal);
    if (parsedGoal.type === 'actor.moveTo') {
      const target: { x: number; y: number; z: number } = parsedGoal.target;
      expect(target).toEqual({ x: 1, y: 2, z: 3 });
    } else {
      throw new Error('unreachable: expected actor.moveTo');
    }

    const interact: unknown = { type: 'actor.interact', targetEntityId: 'entity-9' };
    const parsedInteract: GameCommand = parseGameCommand(interact);
    if (parsedInteract.type === 'actor.interact') {
      const targetEntityId: string = parsedInteract.targetEntityId;
      expect(targetEntityId).toBe('entity-9');
    } else {
      throw new Error('unreachable: expected actor.interact');
    }
  });

  it('throws ProtocolParseError for an unknown type discriminant', () => {
    const error = captureParseError(() => parseGameCommand({ type: 'actor.dance' }));
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

describe('isActorJumpCommand', () => {
  it('accepts the payload-free jump', () => {
    expect(isActorJumpCommand(validActorJumpCommand)).toBe(true);
    expect(isActorJumpCommand({ type: 'actor.jump' })).toBe(true);
  });

  it('rejects any payload (height/velocity are Manager rules)', () => {
    expect(isActorJumpCommand({ type: 'actor.jump', height: 2 })).toBe(false);
    expect(isActorJumpCommand({ type: 'actor.jump', velocity: { x: 0, y: 5, z: 0 } })).toBe(false);
    expect(isActorJumpCommand({ type: 'actor.jump', actorId: 'actor-1' })).toBe(false);
    expect(isActorJumpCommand({ type: 'actor.jump', extra: 1 })).toBe(false);
  });

  it('rejects a wrong discriminant and non-objects', () => {
    expect(isActorJumpCommand({ type: 'actor.jump ' })).toBe(false);
    expect(isActorJumpCommand(null)).toBe(false);
  });
});

describe('parseActorJumpCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseActorJumpCommand(validActorJumpCommand)).toBe(validActorJumpCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseActorJumpCommand({ type: 'actor.jump', height: 2 }));
    expect(error.message).toBe('Invalid ActorJumpCommand payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isBlockSetCommand', () => {
  it('accepts a well-formed block set', () => {
    expect(isBlockSetCommand(validBlockSetCommand)).toBe(true);
    // `air` is a legal command kind meaning "remove".
    expect(isBlockSetCommand({ ...validBlockSetCommand, kind: 'air' })).toBe(true);
    expect(isBlockSetCommand({ ...validBlockSetCommand, orientation: 270 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isBlockSetCommand(value)).toBe(false);
  });

  it.each(['type', 'coord', 'kind', 'orientation'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validBlockSetCommand };
    delete value[key];
    expect(isBlockSetCommand(value)).toBe(false);
  });

  it('rejects a 2D coord, a bad kind/orientation, and a client-named actor', () => {
    expect(isBlockSetCommand({ ...validBlockSetCommand, coord: { x: 1, z: 2 } })).toBe(false);
    expect(isBlockSetCommand({ ...validBlockSetCommand, kind: 'lava' })).toBe(false);
    expect(isBlockSetCommand({ ...validBlockSetCommand, orientation: 45 })).toBe(false);
    expect(isBlockSetCommand({ ...validBlockSetCommand, actorId: 'actor-1' })).toBe(false);
    expect(isBlockSetCommand({ ...validBlockSetCommand, extra: 1 })).toBe(false);
  });
});

describe('parseBlockSetCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockSetCommand(validBlockSetCommand)).toBe(validBlockSetCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    expect(captureParseError(() => parseBlockSetCommand({ type: 'block.set' })).message).toBe(
      'Invalid BlockSetCommand payload',
    );
  });
});

describe('isBlockRemoveCommand', () => {
  it('accepts a well-formed block remove', () => {
    expect(isBlockRemoveCommand(validBlockRemoveCommand)).toBe(true);
  });

  it('rejects missing/extra keys, a 2D coord, and a client-named actor', () => {
    const missing: Record<string, unknown> = { ...validBlockRemoveCommand };
    delete missing.coord;
    expect(isBlockRemoveCommand(missing)).toBe(false);
    expect(isBlockRemoveCommand({ ...validBlockRemoveCommand, kind: 'grass' })).toBe(false);
    expect(isBlockRemoveCommand({ ...validBlockRemoveCommand, coord: { x: 1, z: 2 } })).toBe(false);
    expect(isBlockRemoveCommand({ ...validBlockRemoveCommand, actorId: 'actor-1' })).toBe(false);
  });
});

describe('parseBlockRemoveCommand', () => {
  it('throws ProtocolParseError when invalid', () => {
    expect(captureParseError(() => parseBlockRemoveCommand(null)).message).toBe(
      'Invalid BlockRemoveCommand payload',
    );
  });
});

describe('isEntityPlaceCommand', () => {
  it('accepts a well-formed place request', () => {
    expect(isEntityPlaceCommand(validEntityPlaceCommand)).toBe(true);
    expect(isEntityPlaceCommand({ ...validEntityPlaceCommand, yawDegrees: 37.5 })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isEntityPlaceCommand(value)).toBe(false);
  });

  it.each(['type', 'kind', 'position', 'yawDegrees'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validEntityPlaceCommand };
    delete value[key];
    expect(isEntityPlaceCommand(value)).toBe(false);
  });

  it('rejects a bad kind, a 2D position, a non-finite yaw, and a client-named actor', () => {
    expect(isEntityPlaceCommand({ ...validEntityPlaceCommand, kind: 'npc' })).toBe(false);
    expect(isEntityPlaceCommand({ ...validEntityPlaceCommand, position: { x: 1, z: 2 } })).toBe(
      false,
    );
    expect(
      isEntityPlaceCommand({ ...validEntityPlaceCommand, yawDegrees: Number.NaN }),
    ).toBe(false);
    expect(
      isEntityPlaceCommand({ ...validEntityPlaceCommand, yawDegrees: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(isEntityPlaceCommand({ ...validEntityPlaceCommand, actorId: 'actor-1' })).toBe(false);
  });
});

describe('parseEntityPlaceCommand', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseEntityPlaceCommand(validEntityPlaceCommand)).toBe(validEntityPlaceCommand);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    expect(
      captureParseError(() => parseEntityPlaceCommand({ type: 'entity.place' })).message,
    ).toBe('Invalid EntityPlaceCommand payload');
  });
});

describe('isEntityRotateCommand', () => {
  it('accepts a well-formed rotate request', () => {
    expect(isEntityRotateCommand(validEntityRotateCommand)).toBe(true);
    expect(isEntityRotateCommand({ ...validEntityRotateCommand, yawDegrees: -90 })).toBe(true);
  });

  it('rejects missing keys, a bad entityId, a non-finite yaw, and extras', () => {
    expect(isEntityRotateCommand({ type: 'entity.rotate', yawDegrees: 90 })).toBe(false);
    expect(isEntityRotateCommand({ ...validEntityRotateCommand, entityId: '' })).toBe(false);
    expect(isEntityRotateCommand({ ...validEntityRotateCommand, entityId: 1 })).toBe(false);
    expect(
      isEntityRotateCommand({ ...validEntityRotateCommand, yawDegrees: Number.NaN }),
    ).toBe(false);
    expect(isEntityRotateCommand({ ...validEntityRotateCommand, actorId: 'actor-1' })).toBe(false);
    expect(isEntityRotateCommand({ ...validEntityRotateCommand, extra: 1 })).toBe(false);
  });
});

describe('parseEntityRotateCommand', () => {
  it('throws ProtocolParseError when invalid', () => {
    expect(captureParseError(() => parseEntityRotateCommand({ type: 'entity.rotate' })).message).toBe(
      'Invalid EntityRotateCommand payload',
    );
  });
});

describe('isEntityRemoveCommand', () => {
  it('accepts a well-formed remove request', () => {
    expect(isEntityRemoveCommand(validEntityRemoveCommand)).toBe(true);
  });

  it('rejects missing keys, a bad entityId, and extras', () => {
    expect(isEntityRemoveCommand({ type: 'entity.remove' })).toBe(false);
    expect(isEntityRemoveCommand({ ...validEntityRemoveCommand, entityId: '' })).toBe(false);
    expect(isEntityRemoveCommand({ ...validEntityRemoveCommand, actorId: 'actor-1' })).toBe(false);
    expect(isEntityRemoveCommand({ ...validEntityRemoveCommand, extra: 1 })).toBe(false);
  });
});

describe('parseEntityRemoveCommand', () => {
  it('throws ProtocolParseError when invalid', () => {
    expect(captureParseError(() => parseEntityRemoveCommand(null)).message).toBe(
      'Invalid EntityRemoveCommand payload',
    );
  });
});

describe('isEntityValidatePlacementCommand', () => {
  it('accepts a well-formed validate request', () => {
    expect(isEntityValidatePlacementCommand(validEntityValidatePlacementCommand)).toBe(true);
  });

  it.each(['type', 'kind', 'position', 'yawDegrees'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validEntityValidatePlacementCommand };
    delete value[key];
    expect(isEntityValidatePlacementCommand(value)).toBe(false);
  });

  it('rejects a 2D position, a bad kind, and extras', () => {
    expect(
      isEntityValidatePlacementCommand({
        ...validEntityValidatePlacementCommand,
        position: { x: 1, z: 2 },
      }),
    ).toBe(false);
    expect(
      isEntityValidatePlacementCommand({ ...validEntityValidatePlacementCommand, kind: 'npc' }),
    ).toBe(false);
    expect(
      isEntityValidatePlacementCommand({
        ...validEntityValidatePlacementCommand,
        actorId: 'actor-1',
      }),
    ).toBe(false);
  });
});

describe('parseEntityValidatePlacementCommand', () => {
  it('throws ProtocolParseError when invalid', () => {
    expect(
      captureParseError(() => parseEntityValidatePlacementCommand(null)).message,
    ).toBe('Invalid EntityValidatePlacementCommand payload');
  });
});

describe('isValidatePlacementResponse', () => {
  it('accepts a valid result (non-null resolved transform, null reason)', () => {
    expect(isValidatePlacementResponse(validValidatePlacementResponse)).toBe(true);
    expect(
      isValidatePlacementResponse({ ...validValidatePlacementResponse, occupiedCells: [] }),
    ).toBe(true);
  });

  it('accepts an invalid result (non-empty reason, null resolved transform)', () => {
    expect(
      isValidatePlacementResponse({
        valid: false,
        reason: 'occupied',
        occupiedCells: [{ x: 2, y: 0, z: 3 }],
        resolvedTransform: null,
      }),
    ).toBe(true);
  });

  it('rejects a reason/transform inconsistent with `valid`', () => {
    expect(
      isValidatePlacementResponse({ ...validValidatePlacementResponse, reason: 'nope' }),
    ).toBe(false);
    expect(
      isValidatePlacementResponse({ ...validValidatePlacementResponse, resolvedTransform: null }),
    ).toBe(false);
    expect(
      isValidatePlacementResponse({ valid: false, reason: null, occupiedCells: [], resolvedTransform: null }),
    ).toBe(false);
    expect(
      isValidatePlacementResponse({ valid: false, reason: '', occupiedCells: [], resolvedTransform: null }),
    ).toBe(false);
  });

  it('requires present-and-nullable reason/resolvedTransform (no optional-key special case)', () => {
    const noReason: Record<string, unknown> = { ...validValidatePlacementResponse };
    delete noReason.reason;
    expect(isValidatePlacementResponse(noReason)).toBe(false);
    const noTransform: Record<string, unknown> = { ...validValidatePlacementResponse };
    delete noTransform.resolvedTransform;
    expect(isValidatePlacementResponse(noTransform)).toBe(false);
  });

  it('rejects a malformed occupiedCells list or extra keys', () => {
    expect(isValidatePlacementResponse({ ...validValidatePlacementResponse, occupiedCells: null })).toBe(
      false,
    );
    expect(
      isValidatePlacementResponse({
        ...validValidatePlacementResponse,
        occupiedCells: [{ x: 1, z: 2 }],
      }),
    ).toBe(false);
    expect(isValidatePlacementResponse({ ...validValidatePlacementResponse, extra: 1 })).toBe(false);
  });
});

describe('parseValidatePlacementResponse', () => {
  it('returns the value unchanged when valid', () => {
    const parsed: ValidatePlacementResponse = parseValidatePlacementResponse(
      validValidatePlacementResponse,
    );
    expect(parsed).toBe(validValidatePlacementResponse);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    expect(captureParseError(() => parseValidatePlacementResponse({})).message).toBe(
      'Invalid ValidatePlacementResponse payload',
    );
  });
});

describe('isCommandResponse / parseCommandResponse', () => {
  it('accepts both disjoint success bodies', () => {
    expect(isCommandResponse(validGameEventBatch)).toBe(true);
    expect(isCommandResponse(validValidatePlacementResponse)).toBe(true);
    expect(isCommandResponse({ events: [], serverTime: '2025-01-02T03:04:05.000Z' })).toBe(true);
  });

  it('rejects a malformed envelope or a hybrid', () => {
    expect(isCommandResponse(null)).toBe(false);
    expect(isCommandResponse({})).toBe(false);
    expect(isCommandResponse({ ...validGameEventBatch, valid: true })).toBe(false);
    expect(
      isCommandResponse({ ...validValidatePlacementResponse, events: [] }),
    ).toBe(false);
  });

  it('parse returns the narrowed response unchanged', () => {
    const parsed: CommandResponse = parseCommandResponse(validValidatePlacementResponse);
    expect(parsed).toBe(validValidatePlacementResponse);
  });

  it('throws ProtocolParseError when invalid', () => {
    expect(captureParseError(() => parseCommandResponse({})).message).toBe(
      'Invalid CommandResponse payload',
    );
  });
});

/**
 * Type-level exactness guard: `GameCommand` must stay exactly the listed
 * members. The literal tuple and the `Exact` comparison fail `tsc` if a member
 * is added or removed, so the command vocabulary is enforced by the compiler,
 * not just asserted in prose.
 */
const gameCommandTypes = [
  'actor.moveIntent',
  'actor.moveTo',
  'actor.interact',
  'actor.jump',
  'block.set',
  'block.remove',
  'entity.place',
  'entity.rotate',
  'entity.remove',
  'entity.validatePlacement',
] as const;
type ListedGameCommandType = (typeof gameCommandTypes)[number];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Exported so `noUnusedLocals` cannot swallow the compile-time exactness proof. */
export const gameCommandTypesAreExact: Exact<GameCommand['type'], ListedGameCommandType> = true;

/** Keep each union member referenced so it is not a swallowed local. */
export const moveIntentCommandType: MoveIntentCommand['type'] = 'actor.moveIntent';
export const moveToCommandType: MoveToCommand['type'] = 'actor.moveTo';
export const interactCommandType: InteractCommand['type'] = 'actor.interact';
export const actorJumpCommandType: ActorJumpCommand['type'] = 'actor.jump';
export const blockSetCommandType: BlockSetCommand['type'] = 'block.set';
export const blockRemoveCommandType: BlockRemoveCommand['type'] = 'block.remove';
export const entityPlaceCommandType: EntityPlaceCommand['type'] = 'entity.place';
export const entityRotateCommandType: EntityRotateCommand['type'] = 'entity.rotate';
export const entityRemoveCommandType: EntityRemoveCommand['type'] = 'entity.remove';
export const entityValidatePlacementCommandType: EntityValidatePlacementCommand['type'] =
  'entity.validatePlacement';

describe('GameCommand exact shape', () => {
  it('is exactly ten members and has no catch-all', () => {
    expect(gameCommandTypesAreExact).toBe(true);
    expect(gameCommandTypes).toHaveLength(10);
    expect([...gameCommandTypes].sort()).toEqual([
      'actor.interact',
      'actor.jump',
      'actor.moveIntent',
      'actor.moveTo',
      'block.remove',
      'block.set',
      'entity.place',
      'entity.remove',
      'entity.rotate',
      'entity.validatePlacement',
    ]);
    expect(moveIntentCommandType).toBe('actor.moveIntent');
    expect(moveToCommandType).toBe('actor.moveTo');
    expect(interactCommandType).toBe('actor.interact');
    expect(actorJumpCommandType).toBe('actor.jump');
    expect(blockSetCommandType).toBe('block.set');
    expect(blockRemoveCommandType).toBe('block.remove');
    expect(entityPlaceCommandType).toBe('entity.place');
    expect(entityRotateCommandType).toBe('entity.rotate');
    expect(entityRemoveCommandType).toBe('entity.remove');
    expect(entityValidatePlacementCommandType).toBe('entity.validatePlacement');
  });
});

/**
 * `parseGameCommand` must narrow each new member without a cast, and every
 * command must keep the "identity comes from transport context" invariant.
 */
describe('parseGameCommand new members', () => {
  it('parses block/placement/jump members into the discriminated union', () => {
    const block: GameCommand = parseGameCommand(validBlockSetCommand);
    if (block.type === 'block.set') {
      const coord: { x: number; y: number; z: number } = block.coord;
      expect(coord).toEqual({ x: 2, y: 0, z: 3 });
    } else {
      throw new Error('unreachable: expected block.set');
    }

    const place: GameCommand = parseGameCommand(validEntityPlaceCommand);
    if (place.type === 'entity.place') {
      const position: { x: number; y: number; z: number } = place.position;
      expect(position).toEqual({ x: 2.5, y: 0, z: 3.5 });
    } else {
      throw new Error('unreachable: expected entity.place');
    }

    const validate: GameCommand = parseGameCommand(validEntityValidatePlacementCommand);
    if (validate.type === 'entity.validatePlacement') {
      expect(validate.kind).toBe('chest');
    } else {
      throw new Error('unreachable: expected entity.validatePlacement');
    }

    const jump: GameCommand = parseGameCommand(validActorJumpCommand);
    expect(jump.type).toBe('actor.jump');
  });

  it('rejects a client-named actor on every command (identity is from transport)', () => {
    const commands: Array<Record<string, unknown>> = [
      { ...validBlockSetCommand, actorId: 'actor-1' },
      { ...validBlockRemoveCommand, actorId: 'actor-1' },
      { ...validEntityPlaceCommand, actorId: 'actor-1' },
      { ...validEntityRotateCommand, playerId: 'player-1' },
      { ...validEntityRemoveCommand, actorId: 'actor-1' },
      { ...validEntityValidatePlacementCommand, actorId: 'actor-1' },
      { ...validActorJumpCommand, actorId: 'actor-1' },
    ];
    for (const command of commands) {
      expect(isGameCommand(command)).toBe(false);
      expect(captureParseError(() => parseGameCommand(command)).code).toBe('BAD_REQUEST');
    }
  });
});
