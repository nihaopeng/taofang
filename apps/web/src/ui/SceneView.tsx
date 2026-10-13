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
 * The runtime needs the authoritative world AABB so its perspective frustum
 * frames the WORLD, not a tile count. `WorldState.bounds` is that source; blocks
 * already arrive at their world positions, so nothing render-side needs the
 * block grid to place them. The grid spec IS passed, however, because the runtime
 * builds its `GridOverlay` layer from `cellSize`/`origin`. Until the bounds/grid
 * are known (`bounds === null`) the canvas renders but no runtime is created. If
 * the world reloads with different bounds or grid, the effect re-runs and a
 * runtime for the new spec replaces the old one.
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
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';

import { interact, moveTo, useWorld } from '../organizer';
import type { BlockGridViewModel, BoundsViewModel } from '../organizer';
import { controlledActorNodeId, createRenderBridge, entityIdOfNodeId } from '../render/bridge';
import type { RenderBridge } from '../render/bridge';
import { createThreeRuntime } from '../render/three/runtime';
import type { RenderPick, RenderRuntime } from '../render/three/runtime';

/**
 * Authoritative world extent and block grid handed to the runtime factory.
 *
 * `blockGrid` is presentation-relevant now: the runtime builds its `GridOverlay`
 * from `origin`/`cellSize`. It is still just a world fact (the frozen grid ->
 * world formula lives in the Organizer), not a gameplay rule.
 */
export interface SceneViewOptions {
  bounds: BoundsViewModel;
  blockGrid: BlockGridViewModel;
}

/** One wheel notch's zoom factor. */
const WHEEL_ZOOM_FACTOR = 1.1;

/**
 * Maximum pointer travel (px) for a press to count as a click. Below this a
 * press is a click; above it, a drag that rotates the rig.
 */
const CLICK_MOVE_THRESHOLD_PX = 5;

/** Maximum press duration (ms) for a press to count as a click. */
const CLICK_TIME_THRESHOLD_MS = 350;

/** Rig degrees rotated per pixel of horizontal drag (yaw only; pitch is fixed). */
const DRAG_DEGREES_PER_PIXEL = 0.3;

/** In-flight pointer gesture. `null` when no button is down. */
interface PointerGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  startTime: number;
  dragging: boolean;
  /** The mouse button that started the gesture (`0` primary, `2` secondary). */
  button: number;
}

/**
 * Editor callbacks the HUD-owned editor arms on the canvas.
 *
 * While `active`, a canvas click is a placement/removal rather than the default
 * interact/move. A drag still orbits the camera, and wheel still zooms, so the
 * editor never makes the world un-navigable.
 */
export interface SceneEditorHandlers {
  /** Whether a palette selection is armed. */
  readonly active: boolean;
  /** Canvas hover (no button down) produced this pick; `null` means nothing. */
  readonly onHover: (hit: RenderPick) => void;
  /** The pointer left the canvas (no gesture); drop the hover candidate. */
  readonly onHoverEnd: () => void;
  /** A click while armed; the editor owns the placement/removal. */
  readonly onPlace: (hit: RenderPick, button: 'primary' | 'secondary') => void;
}

/**
 * Convert a client coordinate to NDC (`[-1, 1]`, origin at the canvas centre,
 * `+y` up) for the canvas' current rect. The rect origin matters: a canvas that
 * is not at the page origin must not be treated as if it were.
 */
function toNdc(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  return {
    x: ((event.clientX - rect.left) / width) * 2 - 1,
    y: -(((event.clientY - rect.top) / height) * 2 - 1),
  };
}

export function SceneView(props: {
  createRuntime?: (options: SceneViewOptions) => RenderRuntime;
  /**
   * Optional shared ref the parent uses to reach the live runtime (e.g. to read
   * the camera yaw for camera-relative input, or to zoom). Set on mount and
   * cleared on unmount.
   */
  runtimeRef?: MutableRefObject<RenderRuntime | null>;
  /** Optional in-world editor handlers armed by the HUD palettes. */
  editor?: SceneEditorHandlers;
}) {
  const { createRuntime, runtimeRef: externalRuntimeRef, editor } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const internalRuntimeRef = useRef<RenderRuntime | null>(null);
  const runtimeRef = externalRuntimeRef ?? internalRuntimeRef;
  const bridgeRef = useRef<RenderBridge | null>(null);
  const pointerRef = useRef<PointerGesture | null>(null);
  // Keep the latest handlers without re-binding the canvas event props; the
  // editor object identity changes on every parent render.
  const editorRef = useRef<SceneEditorHandlers | undefined>(editor);
  editorRef.current = editor;

  /**
   * Pick the world at this client coordinate. The pick is plain data; the bridge
   * maps a node id to a game entity id, and the Organizer owns the command. No
   * screen/NDC/camera value ever reaches a command.
   */
  function pickAt(event: { clientX: number; clientY: number }): RenderPick {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (canvas === null || runtime === null) {
      return null;
    }
    const ndc = toNdc(canvas, event);
    return runtime.pick(ndc.x, ndc.y);
  }

  /**
   * The default (non-editor) click behaviour. An entity node becomes an interact
   * intent; any other node (a block) or the ground becomes a move intent toward
   * the clicked world point. The UI applies no walkability rule.
   */
  function applyDefaultClick(hit: RenderPick): void {
    if (hit === null) {
      return;
    }
    if (hit.kind === 'node') {
      const entityId = entityIdOfNodeId(hit.nodeId);
      if (entityId !== null) {
        void interact(entityId);
        return;
      }
    }
    // Ground and non-entity node (block) hits alike carry a world point; both
    // express the same move intent.
    void moveTo(hit.point);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const editorActive = editorRef.current?.active ?? false;
    const isPrimary = event.pointerType !== 'mouse' || event.button === 0;
    const isSecondary = event.pointerType === 'mouse' && event.button === 2;
    // Outside the editor only the primary button starts a gesture. In the editor
    // the secondary button is also a placement/removal gesture.
    if (!isPrimary && !(editorActive && isSecondary)) {
      return;
    }
    const canvas = canvasRef.current;
    canvas?.setPointerCapture?.(event.pointerId);
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startTime: Date.now(),
      dragging: false,
      button: event.button,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const pointer = pointerRef.current;
    if (pointer === null) {
      // Hover (no button down): the editor may show a placement candidate.
      const activeEditor = editorRef.current;
      if (activeEditor !== undefined && activeEditor.active) {
        activeEditor.onHover(pickAt(event));
      }
      return;
    }
    if (pointer.pointerId !== event.pointerId) {
      return;
    }
    // A secondary-button gesture is a click only; it never orbits the camera.
    if (pointer.button === 2) {
      return;
    }
    let dx = event.clientX - pointer.lastX;
    pointer.lastX = event.clientX;

    const travelled = Math.hypot(
      event.clientX - pointer.startX,
      event.clientY - pointer.startY,
    );
    if (!pointer.dragging) {
      if (travelled <= CLICK_MOVE_THRESHOLD_PX) {
        // Still a candidate click: never rotate the camera on a click.
        return;
      }
      pointer.dragging = true;
      // Apply the whole travel so far so crossing the threshold does not skip the
      // rotation the user already intended.
      dx = event.clientX - pointer.startX;
    }

    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    const camera = runtime.getCameraState();
    runtime.setCameraOrientation({
      // Drag-to-orbit input policy: dragging the mouse to the RIGHT makes the
      // world appear to rotate COUNTER-CLOCKWISE seen from above (equivalently,
      // the camera orbits clockwise). The rig convention is unchanged
      // (`cameraRig.rotation.y = yaw`, screen +y is north, pitch/up basis
      // untouched); only the input-to-yaw sign is negated here, so a rightward
      // drag DECREASES yawDegrees. Camera-relative movement follows the rig yaw
      // automatically and is unaffected.
      //
      // Pitch is a FIXED composition constant and is deliberately not part of
      // `setCameraOrientation`: a vertical drag never tilts the view, so there is
      // no up/down rotation.
      yawDegrees: camera.yawDegrees - dx * DRAG_DEGREES_PER_PIXEL,
    });
  }

  function endPointer(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const pointer = pointerRef.current;
    if (pointer === null || pointer.pointerId !== event.pointerId) {
      return;
    }
    pointerRef.current = null;
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
    const travelled = Math.hypot(
      event.clientX - pointer.startX,
      event.clientY - pointer.startY,
    );
    const elapsed = Date.now() - pointer.startTime;
    const isClick =
      !pointer.dragging &&
      travelled <= CLICK_MOVE_THRESHOLD_PX &&
      elapsed <= CLICK_TIME_THRESHOLD_MS;
    if (!isClick) {
      // A drag (or a long press) never emits an intent.
      return;
    }
    const hit = pickAt(event);
    const activeEditor = editorRef.current;
    if (activeEditor !== undefined && activeEditor.active) {
      activeEditor.onPlace(hit, pointer.button === 2 ? 'secondary' : 'primary');
      return;
    }
    applyDefaultClick(hit);
  }

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
  const blockGrid = state.blockGrid;
  // A stable primitive key: a stream snapshot replaces `bounds`/`blockGrid` with
  // fresh but equal objects, and that must not tear down/rebuild the whole runtime.
  const boundsKey =
    bounds === null
      ? null
      : `${bounds.min.x},${bounds.min.y},${bounds.min.z},${bounds.max.x},${bounds.max.y},${bounds.max.z}`;
  const blockGridKey =
    blockGrid === null
      ? null
      : `${blockGrid.origin.x},${blockGrid.origin.y},${blockGrid.origin.z},${blockGrid.cellSize}`;
  const runtimeKey =
    boundsKey === null || blockGridKey === null ? null : `${boundsKey}|${blockGridKey}`;

  useEffect(() => {
    const currentBounds = stateRef.current.bounds;
    const currentBlockGrid = stateRef.current.blockGrid;
    const canvas = canvasRef.current;
    const bridge = bridgeRef.current;
    if (runtimeKey === null || currentBounds === null || currentBlockGrid === null) {
      return undefined;
    }
    if (canvas === null || bridge === null) {
      return undefined;
    }

    const factory = createRuntimeRef.current;
    const options: SceneViewOptions = { bounds: currentBounds, blockGrid: currentBlockGrid };
    const runtime =
      factory !== undefined
        ? factory(options)
        : createThreeRuntime({ bounds: currentBounds, grid: currentBlockGrid });

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
  }, [runtimeKey]);

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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={() => {
        pointerRef.current = null;
      }}
      onPointerLeave={() => {
        // Only a hover (no gesture) clears the candidate; a captured drag does
        // not lose its candidate mid-gesture.
        if (pointerRef.current === null) {
          editorRef.current?.onHoverEnd();
        }
      }}
      onContextMenu={(event) => {
        // The secondary button is the editor's "remove" gesture; suppress the
        // browser menu only while the editor is armed.
        if (editorRef.current?.active) {
          event.preventDefault();
        }
      }}
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
