/**
 * Camera-relative movement input (UI-local presentation logic).
 *
 * WASD/arrow keys and the direction buttons are expressed in **camera-local**
 * axes, then rotated into world space by the rig's yaw, then handed to the
 * Organizer as a world-space movement intent. The conversion is the only place
 * the UI needs to know the camera exists; it never sees a tile or a position.
 *
 * Frozen conventions (matching the CameraRig):
 * - `+X` east, `+Y` up, `+Z` south. Yaw is about `+Y` (`yaw = atan2(vx, vz)`).
 * - At rig yaw 0 the camera sits on the `+Z` side looking toward `-Z`, so "up"
 *   (away from the camera) is world `(0, 0, -1)`:
 *     up -> (0,-1), down -> (0,+1), left -> (-1,0), right -> (+1,0)
 *   in `(x, z)`.
 * - Rotating the rig by yaw rotates those world vectors by the same angle:
 *     world = Ry(yaw) * local, i.e.
 *     `x' = x cos + z sin`, `z' = -x sin + z cos`.
 *
 * A diagonal pair is clamped to unit length, because the server validates
 * `|v| <= 1` and a client must never send more than it is allowed to.
 *
 * The controller posts **only on change** (press, release, or a yaw change while
 * held). It never polls and never posts on an interval; releasing all input
 * sends `{ x: 0, z: 0 }` so the authoritative simulation stops.
 */

/** The four camera-local input axes. */
export type MovementKey = 'up' | 'down' | 'left' | 'right';

/** A world-space desired horizontal direction, each component in `[-1, 1]`. */
export interface MovementIntent {
  x: number;
  z: number;
}

/** Which keys are currently held. */
export type HeldMovement = Readonly<Record<MovementKey, boolean>>;

const NO_KEYS_HELD: HeldMovement = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
});

/**
 * The camera-local direction for a held-key set, before the yaw rotation.
 *
 * `up` is local `-Z` (away from the camera at yaw 0). The result is a direction,
 * not a speed: its magnitude is 1 for a single axis and is clamped to 1 for a
 * diagonal pair.
 */
export function localIntent(held: HeldMovement): MovementIntent {
  let x = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  let z = (held.down ? 1 : 0) - (held.up ? 1 : 0);
  const length = Math.hypot(x, z);
  if (length > 1) {
    x /= length;
    z /= length;
  }
  return { x, z };
}

/**
 * Rotate a camera-local `(x, z)` direction by the rig yaw (about `+Y`).
 *
 * This is exactly the world rotation the CameraRig applies, so an input axis and
 * the camera it belongs to stay aligned. It is a pure function of `(local, yaw)`,
 * which is what makes the four cardinal cases testable at any yaw.
 */
export function rotateByYaw(local: MovementIntent, yawDegrees: number): MovementIntent {
  const yaw = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: local.x * cos + local.z * sin,
    z: -local.x * sin + local.z * cos,
  };
}

/** The world-space intent for a held-key set at a given rig yaw. */
export function cameraRelativeIntent(held: HeldMovement, yawDegrees: number): MovementIntent {
  return rotateByYaw(localIntent(held), yawDegrees);
}

/** Stable numeric comparison so a re-render cannot post a "new" equal intent. */
function sameIntent(a: MovementIntent, b: MovementIntent): boolean {
  return a.x === b.x && a.z === b.z;
}

/**
 * The controller surface. It owns only *held-input state*; posting is injected so
 * this file stays free of the Organizer and is testable without a DOM.
 */
export interface MovementController {
  /** Mark a camera-local axis held/released and post the intent if it changed. */
  setHeld(key: MovementKey, held: boolean): void;
  /**
   * Recompute the world-space intent from the currently held keys and post it if
   * it changed. Called when the rig yaw changes while a key is held, so a held
   * key keeps driving the actor toward where the (rotated) camera now points
   * without a release/re-press. A no-op when the recomputed intent is unchanged
   * (e.g. nothing held).
   */
  refresh(): void;
  /** Release every axis (e.g. on window blur) and post `{0, 0}` if needed. */
  releaseAll(): void;
  /** The keys currently held (a copy). */
  getHeld(): HeldMovement;
  /** The world-space intent last posted. */
  getIntent(): MovementIntent;
  /** Release everything and stop posting. */
  dispose(): void;
}

/**
 * Create a controller that posts world-space intents on change.
 *
 * `getYawDegrees` is sampled at the moment of each change (press/release), which
 * is exactly when a camera-relative decision has to be made. `getYawDegrees` is
 * deliberately injected rather than imported so the UI reads the rig through the
 * runtime it already owns.
 */
export function createMovementController(options: {
  post: (intent: MovementIntent) => void;
  getYawDegrees: () => number;
}): MovementController {
  let held: HeldMovement = NO_KEYS_HELD;
  let posted: MovementIntent = { x: 0, z: 0 };

  function recomputeAndPost(): void {
    const next = cameraRelativeIntent(held, options.getYawDegrees());
    if (sameIntent(next, posted)) {
      return;
    }
    posted = next;
    options.post(next);
  }

  return {
    setHeld(key: MovementKey, nextHeld: boolean): void {
      if (held[key] === nextHeld) {
        // A held key re-reporting itself (OS auto-repeat, pointer move) is not a
        // change, so it must not post.
        return;
      }
      held = { ...held, [key]: nextHeld };
      recomputeAndPost();
    },
    refresh(): void {
      recomputeAndPost();
    },
    releaseAll(): void {
      const anyHeld = held.up || held.down || held.left || held.right;
      held = NO_KEYS_HELD;
      if (anyHeld) {
        recomputeAndPost();
      }
    },
    getHeld(): HeldMovement {
      return held;
    },
    getIntent(): MovementIntent {
      return posted;
    },
    dispose(): void {
      held = NO_KEYS_HELD;
    },
  };
}
