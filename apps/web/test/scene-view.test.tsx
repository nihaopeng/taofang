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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  options: SceneViewOptions | null;
  /** Every `setFollowTarget` argument the component passed, in order. */
  followTargets: (string | null)[];
}

const CAMERA_STATE: CameraState = {
  pitchDegrees: 58,
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
    options: null,
    followTargets: [],
    factory: undefined as unknown as RecordingRuntime['factory'],
    runtime: undefined as unknown as RenderRuntime,
  };
  let mounted = false;

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
    getCameraState: () => CAMERA_STATE,
    setCameraOrientation: () => {},
    setZoom: (zoom) => {
      recorder.zoomCalls.push(zoom);
    },
    inspect: (): RenderInspection => ({
      mounted,
      lights: 0,
      ground: false,
      background: null,
      groups: 0,
      shadow: null,
      camera: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        pitchDegrees: 58,
        yawDegrees: 0,
        zoom: 1,
        focus: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
      },
      nodes: [],
      buckets: [],
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
    expect(recorder.options).toEqual({ bounds: BOUNDS });
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

    fireEvent.wheel(screen.getByTestId('scene-canvas'), { deltaY: 100 });
    expect(recorder.zoomCalls.at(-1)).toBeLessThan(1);
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
    expect(first.options).toEqual({ bounds: BOUNDS });
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
    expect(second.options).toEqual({ bounds: smallerBounds });
    expect(second.mountCalls).toBe(1);
    // The scene is not left doubled: the live runtime is the second one, and the
    // swap reset the bridge and re-pushed the new world (fresh `node.create`).
    expect(second.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
  });
});
