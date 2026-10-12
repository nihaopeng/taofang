import { useEffect, useRef } from 'react';

import { loadWorld, setMovementIntent, useWorld } from '../organizer';
import type { StreamStatus } from '../organizer';
import { SceneView } from './SceneView';
import { createMovementController } from './movement-input';
import type { MovementController, MovementKey } from './movement-input';
import type { RenderRuntime } from '../render/three/runtime';

/**
 * Camera-relative direction controls, in a stable order, with accessible names.
 * "Forward" means *away from the camera*; the actual world vector is computed
 * from the rig's yaw when the button is pressed.
 */
const DIRECTIONS: ReadonlyArray<{ key: MovementKey; label: string; glyph: string }> = [
  { key: 'up', label: 'Move forward (away from camera)', glyph: '↑' },
  { key: 'down', label: 'Move back (toward camera)', glyph: '↓' },
  { key: 'left', label: 'Move left', glyph: '←' },
  { key: 'right', label: 'Move right', glyph: '→' },
];

/**
 * Physical key -> camera-local axis. Arrows plus WASD, case-insensitive so the
 * mapping still works when Shift or CapsLock is on.
 */
const KEY_TO_AXIS: Readonly<Record<string, MovementKey | undefined>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

/** Degrees the rig yaw turns per Q/E press. */
const CAMERA_ROTATE_STEP_DEGREES = 15;

/**
 * Physical key -> rig yaw delta. Q turns the view left (yaw decreases), E turns
 * it right. Rotation is viewer configuration: the runtime owns the rig, and a
 * rotate re-posts a held intent through the controller so the actor keeps moving
 * in the direction the new camera stance implies (no release/re-press needed).
 */
const KEY_TO_YAW_STEP: Readonly<Record<string, number | undefined>> = {
  q: -CAMERA_ROTATE_STEP_DEGREES,
  Q: -CAMERA_ROTATE_STEP_DEGREES,
  e: CAMERA_ROTATE_STEP_DEGREES,
  E: CAMERA_ROTATE_STEP_DEGREES,
};

/** Short, user-presentable label for the realtime stream lifecycle. */
const STREAM_LABEL: Readonly<Record<StreamStatus, string>> = {
  idle: 'Stream idle',
  connecting: 'Connecting…',
  live: 'Live',
  error: 'Connection lost',
};

/** Format a world coordinate for the HUD (continuous world units, 1 decimal). */
function formatCoordinate(value: number): string {
  return value.toFixed(1);
}

/**
 * Presentation of the Organizer's world/actor state.
 *
 * The world itself is rendered by `<SceneView />` (Three.js executing the Render
 * ISA). This component keeps only the HUD: camera-relative directional intent
 * (buttons + keyboard), the loading affordance, the error affordance with
 * `Retry`, a live/dropped stream indicator, and a short status line for the
 * controlled actor. It never calls the backend: every intent goes through
 * `setMovementIntent` / `loadWorld` from the Organizer. The UI deliberately does
 * not know (or send) which actor it controls — that identity is resolved by the
 * server from transport context.
 *
 * Input is **held**, not one-shot: pressing drives a continuous intent, releasing
 * stops it, and the controller posts only when the intent changes (never on a
 * poll). The world-space vector is computed from the CameraRig's yaw, so the
 * mapping is camera-relative. Q/E rotate the rig, and a rotate re-posts a held
 * intent so WASD stays intuitive after the view turns.
 */
export function WorldView() {
  const state = useWorld();
  const { status, entities, controlledActorId, error, notice, streamStatus } = state;
  const runtimeRef = useRef<RenderRuntime | null>(null);

  // Movement is only meaningful once an authoritative controlled actor exists.
  const canMove = status === 'ready' && controlledActorId !== null;
  const canMoveRef = useRef(canMove);
  canMoveRef.current = canMove;

  // One controller per component instance. Lazy ref initialisation keeps it
  // stable across renders while still closing over the per-render refs.
  const controllerRef = useRef<MovementController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createMovementController({
      post: (intent) => {
        // A zero intent (release/stop) must reach the Organizer even when the
        // world is in an error state: a previously-held non-zero intent is
        // retained server-side, so suppressing the stop would leave the actor
        // walking. `setMovementIntent` is already a safe no-op before the world
        // loads, so the gate only needs to guard non-zero movement.
        if (canMoveRef.current || (intent.x === 0 && intent.z === 0)) {
          void setMovementIntent(intent);
        }
      },
      // The rig lives in the runtime; read its yaw at the moment of a change.
      getYawDegrees: () => runtimeRef.current?.getCameraState().yawDegrees ?? 0,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current;
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Let browser/OS shortcuts through untouched.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const yawStep = KEY_TO_YAW_STEP[event.key];
      if (yawStep !== undefined) {
        const runtime = runtimeRef.current;
        if (runtime !== null) {
          runtime.setCameraOrientation({
            yawDegrees: runtime.getCameraState().yawDegrees + yawStep,
          });
          // The rig is the actor's frame of reference: recompute and re-post any
          // held intent so the world vector follows the rotated camera.
          controller?.refresh();
        }
        return;
      }
      const axis = KEY_TO_AXIS[event.key];
      if (axis === undefined) {
        return;
      }
      // Arrow keys would otherwise scroll the page.
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
      }
      if (!canMoveRef.current) {
        return;
      }
      // Held input: `setHeld(true)` on a key already held is a no-op, so OS
      // auto-repeat cannot post at the key-repeat rate.
      controller?.setHeld(axis, true);
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      const axis = KEY_TO_AXIS[event.key];
      if (axis === undefined) {
        return;
      }
      controller?.setHeld(axis, false);
    };

    // Losing focus must not leave a key "stuck" driving movement forever.
    const handleBlur = (): void => {
      controller?.releaseAll();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      controller?.releaseAll();
    };
  }, []);

  // The controlled entity is the one linked to the controlled actor. It is
  // derived from Organizer state; the UI invents no identity of its own.
  const controlledEntity =
    controlledActorId === null
      ? null
      : (entities.find((entity) => entity.actorId === controlledActorId) ?? null);

  return (
    <section className="world" data-testid="world-panel" data-status={status}>
      <h2 className="world__heading">World</h2>

      <SceneView runtimeRef={runtimeRef} />

      <p
        className="world__stream"
        data-testid="world-stream-status"
        data-stream-status={streamStatus}
      >
        {STREAM_LABEL[streamStatus]}
      </p>

      {/*
        A REJECTED intent (out of range / not interactable / target gone) is a
        short, transient message, not a broken-world error: the Organizer keeps
        `status`/`error` untouched, and clears `notice` on the next successful
        intent. It is deliberately not rendered inside the `role="alert"` error
        block, so a refusal never reads as a broken connection.
      */}
      {notice !== null ? (
        <p className="world__notice" role="status" data-testid="world-notice">
          {notice}
        </p>
      ) : null}

      {controlledEntity !== null ? (
        <p className="world__actor-info" data-testid="controlled-actor-info">
          <span className="world__actor-coords">
            ({formatCoordinate(controlledEntity.position.x)},{' '}
            {formatCoordinate(controlledEntity.position.y)},{' '}
            {formatCoordinate(controlledEntity.position.z)})
          </span>
        </p>
      ) : null}

      {status === 'idle' || status === 'loading' ? (
        <p className="world__loading" role="status">
          Loading world…
        </p>
      ) : null}

      {error !== null ? (
        <div className="world__error" role="alert">
          <p className="world__message">{error}</p>
          <button
            className="world__retry"
            type="button"
            onClick={() => {
              void loadWorld();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="world__controls">
        {DIRECTIONS.map(({ key, label, glyph }) => (
          <button
            key={key}
            className="world__control"
            type="button"
            aria-label={label}
            data-testid={`move-${key}`}
            disabled={!canMove}
            onPointerDown={() => {
              controllerRef.current?.setHeld(key, true);
            }}
            onPointerUp={() => {
              controllerRef.current?.setHeld(key, false);
            }}
            onPointerLeave={() => {
              controllerRef.current?.setHeld(key, false);
            }}
            onPointerCancel={() => {
              controllerRef.current?.setHeld(key, false);
            }}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        ))}
      </div>

      <p className="world__rotate-hint" data-testid="rotate-hint">
        Rotate view: Q / E
      </p>
    </section>
  );
}
