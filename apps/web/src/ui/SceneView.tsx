/**
 * `SceneView` owns the canvas and the bridge -> runtime wiring. Nothing else.
 *
 * It is deliberately thin:
 * - it subscribes to the Organizer with `useWorld()` (application state),
 * - it maps that state through the pure `RenderBridge` (render ISA frames),
 * - it pushes frames into a `RenderRuntime` (the executor).
 *
 * It imports no `three` and no `@starvalley/render-protocol`: the bridge is the
 * single entry point to the ISA, and the runtime is the only Three.js importer.
 *
 * Camera follow
 * -------------
 * The runtime's camera rig follows the CONTROLLED ACTOR. `SceneView` derives that
 * node's id through `controlledActorNodeId(state)` (the bridge owns node id
 * namespacing) and calls `runtime.setFollowTarget(...)`. That is viewer
 * configuration, not scene content, so it is deliberately not an ISA primitive.
 * A `null` target (no controlled actor) stops the follow without moving the
 * camera.
 *
 * World extent
 * ------------
 * The runtime needs the authoritative world AABB so its orthographic frustum
 * fits the WORLD now, not a tile count. `WorldState.bounds` is that source; tiles
 * already arrive at their world positions, so nothing render-side needs the
 * gameplay grid (`WorldState.grid` has no render consumer and is not passed).
 * Until the bounds are known (`bounds === null`) the canvas renders but no
 * runtime is created. If the world reloads with different bounds, the effect
 * re-runs and a runtime for the new bounds replaces the old one.
 *
 * Lifecycle
 * ---------
 * One runtime per mount: it is created inside the mount effect and disposed in
 * that effect's cleanup. React StrictMode's mount -> dispose -> mount therefore
 * gets a fresh runtime each time instead of reusing one whose `WebGLRenderer`
 * was already released. We deliberately never call `forceContextLoss()`, which
 * does not reliably hand back the same context.
 *
 * Residual risk (NOT covered by tests): StrictMode's dev-only remount creates a
 * second `WebGLRenderer` on the same canvas after the first is disposed. jsdom
 * has no WebGL, so "two sequential renderers on one canvas" cannot be exercised
 * here; it needs a manual browser check.
 *
 * Testability: the default runtime constructs a `WebGLRenderer`, which needs a
 * real canvas + WebGL. The `createRuntime` prop lets tests inject a recording
 * runtime so the bridge/runtime *wiring* can be verified without a GPU; it
 * receives the authoritative world bounds.
 */

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { useWorld } from '../organizer';
import type { BoundsViewModel } from '../organizer';
import { controlledActorNodeId, createRenderBridge } from '../render/bridge';
import type { RenderBridge } from '../render/bridge';
import { createThreeRuntime } from '../render/three/runtime';
import type { RenderRuntime } from '../render/three/runtime';

/** Authoritative world extent handed to the runtime factory. */
export interface SceneViewOptions {
  bounds: BoundsViewModel;
}

/** One wheel notch's zoom factor. */
const WHEEL_ZOOM_FACTOR = 1.1;

export function SceneView(props: {
  createRuntime?: (options: SceneViewOptions) => RenderRuntime;
  /**
   * Optional shared ref the parent uses to reach the live runtime (e.g. to read
   * the camera yaw for camera-relative input, or to zoom). Set on mount and
   * cleared on unmount.
   */
  runtimeRef?: MutableRefObject<RenderRuntime | null>;
}) {
  const { createRuntime, runtimeRef: externalRuntimeRef } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const internalRuntimeRef = useRef<RenderRuntime | null>(null);
  const runtimeRef = externalRuntimeRef ?? internalRuntimeRef;
  const bridgeRef = useRef<RenderBridge | null>(null);

  const state = useWorld();
  // Latest state for the mount effect, which must not re-run on every change.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Keep the factory in a ref so an inline function identity (common in tests)
  // cannot trigger a runtime re-create; only an actual world-extent change does.
  const createRuntimeRef = useRef(createRuntime);
  createRuntimeRef.current = createRuntime;

  // Lazy, once-per-component-instance construction. Writing a ref during render
  // is the documented React pattern for expensive lazy initialisation.
  if (bridgeRef.current === null) {
    bridgeRef.current = createRenderBridge();
  }

  const bounds = state.bounds;
  // A stable primitive key: a stream snapshot replaces `bounds` with a fresh but
  // equal object, and that must not tear down and rebuild the whole runtime.
  const boundsKey =
    bounds === null
      ? null
      : `${bounds.min.x},${bounds.min.y},${bounds.min.z},${bounds.max.x},${bounds.max.y},${bounds.max.z}`;

  useEffect(() => {
    const currentBounds = stateRef.current.bounds;
    const canvas = canvasRef.current;
    const bridge = bridgeRef.current;
    if (boundsKey === null || currentBounds === null) {
      return undefined;
    }
    if (canvas === null || bridge === null) {
      return undefined;
    }

    const factory = createRuntimeRef.current;
    const options: SceneViewOptions = { bounds: currentBounds };
    const runtime =
      factory !== undefined ? factory(options) : createThreeRuntime({ bounds: currentBounds });

    runtimeRef.current = runtime;
    runtime.mount(canvas);
    // A (re)mount starts from a fresh runtime with no nodes, so reset the bridge
    // and re-push the current state rather than diffing against a dead scene.
    bridge.reset();
    runtime.apply(bridge.frameFor(stateRef.current));
    // A fresh runtime has no follow target; point it at the controlled actor.
    runtime.setFollowTarget(controlledActorNodeId(stateRef.current));

    return () => {
      runtimeRef.current = null;
      runtime.dispose();
    };
  }, [boundsKey]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const bridge = bridgeRef.current;
    if (runtime === null || bridge === null) {
      return;
    }
    runtime.apply(bridge.frameFor(state));
    // Sync the follow target on every state change: `null` when there is no
    // controlled actor, so the camera stops following rather than tracking a
    // stale node.
    runtime.setFollowTarget(controlledActorNodeId(state));
  }, [state]);

  return (
    <canvas
      ref={canvasRef}
      className="scene-view__canvas"
      data-testid="scene-canvas"
      onWheel={(event) => {
        const runtime = runtimeRef.current;
        if (runtime === null) {
          return;
        }
        // Wheel up (negative deltaY) zooms in. `setZoom` clamps to the rig limits.
        const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
        runtime.setZoom(runtime.getCameraState().zoom * factor);
      }}
    />
  );
}
