import { ProtocolParseError } from './errors.ts';
import { isMoveDirection } from './direction.ts';
import type { MoveDirection } from './direction.ts';
import { isGameEvent } from './event.ts';
import type { GameEvent } from './event.ts';
import { hasExactKeys, isIsoUtcString, isRecord } from './internal.ts';

/**
 * Request body for `COMMAND_PATH`.
 *
 * Deliberately carries **no actor field**: a client may not name the actor it
 * acts as. The actor is resolved by Router from transport context and passed to
 * Manager out of band. An extra `actorId`/`playerId` field is rejected.
 */
export interface ActorMoveCommand {
  type: 'actor.move';
  direction: MoveDirection;
}

/**
 * Discriminated union of client -> server commands, dispatched on `type`.
 *
 * There is deliberately no `action: string` + `args: unknown` catch-all: every
 * command is its own strongly-typed interface, so callers (and executors) narrow
 * on `type` and never need a cast.
 */
export type GameCommand = ActorMoveCommand;

/**
 * Response body for `COMMAND_PATH`.
 *
 * `events` is the authoritative delta produced by the command. A refused command
 * is expressed as an **empty** array — there is no `moved` boolean.
 */
export interface SubmitCommandResponse {
  events: GameEvent[];
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

const ACTOR_MOVE_COMMAND_KEYS = ['type', 'direction'] as const;
const SUBMIT_COMMAND_RESPONSE_KEYS = ['events', 'serverTime'] as const;

/** Structural guard for `ActorMoveCommand` (exactly `{ type: 'actor.move', direction }`). */
export function isActorMoveCommand(value: unknown): value is ActorMoveCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, ACTOR_MOVE_COMMAND_KEYS) &&
    value.type === 'actor.move' &&
    isMoveDirection(value.direction)
  );
}

/** Parse and validate `ActorMoveCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseActorMoveCommand(value: unknown): ActorMoveCommand {
  if (!isActorMoveCommand(value)) {
    throw new ProtocolParseError('Invalid ActorMoveCommand payload');
  }
  return value;
}

/**
 * Structural guard for `GameCommand`.
 *
 * Dispatches on the `type` discriminant. An unknown `type` (or any malformed
 * payload) is rejected; there is no catch-all command shape.
 */
export function isGameCommand(value: unknown): value is GameCommand {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'actor.move':
      return isActorMoveCommand(value);
    default:
      return false;
  }
}

/**
 * Parse and validate `GameCommand`, throwing `ProtocolParseError` on mismatch.
 *
 * Dispatches on the `type` discriminant so callers receive the narrowed union
 * member without a cast. An unknown `type` throws.
 */
export function parseGameCommand(value: unknown): GameCommand {
  if (isRecord(value)) {
    switch (value.type) {
      case 'actor.move':
        return parseActorMoveCommand(value);
      default:
        break;
    }
  }
  throw new ProtocolParseError('Invalid GameCommand payload');
}

/** Structural guard for `SubmitCommandResponse` (exactly `{ events, serverTime }`). */
export function isSubmitCommandResponse(value: unknown): value is SubmitCommandResponse {
  if (!isRecord(value) || !hasExactKeys(value, SUBMIT_COMMAND_RESPONSE_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.events)) {
    return false;
  }
  return value.events.every((event) => isGameEvent(event)) && isIsoUtcString(value.serverTime);
}

/** Parse and validate `SubmitCommandResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseSubmitCommandResponse(value: unknown): SubmitCommandResponse {
  if (!isSubmitCommandResponse(value)) {
    throw new ProtocolParseError('Invalid SubmitCommandResponse payload');
  }
  return value;
}
