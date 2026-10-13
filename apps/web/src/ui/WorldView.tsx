import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cellOfWorldPoint,
  loadWorld,
  placeEntity,
  removeBlock,
  setBlock,
  setMovementIntent,
  snapPlacementCentre,
  useGameInfo,
  useWorld,
  validatePlacement,
} from '../organizer';
import type {
  BlockGridViewModel,
  BlockKindInfoViewModel,
  CellCoordViewModel,
  EntityKindInfoViewModel,
  PlacementValidationViewModel,
} from '../organizer';
import { blockCellOfNodeId } from '../render/bridge';
import { RENDER_CAMERA } from '../render/three/runtime';
import type { RenderPick, RenderRuntime } from '../render/three/runtime';
import { EditorPalette } from './EditorPalette';
import { Hud } from './Hud';
import { SceneView } from './SceneView';
import type { SceneEditorHandlers, SceneViewOptions } from './SceneView';
import { createMovementController } from './movement-input';
import type { MovementController, MovementKey } from './movement-input';
import { BLOCK_YAW_STEPS, buildGhostSpec, nextYawStep, yawQuat } from './editor-state';
import type { EditorSelection, GhostCandidate } from './editor-state';
import { createPlacementPreview } from './placement-preview';
import type { PlacementPreview } from './placement-preview';

/** Stable empty catalogues so the palettes stay reference-stable before game info loads. */
const EMPTY_BLOCK_KINDS: readonly BlockKindInfoViewModel[] = Object.freeze([]);
const EMPTY_ENTITY_KINDS: readonly EntityKindInfoViewModel[] = Object.freeze([]);

/**
 * Resolve the block cell a pick targets: an existing block node names its own
 * cell, otherwise the picked world point is resolved to a cell by the Organizer's
 * shared `cellOfWorldPoint` (the UI may not import the game protocol, and must
 * not re-derive the cell rule).
 */
function resolveBlockCell(hit: RenderPick, grid: BlockGridViewModel): CellCoordViewModel | null {
  if (hit === null) {
    return null;
  }
  if (hit.kind === 'node') {
    const cell = blockCellOfNodeId(hit.nodeId);
    if (cell !== null) {
      return cell;
    }
  }
  return cellOfWorldPoint(grid, hit.point);
}

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
  // Latest state for the stable editor callbacks, which must not re-create on
  // every state change.
  const stateRef = useRef(state);
  stateRef.current = state;

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

  // --- In-world editor (presentation + Organizer intents) --------------------
  //
  // The palettes are driven by the static game-info catalogues. Selection is
  // purely presentational; the ONLY rules that decide a placement are the
  // server's `entity.validatePlacement` verdict (shown on the ghost) and the
  // Manager's re-validation of the final command. No client code decides
  // support, occupancy, terrain permission or permissions.
  const gameInfo = useGameInfo();
  const blockKinds = gameInfo.data?.blockKinds ?? EMPTY_BLOCK_KINDS;
  const entityKinds = gameInfo.data?.entityKinds ?? EMPTY_ENTITY_KINDS;

  const [editorSelection, setEditorSelection] = useState<EditorSelection>({ mode: 'none' });
  const editorSelectionRef = useRef<EditorSelection>(editorSelection);
  editorSelectionRef.current = editorSelection;
  const [editorVerdict, setEditorVerdict] = useState<PlacementValidationViewModel | null>(null);

  const blockKindsRef = useRef(blockKinds);
  blockKindsRef.current = blockKinds;
  const entityKindsRef = useRef(entityKinds);
  entityKindsRef.current = entityKinds;

  // The pending candidate the ghost draws, and the target cell a block click
  // would edit. Refs (not state) because pointer motion must not re-render.
  const candidateRef = useRef<GhostCandidate | null>(null);
  const blockCellRef = useRef<CellCoordViewModel | null>(null);
  const verdictRef = useRef<PlacementValidationViewModel | null>(null);
  const lastHitRef = useRef<RenderPick>(null);

  const pushGhost = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    const candidate = candidateRef.current;
    runtime.setPlacementGhost(
      candidate === null ? null : buildGhostSpec(candidate, verdictRef.current),
    );
  }, []);
  const pushGhostRef = useRef(pushGhost);
  pushGhostRef.current = pushGhost;

  // One preview controller per instance. It requests a server verdict ONLY when
  // the candidate (kind + yaw + snapped position) changes and discards stale
  // answers, so pointer motion inside one cell never re-asks.
  const previewRef = useRef<PlacementPreview | null>(null);
  if (previewRef.current === null) {
    previewRef.current = createPlacementPreview({
      validate: (kind, position, yawDegrees) => validatePlacement(kind, position, yawDegrees),
      onVerdict: (verdict) => {
        verdictRef.current = verdict;
        setEditorVerdict(verdict);
        pushGhostRef.current();
      },
    });
  }

  /**
   * Resolve a hover/click pick into a candidate, push the ghost, and (for
   * entities) ask for a server verdict. Reads the current selection from a ref so
   * it stays stable across pointer motion.
   */
  const updateEditorFromHit = useCallback((hit: RenderPick): void => {
    lastHitRef.current = hit;
    const grid = stateRef.current.blockGrid;
    const selection = editorSelectionRef.current;
    if (grid === null || hit === null || selection.mode === 'none') {
      candidateRef.current = null;
      blockCellRef.current = null;
      verdictRef.current = null;
      previewRef.current?.clear();
      pushGhostRef.current();
      return;
    }

    if (selection.mode === 'block') {
      const cell = resolveBlockCell(hit, grid);
      blockCellRef.current = cell;
      verdictRef.current = null;
      candidateRef.current =
        cell === null
          ? null
          : {
              // Pure catalogue geometry aligned with the shared snap helper. A
              // block is a one-cell volume; the y is the picked point.
              position: snapPlacementCentre({ ...hit.point }, { x: 1, z: 1 }, grid),
              rotation: yawQuat(selection.orientation),
              footprintX: 1,
              footprintZ: 1,
              height: grid.cellSize,
            };
      // Blocks are not preview-validated: the Manager decides on `block.set`.
      previewRef.current?.clear();
      pushGhostRef.current();
      return;
    }

    // Entity: the palette's catalogue geometry aligned by the shared snap helper.
    blockCellRef.current = null;
    const info = entityKindsRef.current.find((kind) => kind.kind === selection.kind);
    if (info === undefined) {
      candidateRef.current = null;
      verdictRef.current = null;
      previewRef.current?.clear();
      pushGhostRef.current();
      return;
    }
    const position = snapPlacementCentre(
      { ...hit.point },
      { x: info.footprintX, z: info.footprintZ },
      grid,
    );
    candidateRef.current = {
      position,
      rotation: yawQuat(selection.yawDegrees),
      footprintX: info.footprintX,
      footprintZ: info.footprintZ,
      height: info.height,
    };
    previewRef.current?.setCandidate({
      kind: selection.kind,
      position,
      yawDegrees: selection.yawDegrees,
    });
  }, []);

  const handleHoverEnd = useCallback((): void => {
    lastHitRef.current = null;
    candidateRef.current = null;
    blockCellRef.current = null;
    verdictRef.current = null;
    setEditorVerdict(null);
    previewRef.current?.clear();
    pushGhostRef.current();
  }, []);

  /** Send the authoritative edit intent. The preview verdict is never authority. */
  const commitPlacement = useCallback((button: 'primary' | 'secondary'): void => {
    const selection = editorSelectionRef.current;
    const grid = stateRef.current.blockGrid;
    if (grid === null || selection.mode === 'none') {
      return;
    }
    if (selection.mode === 'block') {
      const cell = blockCellRef.current;
      if (cell === null) {
        return;
      }
      if (button === 'secondary' || selection.kind === 'air') {
        void removeBlock(cell);
        return;
      }
      void setBlock(cell, selection.kind, selection.orientation);
      return;
    }
    // Entity placement: the Manager re-validates and owns the committed
    // transform. A right click is not an entity-removal affordance.
    if (button === 'secondary') {
      return;
    }
    const candidate = candidateRef.current;
    if (candidate === null) {
      return;
    }
    void placeEntity(selection.kind, candidate.position, selection.yawDegrees);
  }, []);

  /**
   * A canvas click while armed: resolve the target (a touch click has no prior
   * hover) and send the edit intent. The commit is unconditional on the preview
   * verdict, because the Manager re-validates.
   */
  const handleEditorPlace = useCallback(
    (hit: RenderPick, button: 'primary' | 'secondary'): void => {
      updateEditorFromHit(hit);
      commitPlacement(button);
    },
    [updateEditorFromHit, commitPlacement],
  );

  const selectBlock = useCallback(
    (kind: string): void => {
      const current = editorSelectionRef.current;
      const next: EditorSelection =
        current.mode === 'block' && current.kind === kind
          ? { mode: 'none' }
          : { mode: 'block', kind, orientation: 0 };
      editorSelectionRef.current = next;
      setEditorSelection(next);
      updateEditorFromHit(lastHitRef.current);
    },
    [updateEditorFromHit],
  );

  const selectEntity = useCallback(
    (kind: string): void => {
      const current = editorSelectionRef.current;
      const next: EditorSelection =
        current.mode === 'entity' && current.kind === kind
          ? { mode: 'none' }
          : { mode: 'entity', kind, yawDegrees: 0 };
      editorSelectionRef.current = next;
      setEditorSelection(next);
      updateEditorFromHit(lastHitRef.current);
    },
    [updateEditorFromHit],
  );

  const clearSelection = useCallback((): void => {
    editorSelectionRef.current = { mode: 'none' };
    setEditorSelection({ mode: 'none' });
    updateEditorFromHit(lastHitRef.current);
  }, [updateEditorFromHit]);

  /**
   * `R`: advance orientation ONLY when the selected kind actually offers a
   * choice (an orientable block, or an entity with more than one yaw step). A
   * non-directional block is untouched, which is exactly "harmless for the rest".
   */
  const rotateSelection = useCallback((): void => {
    const selection = editorSelectionRef.current;
    let next: EditorSelection | null = null;
    if (selection.mode === 'block') {
      const info = blockKindsRef.current.find((kind) => kind.kind === selection.kind);
      if (info?.orientable === true) {
        next = {
          mode: 'block',
          kind: selection.kind,
          orientation: nextYawStep(selection.orientation, BLOCK_YAW_STEPS),
        };
      }
    } else if (selection.mode === 'entity') {
      const info = entityKindsRef.current.find((kind) => kind.kind === selection.kind);
      if (info !== undefined && info.allowedYawSteps.length > 1) {
        next = {
          mode: 'entity',
          kind: selection.kind,
          yawDegrees: nextYawStep(selection.yawDegrees, info.allowedYawSteps),
        };
      }
    }
    if (next === null) {
      return;
    }
    editorSelectionRef.current = next;
    setEditorSelection(next);
    // Re-resolve the ghost/verdict for the new orientation without waiting for a
    // pointer move.
    updateEditorFromHit(lastHitRef.current);
  }, [updateEditorFromHit]);

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
      if (
        (event.key === 'r' || event.key === 'R') &&
        editorSelectionRef.current.mode !== 'none'
      ) {
        // Editor orientation shortcut. Presentation only until a command is sent;
        // a kind with no orientation choice is left untouched.
        event.preventDefault();
        rotateSelection();
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
  }, [toggleGridOverlay, rotateSelection]);

  // Keep the runtime's grid layer in sync with the presentational toggle. The
  // runtime is created by the child `SceneView`, whose effect runs first, so when
  // the world becomes ready this re-applies the (default hidden) state to it. A
  // runtime (re)creation also resets the rig pitch to the default, so mirror the
  // live pitch here rather than letting the settings panel show a stale value.
  // The placement ghost is re-pushed for the same reason: a fresh runtime has no
  // ghost, so an armed editor must redraw its current candidate on it.
  useEffect(() => {
    const runtime = runtimeRef.current;
    runtime?.setGridOverlayVisible(gridOverlayVisibleRef.current);
    if (runtime !== null) {
      setPitchDegrees(runtime.getCameraState().pitchDegrees);
    }
    pushGhost();
  }, [state, pushGhost]);

  // The controlled entity is the one linked to the controlled actor. It is
  // derived from Organizer state; the UI invents no identity of its own.
  const controlledEntity =
    controlledActorId === null
      ? null
      : (entities.find((entity) => entity.actorId === controlledActorId) ?? null);

  // HUD-owned editor handlers armed on the canvas. A new object per render is
  // fine: `SceneView` keeps the latest one in a ref.
  const editorHandlers: SceneEditorHandlers = {
    active: editorSelection.mode !== 'none',
    onHover: updateEditorFromHit,
    onHoverEnd: handleHoverEnd,
    onPlace: handleEditorPlace,
  };

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
        <SceneView runtimeRef={runtimeRef} createRuntime={createRuntime} editor={editorHandlers} />
        <Hud
          streamStatus={streamStatus}
          notice={notice}
          pitchDegrees={pitchDegrees}
          pitchRange={{ min: RENDER_CAMERA.minPitchDegrees, max: RENDER_CAMERA.maxPitchDegrees }}
          defaultPitchDegrees={RENDER_CAMERA.pitchDegrees}
          onPitchChange={applyPitch}
          editor={
            <EditorPalette
              blockKinds={blockKinds}
              entityKinds={entityKinds}
              selection={editorSelection}
              verdict={editorVerdict}
              onSelectBlock={selectBlock}
              onSelectEntity={selectEntity}
              onClear={clearSelection}
              onPlace={() => {
                commitPlacement('primary');
              }}
              onRotate={rotateSelection}
            />
          }
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
