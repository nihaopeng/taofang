/**
 * Unit tests for camera-relative movement input (node environment: no DOM).
 *
 * These pin the frozen mapping between the four camera-local axes and world-space
 * `(x, z)` at several rig yaws, the diagonal clamp, and the "post only on change"
 * contract (including the `{x:0,z:0}` release).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  cameraRelativeIntent,
  createMovementController,
  localIntent,
  rotateByYaw,
} from '../src/ui/movement-input.ts';
import type { HeldMovement, MovementKey } from '../src/ui/movement-input.ts';

function held(...keys: MovementKey[]): HeldMovement {
  const set = new Set(keys);
  return {
    up: set.has('up'),
    down: set.has('down'),
    left: set.has('left'),
    right: set.has('right'),
  };
}

/** Assert a `(x, z)` pair approximately (the rotation leaves ~1e-17 residues). */
function expectIntent(
  actual: { x: number; z: number } | undefined,
  expected: { x: number; z: number },
): void {
  expect(actual?.x).toBeCloseTo(expected.x, 9);
  expect(actual?.z).toBeCloseTo(expected.z, 9);
}

/** Cardinal expectations: [yaw, up, down, left, right] world `(x,z)`. */
const CARDINALS: ReadonlyArray<{
  yaw: number;
  up: { x: number; z: number };
  down: { x: number; z: number };
  left: { x: number; z: number };
  right: { x: number; z: number };
}> = [
  // Rig yaw 0: camera on +Z looking -Z. W is away from camera -> (0, -1).
  { yaw: 0, up: { x: 0, z: -1 }, down: { x: 0, z: 1 }, left: { x: -1, z: 0 }, right: { x: 1, z: 0 } },
  // Rig yaw 90: camera on +X looking -X. Away is -X; screen-left is +Z.
  { yaw: 90, up: { x: -1, z: 0 }, down: { x: 1, z: 0 }, left: { x: 0, z: 1 }, right: { x: 0, z: -1 } },
  // Rig yaw 180: camera on -Z looking +Z. Away is +Z.
  { yaw: 180, up: { x: 0, z: 1 }, down: { x: 0, z: -1 }, left: { x: 1, z: 0 }, right: { x: -1, z: 0 } },
  // Rig yaw 270: camera on -X looking +X. Away is +X; screen-left is -Z.
  { yaw: 270, up: { x: 1, z: 0 }, down: { x: -1, z: 0 }, left: { x: 0, z: -1 }, right: { x: 0, z: 1 } },
];

describe('camera-relative mapping', () => {
  it('maps the four cardinal axes to the rotated world vectors at yaw 0/90/180/270', () => {
    for (const expected of CARDINALS) {
      expectIntent(cameraRelativeIntent(held('up'), expected.yaw), expected.up);
      expectIntent(cameraRelativeIntent(held('down'), expected.yaw), expected.down);
      expectIntent(cameraRelativeIntent(held('left'), expected.yaw), expected.left);
      expectIntent(cameraRelativeIntent(held('right'), expected.yaw), expected.right);
    }
  });

  it('clamps a diagonal key pair to unit length (the server validates |v| <= 1)', () => {
    const diagonal = cameraRelativeIntent(held('up', 'right'), 0);
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1, 12);
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(diagonal.z).toBeCloseTo(-Math.SQRT1_2, 12);

    // The clamp happens before the yaw rotation, so a diagonal stays unit length
    // at any rig orientation.
    for (const expected of CARDINALS) {
      const rotated = cameraRelativeIntent(held('up', 'left'), expected.yaw);
      expect(Math.hypot(rotated.x, rotated.z)).toBeCloseTo(1, 12);
    }
  });

  it('posts no intent when nothing is held, and rotateByYaw is a pure rotation', () => {
    expect(localIntent(held())).toEqual({ x: 0, z: 0 });
    // Rotating a zero vector is still zero.
    expectIntent(rotateByYaw({ x: 0, z: 0 }, 123), { x: 0, z: 0 });
    // A non-trivial vector keeps its magnitude through a rotation.
    const rotated = rotateByYaw({ x: 0.6, z: -0.8 }, 37);
    expect(Math.hypot(rotated.x, rotated.z)).toBeCloseTo(1, 12);
  });
});

describe('movement controller posting', () => {
  it('posts on the input change and zero on release, never on repeat', () => {
    const yaw = 0;
    const post = vi.fn();
    const controller = createMovementController({ post, getYawDegrees: () => yaw });

    controller.setHeld('up', true);
    expect(post).toHaveBeenCalledTimes(1);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: -1 });

    // A held key re-reporting itself (auto-repeat) is not a change.
    controller.setHeld('up', true);
    expect(post).toHaveBeenCalledTimes(1);

    // Adding a second axis changes the (clamped) intent and posts once.
    controller.setHeld('right', true);
    expect(post).toHaveBeenCalledTimes(2);
    expectIntent(post.mock.calls.at(-1)?.[0], {
      x: Math.SQRT1_2,
      z: -Math.SQRT1_2,
    });

    controller.setHeld('up', false);
    expect(post).toHaveBeenCalledTimes(3);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 1, z: 0 });

    controller.setHeld('right', false);
    expect(post).toHaveBeenCalledTimes(4);
    // All input released -> explicit stop.
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: 0 });

    // Releasing again is not a change.
    controller.setHeld('right', false);
    expect(post).toHaveBeenCalledTimes(4);
  });

  it('samples the rig yaw at the moment of the change', () => {
    let yaw = 0;
    const post = vi.fn();
    const controller = createMovementController({ post, getYawDegrees: () => yaw });

    controller.setHeld('up', true);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: -1 });

    controller.setHeld('up', false);
    yaw = 90;
    controller.setHeld('up', true);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: -1, z: 0 });

    controller.setHeld('up', false);
    controller.releaseAll();
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: 0 });
  });

  it('refresh re-posts a held intent after the rig yaw changes', () => {
    let yaw = 0;
    const post = vi.fn();
    const controller = createMovementController({ post, getYawDegrees: () => yaw });

    controller.setHeld('up', true);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: -1 });

    // A rotate while the key is held must re-post against the new camera frame,
    // without a release/re-press.
    yaw = 90;
    controller.refresh();
    expect(post).toHaveBeenCalledTimes(2);
    expectIntent(post.mock.calls.at(-1)?.[0], { x: -1, z: 0 });

    // A refresh with nothing held recomputes the stop, which is already posted,
    // so it must not post again.
    controller.setHeld('up', false);
    post.mockClear();
    controller.refresh();
    expect(post).not.toHaveBeenCalled();
  });

  it('releaseAll stops a held intent and getHeld reflects the live state', () => {
    const post = vi.fn();
    const controller = createMovementController({ post, getYawDegrees: () => 0 });

    controller.setHeld('left', true);
    expect(controller.getHeld().left).toBe(true);
    expectIntent(controller.getIntent(), { x: -1, z: 0 });

    controller.releaseAll();
    expect(controller.getHeld()).toEqual(held());
    expectIntent(post.mock.calls.at(-1)?.[0], { x: 0, z: 0 });

    // Nothing held: releaseAll is a no-op.
    post.mockClear();
    controller.releaseAll();
    expect(post).not.toHaveBeenCalled();
  });
});
