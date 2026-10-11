import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isIsoUtcString, isRecord } from './internal.ts';
import { isActor } from './world.ts';
import type { Actor } from './world.ts';

/**
 * Cardinal movement direction.
 *
 * Semantics: `north` = y-1, `south` = y+1, `east` = x+1, `west` = x-1.
 */
export type MoveDirection = 'north' | 'south' | 'east' | 'west';

/**
 * Request body for `MOVE_ACTOR_PATH`.
 *
 * Deliberately carries **no actor field**: a client may not name the actor it
 * acts as. The actor is resolved by Router from transport context and passed to
 * Manager out of band. An extra `actorId` field is rejected by the guard.
 */
export interface MoveActorCommand {
  direction: MoveDirection;
}

/** Outcome of a move attempt. */
export interface MoveActorResult {
  actor: Actor;
  /**
   * `false` when the step was blocked (for example a world edge). The returned
   * `actor.position` is then the unchanged authoritative position.
   */
  moved: boolean;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `MOVE_ACTOR_PATH`. */
export interface MoveActorResponse {
  result: MoveActorResult;
}

const MOVE_ACTOR_COMMAND_KEYS = ['direction'] as const;
const MOVE_ACTOR_RESULT_KEYS = ['actor', 'moved', 'serverTime'] as const;
const MOVE_ACTOR_RESPONSE_KEYS = ['result'] as const;

/** Structural guard for `MoveDirection`. */
export function isMoveDirection(value: unknown): value is MoveDirection {
  return value === 'north' || value === 'south' || value === 'east' || value === 'west';
}

/** Parse and validate `MoveDirection`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveDirection(value: unknown): MoveDirection {
  if (!isMoveDirection(value)) {
    throw new ProtocolParseError('Invalid MoveDirection payload');
  }
  return value;
}

/** Structural guard for `MoveActorCommand` (exactly `{ direction }`). */
export function isMoveActorCommand(value: unknown): value is MoveActorCommand {
  if (!isRecord(value) || !hasExactKeys(value, MOVE_ACTOR_COMMAND_KEYS)) {
    return false;
  }
  return isMoveDirection(value.direction);
}

/** Parse and validate `MoveActorCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveActorCommand(value: unknown): MoveActorCommand {
  if (!isMoveActorCommand(value)) {
    throw new ProtocolParseError('Invalid MoveActorCommand payload');
  }
  return value;
}

/** Structural guard for `MoveActorResult`. */
export function isMoveActorResult(value: unknown): value is MoveActorResult {
  if (!isRecord(value) || !hasExactKeys(value, MOVE_ACTOR_RESULT_KEYS)) {
    return false;
  }
  return (
    isActor(value.actor) &&
    typeof value.moved === 'boolean' &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `MoveActorResult`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveActorResult(value: unknown): MoveActorResult {
  if (!isMoveActorResult(value)) {
    throw new ProtocolParseError('Invalid MoveActorResult payload');
  }
  return value;
}

/** Structural guard for `MoveActorResponse` (exactly `{ result }`). */
export function isMoveActorResponse(value: unknown): value is MoveActorResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, MOVE_ACTOR_RESPONSE_KEYS) &&
    isMoveActorResult(value.result)
  );
}

/** Parse and validate `MoveActorResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveActorResponse(value: unknown): MoveActorResponse {
  if (!isMoveActorResponse(value)) {
    throw new ProtocolParseError('Invalid MoveActorResponse payload');
  }
  return value;
}
