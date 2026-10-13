// @vitest-environment jsdom
/**
 * Wiring tests for `SceneView` (jsdom).
 *
 * `SceneView`'s actual WebGL runtime cannot run under jsdom, so these tests
 * inject a recording `RenderRuntime` through the `createRuntime` prop and assert
 * on the *frames* it receives. That proves the Organizer -> bridge -> runtime
 * wiring (create on load, transform.setTarget on move, follow target, dispose on
 * unmount) without asserting on pixels.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadWorld,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  setMovementIntent,
  setWorldEventSource,
  setWorldFetch,
} from '../src/organizer/index.ts';
import type { EventSourceLike } from '../src/organizer/index.ts';
import type { RenderFrame } from '../src/render/bridge.ts';
import type {
  CameraState,
  RenderInspection,
  RenderPick,
  RenderRuntime,
} from '../src/render/three/runtime.ts';
import { SceneView } from '../src/ui/SceneView.tsx';
import type { SceneViewOptions } from '../src/ui/SceneView.tsx';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
const GRID = { origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 };

const ENTITY_A = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: {
    position: { x: 3, y: 0, z: 4 },
    rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
  },
  visible: true,
};

const TILES = [
  { cell: { x: 0, z: 0 }, terrain: 'grass' },
  { cell: { x: 1, z: 0 }, terrain: 'path' },
];

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  bounds: BOUNDS,
  grid: GRID,
  tiles: TILES,
  entities: [ENTITY_A],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

const MOVE_RESPONSE = {
  events: [
    {
      type: 'transform.changed',
      entityId: 'entity-a',
      transform: {
        position: { x: 4, y: 0, z: 4 },
        rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
      },
    },
  ],
  serverTime: SERVER_TIME,
};

/** Minimal `Response` stand-in: the organizer only reads `ok`, `status`, `json`. */
function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

/** A stream connection that never opens or errors, so no retry timers are armed. */
function inertEventSource(): EventSourceLike {
  return {
    onopen: null,
    onerror: null,
    addEventListener: () => {},
    close: () => {},
  };
}

interface RecordingRuntime {
  runtime: RenderRuntime;
  factory: (options: SceneViewOptions) => RenderRuntime;
  frames: RenderFrame[];
  mountCalls: number;
  disposeCalls: number;
  zoomCalls: number[];
  orientationCalls: { yawDegrees?: number }[];
  pickCalls: { x: number; y: number }[];
  /** Result the injected `pick` returns; default `null`. */
  pickResult: RenderPick;
  options: SceneViewOptions | null;
  /** Every `setFollowTarget` argument the component passed, in order. */
  followTargets: (string | null)[];
}

const CAMERA_STATE: CameraState = {
  pitchDegrees: 45,
  yawDegrees: 0,
  zoom: 1,
  focus: { x: 0, y: 0, z: 0 },
};

/** A `RenderRuntime` that records frames instead of touching WebGL. */
function createRecordingRuntime(): RecordingRuntime {
  const recorder: RecordingRuntime = {
    frames: [],
    mountCalls: 0,
    disposeCalls: 0,
    zoomCalls: [],
    orientationCalls: [],
    pickCalls: [],
    pickResult: null,
    options: null,
    followTargets: [],
    factory: undefined as unknown as RecordingRuntime['factory'],
    runtime: undefined as unknown as RenderRuntime,
  };
  let mounted = false;
  // A live rig state so a drag accumulates and `getCameraState` reflects it.
  const cameraState: CameraState = { ...CAMERA_STATE, focus: { ...CAMERA_STATE.focus } };

  recorder.runtime = {
    mount: () => {
      recorder.mountCalls += 1;
      mounted = true;
    },
    apply: (frame) => {
      recorder.frames.push(frame);
    },
    update: () => {},
    setFollowTarget: (nodeId) => {
      recorder.followTargets.push(nodeId);
    },
    getCameraState: () => ({ ...cameraState, focus: { ...cameraState.focus } }),
    setCameraOrientation: (orientation) => {
      recorder.orientationCalls.push({ ...orientation });
      if (orientation.yawDegrees !== undefined) {
        cameraState.yawDegrees = orientation.yawDegrees;
      }
    },
    setZoom: (zoom) => {
      recorder.zoomCalls.push(zoom);
      cameraState.zoom = zoom;
    },
    setGridOverlayVisible: () => {},
    setHighlightedCell: () => {},
    pick: (x, y) => {
      recorder.pickCalls.push({ x, y });
      return recorder.pickResult;
    },
    inspect: (): RenderInspection => ({
      mounted,
      lights: 0,
      ground: false,
      backdrop: null,
      background: null,
      groups: 0,
      shadow: null,
      models: 0,
      released: { geometries: 0, materials: 0, textures: 0 },
      camera: {
        fovDegrees: 28,
        near: 0.1,
        far: 100,
        aspect: 1,
        pitchDegrees: cameraState.pitchDegrees,
        yawDegrees: cameraState.yawDegrees,
        zoom: cameraState.zoom,
        focus: { ...cameraState.focus },
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
      },
      nodes: [],
      buckets: [],
      gridOverlay: {
        visible: false,
        highlightedCell: null,
        lineObjectCount: 0,
        highlightMarkerCount: 0,
      },
    }),
    dispose: () => {
      recorder.disposeCalls += 1;
      mounted = false;
    },
  };

  // Capture the authoritative extent the component passes to the factory.
  recorder.factory = (options) => {
    recorder.options = options;
    return recorder.runtime;
  };

  return recorder;
}

/**
 * A factory that hands out a *fresh* recording runtime per call, so a test can
 * observe a runtime being replaced (e.g. on a bounds change).
 */
function createRecordingRuntimeSet(): {
  runtimes: RecordingRuntime[];
  factory: (options: SceneViewOptions) => RenderRuntime;
} {
  const runtimes: RecordingRuntime[] = [];
  return {
    runtimes,
    factory: (options) => {
      const recorder = createRecordingRuntime();
      recorder.options = options;
      runtimes.push(recorder);
      return recorder.runtime;
    },
  };
}

function frameHasType(frame: RenderFrame, type: RenderFrame[number]['type']): boolean {
  return frame.some((command) => command.type === type);
}

/** All `node.create` commands recorded across every frame. */
function creates(
  recorder: RecordingRuntime,
): Extract<RenderFrame[number], { type: 'node.create' }>[] {
  return recorder.frames
    .flat()
    .filter(
      (command): command is Extract<RenderFrame[number], { type: 'node.create' }> =>
        command.type === 'node.create',
    );
}

/** A `node.create` for the given layer, or `undefined`. */
function createForLayer(
  recorder: RecordingRuntime,
  layer: 'base' | 'object',
): Extract<RenderFrame[number], { type: 'node.create' }> | undefined {
  return creates(recorder).find((command) => command.layer === layer);
}

/** Stateful fetch: the snapshot for GET, a move ack for POST. */
function installWorldFetch(): void {
  setWorldFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      return fakeResponse(MOVE_RESPONSE);
    }
    return fakeResponse(VALID_WORLD_RESPONSE);
  });
}

interface CapturedRequest {
  method: string | undefined;
  body: unknown;
}

/** Capture POST bodies (Organizer intents) while still serving the snapshot. */
function captureWorldFetch(requests: CapturedRequest[]): void {
  setWorldFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      requests.push({
        method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return fakeResponse(MOVE_RESPONSE);
    }
    return fakeResponse(VALID_WORLD_RESPONSE);
  });
}

/** A fixed canvas rect so client -> NDC conversion is deterministic under jsdom. */
function fixedCanvasRect(): DOMRect {
  return {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    width: 200,
    height: 100,
    right: 210,
    bottom: 120,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
  setWorldEventSource(inertEventSource);
});

afterEach(() => {
  cleanup();
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
});

describe('SceneView wiring', () => {
  it('mounts the runtime and pushes base-layer tile creates plus an object-layer actor node', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);

    await waitFor(() => {
      const sawCreate = recorder.frames.some((frame) => frameHasType(frame, 'node.create'));
      expect(sawCreate).toBe(true);
    });
    expect(recorder.mountCalls).toBe(1);

    // Tiles arrive as base-layer nodes at their derived world positions with
    // terrain-derived appearances; the actor arrives with its authoritative 3D
    // transform.
    const base = createForLayer(recorder, 'base');
    expect(base).toMatchObject({
      nodeId: 'tile:0,0',
      layer: 'base',
      appearance: 'appearance.terrain.grass',
      transform: expect.objectContaining({ position: { x: -4.5, y: 0, z: -4.5 } }),
    });
    expect(createForLayer(recorder, 'object')).toMatchObject({
      nodeId: 'entity:entity-a',
      layer: 'object',
      appearance: 'appearance.character',
      transform: expect.objectContaining({
        position: { x: 3, y: 0, z: 4 },
        rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
      }),
    });
    expect(creates(recorder)).toHaveLength(3);
  });

  it('creates the runtime with the authoritative bounds once the world is ready', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();

    // Before the world is known the canvas renders but no runtime is created.
    render(<SceneView createRuntime={recorder.factory} />);
    expect(recorder.mountCalls).toBe(0);
    expect(recorder.options).toBeNull();
    expect(screen.getByTestId('scene-canvas')).toBeTruthy();

    await act(async () => {
      await loadWorld();
    });

    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });
    expect(recorder.options).toEqual({ bounds: BOUNDS, grid: GRID });
  });

  it('pushes transform.setTarget after the controlled actor moves', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);
    await waitFor(() => {
      expect(recorder.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
    });

    await act(async () => {
      await setMovementIntent({ x: 1, z: 0 });
    });

    await waitFor(() => {
      const sawTarget = recorder.frames.some((frame) => frameHasType(frame, 'transform.setTarget'));
      expect(sawTarget).toBe(true);
    });
  });

  it('wires the camera follow target from controlledActorId', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();

    // Before the world is ready there is no runtime, so nothing is followed.
    render(<SceneView createRuntime={recorder.factory} />);
    expect(recorder.followTargets).toEqual([]);

    await act(async () => {
      await loadWorld();
    });

    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });
    // The bridge owns node id namespacing; the UI only passes the id through.
    expect(recorder.followTargets.at(-1)).toBe('entity:entity-a');
  });

  it('sets a null follow target when the caller controls no actor', async () => {
    const recorder = createRecordingRuntime();
    const noActorSnapshot = { ...VALID_SNAPSHOT, controlledActorId: null };
    setWorldFetch(async () => fakeResponse({ world: noActorSnapshot }));
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);

    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });
    expect(recorder.followTargets.at(-1)).toBeNull();
  });

  it('disposes the runtime on unmount', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await act(async () => {
      await loadWorld();
    });

    const { unmount } = render(<SceneView createRuntime={recorder.factory} />);
    expect(recorder.disposeCalls).toBe(0);

    unmount();

    expect(recorder.disposeCalls).toBe(1);
  });

  it('zooms the camera on wheel without knowing Three.js', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);
    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });

    fireEvent.wheel(screen.getByTestId('scene-canvas'), { deltaY: -100 });
    expect(recorder.zoomCalls.at(-1)).toBeGreaterThan(1);

    const afterZoomIn = recorder.zoomCalls.at(-1) ?? 1;
    fireEvent.wheel(screen.getByTestId('scene-canvas'), { deltaY: 100 });
    expect(recorder.zoomCalls.at(-1)).toBeLessThan(afterZoomIn);
  });

  it('tears down and re-creates the runtime exactly once when the world bounds change', async () => {
    const set = createRecordingRuntimeSet();
    installWorldFetch();
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={set.factory} />);
    await waitFor(() => {
      expect(set.runtimes).toHaveLength(1);
    });
    const first = set.runtimes[0];
    expect(first.options).toEqual({ bounds: BOUNDS, grid: GRID });
    // The new world is pushed through the bridge into the first runtime.
    expect(first.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
    expect(first.disposeCalls).toBe(0);

    // Reload with a DIFFERENT authoritative extent. `SceneView` keys its mount
    // effect on the bounds signature, so this must swap the runtime.
    const smallerBounds = { min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 4, z: 3 } };
    const smallerSnapshot = { ...VALID_SNAPSHOT, bounds: smallerBounds };
    setWorldFetch(async (_url, init) => {
      if (init?.method === 'POST') {
        return fakeResponse(MOVE_RESPONSE);
      }
      return fakeResponse({ world: smallerSnapshot });
    });
    await act(async () => {
      // Reset first so a live/connecting stream from the first load does not
      // make `loadWorld` a no-op.
      resetWorldState();
      await loadWorld();
    });

    await waitFor(() => {
      expect(set.runtimes).toHaveLength(2);
    });
    expect(first.disposeCalls).toBe(1);

    const second = set.runtimes[1];
    expect(second.options).toEqual({ bounds: smallerBounds, grid: GRID });
    expect(second.mountCalls).toBe(1);
    // The scene is not left doubled: the live runtime is the second one, and the
    // swap reset the bridge and re-pushed the new world (fresh `node.create`).
    expect(second.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
  });
});

describe('SceneView mouse-first interaction', () => {
  /** Mount SceneView with a loaded world and a recording runtime. */
  async function mountWithRuntime(
    recorder: RecordingRuntime,
    requests: CapturedRequest[],
  ): Promise<HTMLElement> {
    captureWorldFetch(requests);
    await act(async () => {
      await loadWorld();
    });
    render(<SceneView createRuntime={recorder.factory} />);
    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });
    const canvas = screen.getByTestId('scene-canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(fixedCanvasRect());
    return canvas;
  }

  it('converts a click to NDC for the canvas rect and maps a picked node to interact', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'node', nodeId: 'entity:entity-a' as never };
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    // Client (110, 70) inside rect {left:10, top:20, 200x100} -> NDC (0, 0).
    fireEvent.pointerDown(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(recorder.pickCalls).toHaveLength(1);
    // NDC y can be signed zero at the centre; compare numerically.
    expect(recorder.pickCalls[0].x).toBeCloseTo(0, 9);
    expect(recorder.pickCalls[0].y).toBeCloseTo(0, 9);
    // The bridge owns the nodeId<->entityId convention; the UI only forwards it.
    expect(requests[0].body).toEqual({ type: 'actor.interact', targetEntityId: 'entity-a' });
  });

  it('maps a ground click to a world-space moveTo intent', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 1.5, y: 0, z: -2.25 } };
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    fireEvent.pointerDown(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // Only the world-space point crosses the boundary; no camera/NDC key does.
    expect(requests[0].body).toEqual({
      type: 'actor.moveTo',
      target: { x: 1.5, y: 0, z: -2.25 },
    });
  });

  it('does nothing for a click that picks nothing', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = null;
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    fireEvent.pointerDown(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(0);
    expect(recorder.pickCalls).toHaveLength(1);
  });

  it('rotates the rig on a drag and never emits an intent', async () => {
    const recorder = createRecordingRuntime();
    // If a drag wrongly clicked, this would produce an intent.
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, pointerId: 2, button: 0 });
    // Travel > click threshold: this is a camera drag.
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 2, button: 0 });

    await waitFor(() => {
      expect(recorder.orientationCalls.length).toBeGreaterThan(0);
    });
    const last = recorder.orientationCalls.at(-1);
    // Drag input policy (phase 11): a rightward drag makes the world rotate
    // counter-clockwise from above, which is a DECREASE of the rig yaw
    // (yaw -= 60px * 0.3deg). Pitch is FIXED (45) and is not an input at all, so
    // a vertical drag component never tilts the view.
    expect(last?.yawDegrees).toBeCloseTo(-18, 6);
    expect(recorder.runtime.getCameraState().pitchDegrees).toBe(CAMERA_STATE.pitchDegrees);
    // A drag must never pick or emit.
    expect(recorder.pickCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('pins the drag-to-orbit yaw convention: right = world counter-clockwise from above', async () => {
    const recorder = createRecordingRuntime();
    // If a drag wrongly clicked, this would produce an intent.
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    // The rig keeps `cameraRig.rotation.y = yawDegrees` and screen +y as north.
    // A POSITIVE rig yaw turns the view clockwise from above (the behaviour the
    // user reported as unnatural), so making a rightward drag feel
    // counter-clockwise requires it to DECREASE yawDegrees. A leftward drag is
    // the exact inverse. Measure the delta from the live rig so the two gestures
    // are compared on equal footing even though the mock state accumulates.
    async function yawDeltaForDrag(deltaX: number, pointerId: number): Promise<number> {
      recorder.orientationCalls.length = 0;
      const start = recorder.runtime.getCameraState().yawDegrees;
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 60, pointerId, button: 0 });
      fireEvent.pointerMove(canvas, { clientX: 100 + deltaX, clientY: 60, pointerId });
      fireEvent.pointerUp(canvas, { clientX: 100 + deltaX, clientY: 60, pointerId, button: 0 });
      await waitFor(() => {
        expect(recorder.orientationCalls.length).toBeGreaterThan(0);
      });
      return (recorder.orientationCalls.at(-1)?.yawDegrees ?? NaN) - start;
    }

    const rightDelta = await yawDeltaForDrag(60, 11);
    const leftDelta = await yawDeltaForDrag(-60, 12);

    // Rightward drag: yaw decreases (world rotates counter-clockwise from above).
    expect(rightDelta).toBeCloseTo(-18, 6);
    // Leftward drag: exactly the inverse.
    expect(leftDelta).toBeCloseTo(18, 6);
    expect(rightDelta + leftDelta).toBeCloseTo(0, 6);
    // A drag still never emits an intent.
    expect(recorder.pickCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('keeps a tiny movement within the click threshold a click, not a drag', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    const canvas = await mountWithRuntime(recorder, requests);

    fireEvent.pointerDown(canvas, { clientX: 110, clientY: 70, pointerId: 1, button: 0 });
    // 3px of drift is within the 5px click threshold.
    fireEvent.pointerMove(canvas, { clientX: 113, clientY: 72, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 113, clientY: 72, pointerId: 1, button: 0 });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // A click never rotates the camera.
    expect(recorder.orientationCalls).toHaveLength(0);
    expect(requests[0].body).toEqual({
      type: 'actor.moveTo',
      target: { x: 0, y: 0, z: 0 },
    });
  });
});
