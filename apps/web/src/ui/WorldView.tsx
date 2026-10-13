import { useCallback, useEffect, useRef, useState } from 'react';

import { loadWorld, setMovementIntent, useWorld } from '../organizer';
import { Hud } from './Hud';
import { SceneView } from './SceneView';
import type { SceneViewOptions } from './SceneView';
import { createMovementController } from './movement-input';
import type { MovementController, MovementKey } from './movement-input';
import { RENDER_CAMERA } from '../render/three/runtime';
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

/**
 * Physical keys that toggle the presentation-only grid overlay. Documented as a
 * stand-in for the future farming/placement/selection/debug mode switch.
 */
const GRID_TOGGLE_KEYS: ReadonlySet<string> = new Set(['g', 'G']);

/** Format a world coordinate for the HUD (continuous world units, 1 decimal). */
function formatCoordinate(value: number): string {
  return value.toFixed(1);
}

/**
 * Whether a key event originated inside an interactive HUD form control (the
 * settings panel's range input, or a future text field).
 *
 * While such an element has focus the global movement / Q-E / G handlers must
 * NOT run: arrow keys must operate the control rather than walking the actor (or
 * being `preventDefault()`-ed), and a stray letter must not rotate the view or
 * toggle the grid. This is the keyboard half of the HUD pointer/keyboard
 * isolation guarantee; the pointer half is `pointer-events: none` on the overlay
 * with `pointer-events: auto` on the controls (see `styles.css`).
 */
function isHudFormTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [data-hud-form]') !== null
  );
}

/**
 * Presentation of the Organizer's world/actor state.
 *
 * The world itself is rendered by `<SceneView />` (Three.js executing the Render
 * ISA), wrapped in a positioned viewport container. Over it sits `<Hud />`, a
 * DOM/CSS layer (toolbar, bag panel, stream status, notice) whose overlay is
 * input-transparent except for its own controls. This component keeps the rest
 * of the presentation: camera-relative directional intent (buttons + keyboard),
 * the loading affordance, the error affordance with `Retry`, and a short status
 * line for the controlled actor. It never calls the backend: every intent goes
 * through `setMovementIntent` / `loadWorld` from the Organizer. The UI
 * deliberately does not know (or send) which actor it controls — that identity
 * is resolved by the server from transport context.
 *
 * Input is **held**, not one-shot: pressing drives a continuous intent, releasing
 * stops it, and the controller posts only when the intent changes (never on a
 * poll). The world-space vector is computed from the CameraRig's yaw, so the
 * mapping is camera-relative. Q/E rotate the rig, and a rotate re-posts a held
 * intent so WASD stays intuitive after the view turns.
 */
export function WorldView(props: {
  /**
   * Optional runtime factory forwarded to `<SceneView />`, so tests can inject a
   * recording runtime. The HUD never receives this: it cannot reach the render
   * runtime at all.
   */
  createRuntime?: (options: SceneViewOptions) => RenderRuntime;
}) {
  const { createRuntime } = props;
  const state = useWorld();
  const { status, entities, controlledActorId, error, notice, streamStatus } = state;
  const runtimeRef = useRef<RenderRuntime | null>(null);

  // The grid overlay is an independent presentation layer that is HIDDEN by
  // default. This toggle stands in for the future farming/placement/selection/
  // debug mode switch; those modes do not exist yet, so nothing else turns it on.
  const [gridOverlayVisible, setGridOverlayVisible] = useState(false);
  const gridOverlayVisibleRef = useRef(false);
  const applyGridOverlayVisible = useCallback((visible: boolean) => {
    gridOverlayVisibleRef.current = visible;
    setGridOverlayVisible(visible);
    runtimeRef.current?.setGridOverlayVisible(visible);
  }, []);
  const toggleGridOverlay = useCallback(() => {
    applyGridOverlayVisible(!gridOverlayVisibleRef.current);
  }, [applyGridOverlayVisible]);

  // The camera pitch is a PRESENTATION parameter of the render rig, not Organizer
  // state and never a Protocol field. This React mirror exists only so the HUD can
  // display the live value; the runtime remains the single source of truth and the
  // setter is clamped there, so the mirror reads the live value back.
  const [pitchDegrees, setPitchDegrees] = useState<number>(RENDER_CAMERA.pitchDegrees);
  const applyPitch = useCallback((degrees: number) => {
    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    runtime.setCameraPitch(degrees);
    setPitchDegrees(runtime.getCameraState().pitchDegrees);
  }, []);

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
      // Keyboard isolation: while focus is inside a HUD form control (the camera
      // pitch slider), arrow keys / WASD must not drive movement, rotate the rig,
      // or toggle the grid. Returning before `preventDefault` also leaves the
      // native control free to handle the key (e.g. an arrow key moves the slider).
      if (isHudFormTarget(event.target)) {
        return;
      }
      if (GRID_TOGGLE_KEYS.has(event.key)) {
        // Presentation-only: toggles the grid layer, never a gameplay intent.
        event.preventDefault();
        toggleGridOverlay();
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
  }, [toggleGridOverlay]);

  // Keep the runtime's grid layer in sync with the presentational toggle. The
  // runtime is created by the child `SceneView`, whose effect runs first, so when
  // the world becomes ready this re-applies the (default hidden) state to it. A
  // runtime (re)creation also resets the rig pitch to the default, so mirror the
  // live pitch here rather than letting the settings panel show a stale value.
  useEffect(() => {
    const runtime = runtimeRef.current;
    runtime?.setGridOverlayVisible(gridOverlayVisibleRef.current);
    if (runtime !== null) {
      setPitchDegrees(runtime.getCameraState().pitchDegrees);
    }
  }, [state]);

  // The controlled entity is the one linked to the controlled actor. It is
  // derived from Organizer state; the UI invents no identity of its own.
  const controlledEntity =
    controlledActorId === null
      ? null
      : (entities.find((entity) => entity.actorId === controlledActorId) ?? null);

  return (
    <section className="world" data-testid="world-panel" data-status={status}>
      <h2 className="world__heading">World</h2>

      {/*
        The world lives in the WebGL canvas; the HUD is a DOM/CSS layer painted
        ABOVE it as a sibling inside this positioned container. The overlay is
        `pointer-events: none` (see styles.css) so canvas drag/click/wheel pass
        through everywhere except the HUD's own controls. The HUD receives
        display values only and emits no world actions: any future real data or
        action goes through the Organizer (state in, intents out).
      */}
      <div className="world__viewport" data-testid="world-viewport">
        <SceneView runtimeRef={runtimeRef} createRuntime={createRuntime} />
        <Hud
          streamStatus={streamStatus}
          notice={notice}
          pitchDegrees={pitchDegrees}
          pitchRange={{ min: RENDER_CAMERA.minPitchDegrees, max: RENDER_CAMERA.maxPitchDegrees }}
          defaultPitchDegrees={RENDER_CAMERA.pitchDegrees}
          onPitchChange={applyPitch}
        />
      </div>
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

      <button
        className="world__control world__grid-toggle"
        type="button"
        aria-pressed={gridOverlayVisible}
        data-testid="grid-toggle"
        onClick={toggleGridOverlay}
      >
        Grid overlay: {gridOverlayVisible ? 'On' : 'Off'}
      </button>
    </section>
  );
}
