import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isFiniteInteger, isIsoUtcString, isRecord } from './internal.ts';

/** Server identity and compatibility information. */
export interface GameInfo {
  gameName: string;
  serverVersion: string;
  protocolVersion: number;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `GAME_INFO_PATH`. */
export interface GetGameInfoResponse {
  gameInfo: GameInfo;
}

const GAME_INFO_KEYS = ['gameName', 'serverVersion', 'protocolVersion', 'serverTime'] as const;
const GET_GAME_INFO_RESPONSE_KEYS = ['gameInfo'] as const;

/**
 * Structural guard for `GameInfo`.
 *
 * Requires a plain object with exactly the four contract fields. `protocolVersion`
 * must be a finite integer; it is intentionally NOT compared against the current
 * `PROTOCOL_VERSION` so callers can inspect and negotiate versions themselves.
 */
export function isGameInfo(value: unknown): value is GameInfo {
  if (!isRecord(value) || !hasExactKeys(value, GAME_INFO_KEYS)) {
    return false;
  }
  return (
    typeof value.gameName === 'string' &&
    typeof value.serverVersion === 'string' &&
    isFiniteInteger(value.protocolVersion) &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `GameInfo`, throwing `ProtocolParseError` on mismatch. */
export function parseGameInfo(value: unknown): GameInfo {
  if (!isGameInfo(value)) {
    throw new ProtocolParseError('Invalid GameInfo payload');
  }
  return value;
}

/** Structural guard for `GetGameInfoResponse`. */
export function isGetGameInfoResponse(value: unknown): value is GetGameInfoResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, GET_GAME_INFO_RESPONSE_KEYS) &&
    isGameInfo(value.gameInfo)
  );
}

/** Parse and validate `GetGameInfoResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseGetGameInfoResponse(value: unknown): GetGameInfoResponse {
  if (!isGetGameInfoResponse(value)) {
    throw new ProtocolParseError('Invalid GetGameInfoResponse payload');
  }
  return value;
}
