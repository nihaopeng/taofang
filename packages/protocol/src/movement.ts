import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isIsoUtcString, isNonEmptyString, isRecord } from './internal.ts';
import { isPlayer } from './world.ts';
import type { Player, PlayerId } from './world.ts';

/**
 * Cardinal movement direction.
 *
 * Semantics: `north` = y-1, `south` = y+1, `east` = x+1, `west` = x-1.
 */
export type MoveDirection = 'north' | 'south' | 'east' | 'west';

/** Request body for `PLAYER_MOVE_PATH`. */
export interface MovePlayerCommand {
  playerId: PlayerId;
  direction: MoveDirection;
}

/** Outcome of a move attempt. */
export interface MovePlayerResult {
  player: Player;
  /**
   * `false` when the step was blocked (for example a world edge). The returned
   * `player.position` is then the unchanged authoritative position.
   */
  moved: boolean;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `PLAYER_MOVE_PATH`. */
export interface MovePlayerResponse {
  result: MovePlayerResult;
}

const MOVE_PLAYER_COMMAND_KEYS = ['playerId', 'direction'] as const;
const MOVE_PLAYER_RESULT_KEYS = ['player', 'moved', 'serverTime'] as const;
const MOVE_PLAYER_RESPONSE_KEYS = ['result'] as const;

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

/** Structural guard for `MovePlayerCommand`. */
export function isMovePlayerCommand(value: unknown): value is MovePlayerCommand {
  if (!isRecord(value) || !hasExactKeys(value, MOVE_PLAYER_COMMAND_KEYS)) {
    return false;
  }
  return isNonEmptyString(value.playerId) && isMoveDirection(value.direction);
}

/** Parse and validate `MovePlayerCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseMovePlayerCommand(value: unknown): MovePlayerCommand {
  if (!isMovePlayerCommand(value)) {
    throw new ProtocolParseError('Invalid MovePlayerCommand payload');
  }
  return value;
}

/** Structural guard for `MovePlayerResult`. */
export function isMovePlayerResult(value: unknown): value is MovePlayerResult {
  if (!isRecord(value) || !hasExactKeys(value, MOVE_PLAYER_RESULT_KEYS)) {
    return false;
  }
  return (
    isPlayer(value.player) &&
    typeof value.moved === 'boolean' &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `MovePlayerResult`, throwing `ProtocolParseError` on mismatch. */
export function parseMovePlayerResult(value: unknown): MovePlayerResult {
  if (!isMovePlayerResult(value)) {
    throw new ProtocolParseError('Invalid MovePlayerResult payload');
  }
  return value;
}

/** Structural guard for `MovePlayerResponse` (exactly `{ result }`). */
export function isMovePlayerResponse(value: unknown): value is MovePlayerResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, MOVE_PLAYER_RESPONSE_KEYS) &&
    isMovePlayerResult(value.result)
  );
}

/** Parse and validate `MovePlayerResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseMovePlayerResponse(value: unknown): MovePlayerResponse {
  if (!isMovePlayerResponse(value)) {
    throw new ProtocolParseError('Invalid MovePlayerResponse payload');
  }
  return value;
}
