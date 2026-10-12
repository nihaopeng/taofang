import { describe, expect, it } from 'vitest';

import {
  QUAT_IDENTITY,
  clampXZToUnit,
  lengthXZ,
  quatFromYaw,
  yawFromQuat,
} from '../src/index.ts';
import type { Quat, Vec3 } from '../src/index.ts';

describe('lengthXZ', () => {
  it('measures only the horizontal part', () => {
    expect(lengthXZ({ x: 3, y: 100, z: 4 })).toBe(5);
    expect(lengthXZ({ x: 0, y: 42, z: 0 })).toBe(0);
  });
});

describe('clampXZToUnit', () => {
  it('shrinks a magnitude-3 XZ vector to magnitude 1, leaving y untouched', () => {
    const clamped = clampXZToUnit({ x: 3, y: 7, z: 0 });
    expect(clamped).toEqual({ x: 1, y: 7, z: 0 });
    expect(lengthXZ(clamped)).toBe(1);
  });

  it('leaves an already-short vector alone', () => {
    expect(clampXZToUnit({ x: 0.3, y: 5, z: 0.4 })).toEqual({ x: 0.3, y: 5, z: 0.4 });
    expect(clampXZToUnit({ x: 0, y: 5, z: 0 })).toEqual({ x: 0, y: 5, z: 0 });
    expect(clampXZToUnit({ x: 1, y: 5, z: 0 })).toEqual({ x: 1, y: 5, z: 0 });
  });

  it('is zero-safe', () => {
    const clamped = clampXZToUnit({ x: 0, y: 0, z: 0 });
    expect(clamped).toEqual({ x: 0, y: 0, z: 0 });
    expect(Number.isNaN(clamped.x)).toBe(false);
  });

  it('does not mutate its input', () => {
    const v: Vec3 = { x: 1, y: 2, z: 3 };
    clampXZToUnit(v);
    expect(v).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('quatFromYaw / yawFromQuat', () => {
  it('represents identity yaw as the identity quaternion', () => {
    expect(quatFromYaw(0)).toEqual(QUAT_IDENTITY);
    expect(QUAT_IDENTITY).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('round-trips yaw through a quaternion exactly for representative angles', () => {
    for (const yaw of [0, 0.5, -0.5, 1, -1, 2.5, -2.5, Math.PI, -Math.PI]) {
      expect(yawFromQuat(quatFromYaw(yaw))).toBe(yaw);
    }
  });

  it('extracts the yaw of a rotation about +Y', () => {
    // A 90° rotation about +Y: (0, sin(45°), 0, cos(45°)).
    const quarterTurn: Quat = quatFromYaw(Math.PI / 2);
    expect(quarterTurn.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(yawFromQuat(quarterTurn)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('does not mutate its input', () => {
    const q = quatFromYaw(1.2);
    const snapshot = { ...q };
    yawFromQuat(q);
    expect(q).toEqual(snapshot);
  });
});
