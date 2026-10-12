/**
 * Wire guards for the neutral `Vec3` / `Quat` value objects.
 *
 * The types themselves live in `@starvalley/math` (a shared, dependency-free
 * primitive package) so the Game Protocol and the Render ISA agree on the same
 * definition. The protocol root re-exports `Vec3`/`Quat` from here so consumers
 * of the game contract keep a single import site and never have to depend on
 * `@starvalley/math` directly.
 */

import type { Quat, Vec3 } from '@starvalley/math';

import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isFiniteNumber, isRecord } from './internal.ts';

export type { Quat, Vec3 } from '@starvalley/math';

const VEC3_KEYS = ['x', 'y', 'z'] as const;
const QUAT_KEYS = ['x', 'y', 'z', 'w'] as const;

/**
 * Structural guard for `Vec3` (exactly `{ x, y, z }`, each a finite number).
 * Fractional values are accepted: world coordinates are continuous.
 */
export function isVec3(value: unknown): value is Vec3 {
  if (!isRecord(value) || !hasExactKeys(value, VEC3_KEYS)) {
    return false;
  }
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
}

/** Parse and validate `Vec3`, throwing `ProtocolParseError` on mismatch. */
export function parseVec3(value: unknown): Vec3 {
  if (!isVec3(value)) {
    throw new ProtocolParseError('Invalid Vec3 payload');
  }
  return value;
}

/**
 * Structural guard for `Quat` (exactly `{ x, y, z, w }`, four finite numbers,
 * non-zero length). A zero quaternion is not a rotation and is rejected. The
 * quaternion is deliberately NOT required to be normalised: normalisation is a
 * runtime concern, not a wire invariant.
 */
export function isQuat(value: unknown): value is Quat {
  if (!isRecord(value) || !hasExactKeys(value, QUAT_KEYS)) {
    return false;
  }
  if (
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.z) ||
    !isFiniteNumber(value.w)
  ) {
    return false;
  }
  return value.x * value.x + value.y * value.y + value.z * value.z + value.w * value.w > 0;
}

/** Parse and validate `Quat`, throwing `ProtocolParseError` on mismatch. */
export function parseQuat(value: unknown): Quat {
  if (!isQuat(value)) {
    throw new ProtocolParseError('Invalid Quat payload');
  }
  return value;
}
