// @vitest-environment jsdom
/**
 * Wiring tests for `SceneView` (jsdom).
 *
 * `SceneView`'s actual WebGL runtime cannot run under jsdom, so these tests
 * inject a recording `RenderRuntime` through the `createRuntime` prop and assert
 * on the *frames* it receives. That proves the Organizer -> bridge -> runtime
 * wiring (create on load, transform.setTarget on move, dispose on unmount)
 * without asserting on pixels.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadWorld,
  moveActor,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldFetch,
  resetWorldState,
  setWorldFetch,
} from '../src/organizer/index.ts';
import type { RenderFrame } from '../src/render/bridge.ts';
import type { RenderInspection, RenderRuntime } from '../src/render/three/runtime.ts';
import { SceneView } from '../src/ui/SceneView.tsx';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

const ENTITY_A = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: { x: 3, y: 4 },
  visible: true,
};

const TILES = [
  { transform: { x: 0, y: 0 }, terrain: 'grass' },
  { transform: { x: 1, y: 0 }, terrain: 'path' },
];

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  size: { width: 10, height: 8 },
  tiles: TILES,
  entities: [ENTITY_A],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

/** Minimal `Response` stand-in: the organizer only reads `ok`, `status`, `json`. */
function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

interface RecordingRuntime {
  runtime: RenderRuntime;
  factory: (options: { worldSize: { width: number; height: number } }) => RenderRuntime;
  frames: RenderFrame[];
  mountCalls: number;
  disposeCalls: number;
  options: { worldSize: { width: number; height: number } } | null;
}

/** A `RenderRuntime` that records frames instead of touching WebGL. */
function createRecordingRuntime(): RecordingRuntime {
  const recorder: RecordingRuntime = {
    frames: [],
    mountCalls: 0,
    disposeCalls: 0,
    options: null,
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
    inspect: (): RenderInspection => ({
      mounted,
      lights: 0,
      ground: false,
      camera: { left: 0, right: 0, top: 0, bottom: 0 },
      nodes: [],
      buckets: [],
    }),
    dispose: () => {
      recorder.disposeCalls += 1;
      mounted = false;
    },
  };

  // Capture the authoritative size the component passes to the factory.
  recorder.factory = (options) => {
    recorder.options = options;
    return recorder.runtime;
  };

  return recorder;
}

/**
 * A factory that hands out a *fresh* recording runtime per call, so a test can
 * observe a runtime being replaced (e.g. on a world-size change) rather than a
 * single recorder being reused.
 */
function createRecordingRuntimeSet(): {
  runtimes: RecordingRuntime[];
  factory: (options: { worldSize: { width: number; height: number } }) => RenderRuntime;
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

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
  resetGameInfoState();
  resetGameInfoFetch();
});

afterEach(() => {
  cleanup();
  resetWorldState();
  resetWorldFetch();
  resetGameInfoState();
  resetGameInfoFetch();
});

describe('SceneView wiring', () => {
  it('mounts the runtime and pushes base-layer tile creates plus an object-layer actor node', async () => {
    const recorder = createRecordingRuntime();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);

    await waitFor(() => {
      const sawCreate = recorder.frames.some((frame) => frameHasType(frame, 'node.create'));
      expect(sawCreate).toBe(true);
    });
    expect(recorder.mountCalls).toBe(1);

    // Tiles arrive as base-layer nodes with namespaced ids and terrain-derived
    // appearances; the actor arrives as an object-layer node.
    const base = createForLayer(recorder, 'base');
    expect(base).toMatchObject({
      nodeId: 'tile:0,0',
      layer: 'base',
      appearance: 'appearance.terrain.grass',
      transform: { x: 0, y: 0 },
    });
    expect(createForLayer(recorder, 'object')).toMatchObject({
      nodeId: 'entity:entity-a',
      layer: 'object',
      appearance: 'appearance.character',
      transform: { x: 3, y: 4 },
    });
    expect(creates(recorder)).toHaveLength(3);
  });

  it('creates the runtime with the authoritative world size once the world is ready', async () => {
    const recorder = createRecordingRuntime();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));

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
    expect(recorder.options).toEqual({ worldSize: { width: 10, height: 8 } });
  });

  it('pushes transform.setTarget after the controlled actor moves', async () => {
    const recorder = createRecordingRuntime();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={recorder.factory} />);
    await waitFor(() => {
      expect(recorder.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
    });

    setWorldFetch(async () =>
      fakeResponse({
        events: [{ type: 'transform.changed', entityId: 'entity-a', transform: { x: 4, y: 4 } }],
        serverTime: SERVER_TIME,
      }),
    );
    await act(async () => {
      await moveActor('east');
    });

    await waitFor(() => {
      const sawTarget = recorder.frames.some((frame) => frameHasType(frame, 'transform.setTarget'));
      expect(sawTarget).toBe(true);
    });
  });

  it('disposes the runtime on unmount', async () => {
    const recorder = createRecordingRuntime();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await act(async () => {
      await loadWorld();
    });

    const { unmount } = render(<SceneView createRuntime={recorder.factory} />);
    expect(recorder.disposeCalls).toBe(0);

    unmount();

    expect(recorder.disposeCalls).toBe(1);
  });

  it('tears down and re-creates the runtime exactly once when the world size changes', async () => {
    const set = createRecordingRuntimeSet();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await act(async () => {
      await loadWorld();
    });

    render(<SceneView createRuntime={set.factory} />);
    await waitFor(() => {
      expect(set.runtimes).toHaveLength(1);
    });
    const first = set.runtimes[0];
    expect(first.options).toEqual({ worldSize: { width: 10, height: 8 } });
    // The new world is pushed through the bridge into the first runtime.
    expect(first.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
    expect(first.disposeCalls).toBe(0);

    // Reload with a DIFFERENT authoritative size. `SceneView` keys its mount
    // effect on [worldWidth, worldHeight], so this must swap the runtime.
    const smallerSnapshot = { ...VALID_SNAPSHOT, size: { width: 6, height: 6 } };
    setWorldFetch(async () => fakeResponse({ world: smallerSnapshot }));
    await act(async () => {
      await loadWorld();
    });

    await waitFor(() => {
      expect(set.runtimes).toHaveLength(2);
    });
    // Exactly one teardown of the old runtime and one creation of the new one.
    expect(set.runtimes).toHaveLength(2);
    expect(first.disposeCalls).toBe(1);

    const second = set.runtimes[1];
    expect(second.options).toEqual({ worldSize: { width: 6, height: 6 } });
    expect(second.mountCalls).toBe(1);
    // The scene is not left doubled: the live runtime is the second one, and the
    // swap reset the bridge and re-pushed the new world (fresh `node.create`).
    expect(second.frames.some((frame) => frameHasType(frame, 'node.create'))).toBe(true);
  });
});
