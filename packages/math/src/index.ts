/**
 * `@starvalley/math` — neutral 3D math primitives.
 *
 * Conventions (frozen so both the game contract and the render ISA agree):
 * - `+X = East`, `+Y = Up`, `+Z = South` (right-handed).
 * - `yaw` is a rotation about `+Y`.
 *
 * This is deliberately NOT a math library: it holds only the primitives the
 * world and render code actually need. There are no classes, no engine, no
 * framework, and no game or render semantics. Everything is a pure function
 * and inputs are never mutated.
 */

/** Continuous position or direction in world/render space (world units). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion rotation. Component order `(x, y, z, w)`; `w` is the scalar part. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Length of the horizontal (`XZ`) part of `v`; `y` is ignored. */
export function lengthXZ(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

/**
 * Clamp the horizontal (`XZ`) magnitude of `v` to at most 1, leaving `y`
 * untouched. Zero-safe. A vector already within the unit disc is returned with
 * its components unchanged. Returns a new vector; `v` is not mutated.
 */
export function clampXZToUnit(v: Vec3): Vec3 {
  const length = lengthXZ(v);
  if (length <= 1) {
    return { x: v.x, y: v.y, z: v.z };
  }
  return { x: v.x / length, y: v.y, z: v.z / length };
}

/** The identity (zero) rotation. */
export const QUAT_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Build a quaternion for a yaw rotation (about `+Y`) of `yawRadians`.
 * Only the yaw component is populated; roll and pitch are identity.
 */
export function quatFromYaw(yawRadians: number): Quat {
  const half = yawRadians / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Extract the yaw (rotation about `+Y`) from a rotation quaternion, in the
 * interval `(-π, π]`. This is the general yaw component of `q`, not a
 * pure-yaw-only shortcut.
 *
 * Read-side inverse of `quatFromYaw`. No `src` consumer today: its only caller
 * is the Manager's heading tests (`packages/manager/test/world-manager.test.ts`)
 * and the web render runtime still duplicates the same math against Three.js
 * `Quaternion`. It is reserved as the single canonical yaw reader until that
 * duplicate is collapsed onto it.
 */
export function yawFromQuat(q: Quat): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}
