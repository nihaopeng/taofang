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
 * The runtime's orthographic camera follows the CONTROLLED ACTOR. `SceneView`
 * derives that node's id through `controlledActorNodeId(state)` (the bridge owns
 * node id namespacing) and calls `runtime.setFollowTarget(...)`. That is viewer
 * configuration, not scene content, so it is deliberately not an ISA primitive.
 * A `null` target (no controlled actor) stops the follow without moving the
 * camera.
 *
 * World size
 * ----------
 * The runtime needs the authoritative world dimensions, and the only source is
 * `WorldState.world`. Until that is known (`world === null`) the canvas renders
 * but no runtime is created. If the world reloads with a different size, the
 * effect re-runs and a runtime for the new size replaces the old one.
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
 * receives the authoritative world size.
 */

import { useEffect, useRef } from 'react';

import { useWorld } from '../organizer';
import { controlledActorNodeId, createRenderBridge } from '../render/bridge';
import type { RenderBridge } from '../render/bridge';
import { createThreeRuntime } from '../render/three/runtime';
import type { RenderRuntime } from '../render/three/runtime';

/** Authoritative world dimensions handed to the runtime factory. */
export interface SceneViewOptions {
  worldSize: { width: number; height: number };
}

export function SceneView(props: {
  createRuntime?: (options: SceneViewOptions) => RenderRuntime;
}) {
  const { createRuntime } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<RenderRuntime | null>(null);
  const bridgeRef = useRef<RenderBridge | null>(null);

  const state = useWorld();
  // Latest state for the mount effect, which must not re-run on every change.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Keep the factory in a ref so an inline function identity (common in tests)
  // cannot trigger a runtime re-create; only an actual world-size change does.
  const createRuntimeRef = useRef(createRuntime);
  createRuntimeRef.current = createRuntime;

  // Lazy, once-per-component-instance construction. Writing a ref during render
  // is the documented React pattern for expensive lazy initialisation.
  if (bridgeRef.current === null) {
    bridgeRef.current = createRenderBridge();
  }

  const worldWidth = state.world?.width ?? null;
  const worldHeight = state.world?.height ?? null;

  useEffect(() => {
    if (worldWidth === null || worldHeight === null) {
      return undefined;
    }
    const canvas = canvasRef.current;
    const bridge = bridgeRef.current;
    if (canvas === null || bridge === null) {
      return undefined;
    }

    const factory = createRuntimeRef.current;
    const runtime =
      factory !== undefined
        ? factory({ worldSize: { width: worldWidth, height: worldHeight } })
        : createThreeRuntime({ worldSize: { width: worldWidth, height: worldHeight } });

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
  }, [worldWidth, worldHeight]);

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

  return <canvas ref={canvasRef} className="scene-view__canvas" data-testid="scene-canvas" />;
}
