import { isBlockKind, isBlockOrientation } from './block.ts';
import type { BlockKind, BlockOrientation } from './block.ts';
import { isEntityKind } from './entity.ts';
import type { EntityKind } from './entity.ts';
import { ProtocolParseError } from './errors.ts';
import {
  hasExactKeys,
  isFiniteInteger,
  isIsoUtcString,
  isPositiveFiniteInteger,
  isPositiveFiniteNumber,
  isRecord,
} from './internal.ts';

/** Server identity and compatibility information. */
export interface GameInfo {
  gameName: string;
  serverVersion: string;
  protocolVersion: number;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/**
 * Declarative, PRESENTATION-only data for one block kind.
 *
 * Decision (Main-owned): the client must be able to draw a placement ghost and
 * must not keep a second source of truth, so the static
 * `GET /api/game-info` payload carries these catalogues. An entry carries its
 * kind id and, at most, whether the kind supports a non-default orientation.
 * It carries **no** collision shape, **no** support/occupancy/permission rule,
 * and **no** appearance/material/asset data.
 */
export interface BlockKindInfo {
  kind: BlockKind;
  /** Whether a non-default `BlockOrientation` is meaningful for this kind. */
  orientable: boolean;
}

/**
 * Declarative, PRESENTATION-only placement geometry for one entity kind. Pure
 * geometry, sufficient for a client to draw a pending placement ghost:
 * footprint extents, height, the set of allowed yaw steps, and the pivot
 * policy.
 *
 * It carries **no** collision shape, **no** support/occupancy/permission rule,
 * and **no** appearance/material/asset data. Whether a given placement is legal
 * remains a server-only Manager judgement (`entity.validatePlacement`).
 */
export interface EntityKindInfo {
  kind: EntityKind;
  /** Footprint extent along `+X`, in whole cells. Strictly positive integer. */
  footprintX: number;
  /** Footprint extent along `+Z`, in whole cells. Strictly positive integer. */
  footprintZ: number;
  /** Vertical extent in world units. Strictly positive; may be fractional. */
  height: number;
  /** The yaw steps (degrees) this kind may be rotated to. Non-empty. */
  allowedYawSteps: BlockOrientation[];
  /** Placement pivot policy. v1 is always `'center'` (footprint's geometric centre). */
  pivot: 'center';
}

/** Response body for `GAME_INFO_PATH` (includes the static presentation catalogues). */
export interface GetGameInfoResponse {
  gameInfo: GameInfo;
  blockKinds: BlockKindInfo[];
  entityKinds: EntityKindInfo[];
}

const GAME_INFO_KEYS = ['gameName', 'serverVersion', 'protocolVersion', 'serverTime'] as const;
const BLOCK_KIND_INFO_KEYS = ['kind', 'orientable'] as const;
const ENTITY_KIND_INFO_KEYS = [
  'kind',
  'footprintX',
  'footprintZ',
  'height',
  'allowedYawSteps',
  'pivot',
] as const;
const GET_GAME_INFO_RESPONSE_KEYS = ['gameInfo', 'blockKinds', 'entityKinds'] as const;

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

/** Structural guard for `BlockKindInfo` (exactly `{ kind, orientable }`). */
export function isBlockKindInfo(value: unknown): value is BlockKindInfo {
  if (!isRecord(value) || !hasExactKeys(value, BLOCK_KIND_INFO_KEYS)) {
    return false;
  }
  return isBlockKind(value.kind) && typeof value.orientable === 'boolean';
}

/** Parse and validate `BlockKindInfo`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockKindInfo(value: unknown): BlockKindInfo {
  if (!isBlockKindInfo(value)) {
    throw new ProtocolParseError('Invalid BlockKindInfo payload');
  }
  return value;
}

/**
 * Structural guard for `EntityKindInfo` (exactly the six declared keys).
 * Footprint extents are strictly positive integers; `height` is strictly
 * positive; `allowedYawSteps` is a NON-EMPTY array of `YawStep`s; `pivot` is
 * `'center'`. Unknown extra keys (including any appearance/material/collision
 * field) are rejected.
 */
export function isEntityKindInfo(value: unknown): value is EntityKindInfo {
  if (!isRecord(value) || !hasExactKeys(value, ENTITY_KIND_INFO_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.allowedYawSteps) || value.allowedYawSteps.length === 0) {
    return false;
  }
  return (
    isEntityKind(value.kind) &&
    isPositiveFiniteInteger(value.footprintX) &&
    isPositiveFiniteInteger(value.footprintZ) &&
    isPositiveFiniteNumber(value.height) &&
    value.allowedYawSteps.every((step) => isBlockOrientation(step)) &&
    value.pivot === 'center'
  );
}

/** Parse and validate `EntityKindInfo`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityKindInfo(value: unknown): EntityKindInfo {
  if (!isEntityKindInfo(value)) {
    throw new ProtocolParseError('Invalid EntityKindInfo payload');
  }
  return value;
}

/** Structural guard for `GetGameInfoResponse` (exactly `{ gameInfo, blockKinds, entityKinds }`). */
export function isGetGameInfoResponse(value: unknown): value is GetGameInfoResponse {
  if (!isRecord(value) || !hasExactKeys(value, GET_GAME_INFO_RESPONSE_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.blockKinds) || !Array.isArray(value.entityKinds)) {
    return false;
  }
  return (
    isGameInfo(value.gameInfo) &&
    value.blockKinds.every((entry) => isBlockKindInfo(entry)) &&
    value.entityKinds.every((entry) => isEntityKindInfo(entry))
  );
}

/** Parse and validate `GetGameInfoResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseGetGameInfoResponse(value: unknown): GetGameInfoResponse {
  if (!isGetGameInfoResponse(value)) {
    throw new ProtocolParseError('Invalid GetGameInfoResponse payload');
  }
  return value;
}
