// @vitest-environment jsdom
/**
 * In-world editor tests (jsdom).
 *
 * The editor lives in the HUD and drives the canvas' pick path. These tests
 * mount `<WorldView />` with a recording `RenderRuntime` (no WebGL) and assert:
 *
 *  - both palettes are derived from the game-info catalogues (not hardcoded);
 *  - a block click emits `block.set` for the picked cell and a right click emits
 *    `block.remove`;
 *  - `R` changes orientation ONLY for directional kinds;
 *  - the entity ghost asks the server to validate ONLY when the candidate
 *    changes, discards stale answers, and takes its colour strictly from the
 *    server verdict;
 *  - Place sends the command regardless of the preview verdict;
 *  - palette controls do not steal canvas input and the keyboard isolation
 *    guarantee still holds.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadGameInfo,
  loadWorld,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setWorldEventSource,
  setWorldFetch,
} from '../src/organizer/index.ts';
import type { EventSourceLike } from '../src/organizer/index.ts';
import type {
  CameraState,
  PlacementGhost,
  RenderInspection,
  RenderPick,
  RenderRuntime,
} from '../src/render/three/runtime.ts';
import type { SceneViewOptions } from '../src/ui/SceneView.tsx';
import { WorldView } from '../src/ui/WorldView.tsx';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';
const ARBITRARY_PROTOCOL_VERSION = 1;

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
const BLOCK_GRID = { origin: { x: -5, y: 0, z: -5 }, cellSize: 1 };

const BLOCK_KINDS = [
  { kind: 'air', orientable: false },
  { kind: 'grass', orientable: false },
  { kind: 'soil', orientable: false },
  { kind: 'stone', orientable: false },
  { kind: 'path', orientable: false },
  { kind: 'water', orientable: false },
  { kind: 'slab', orientable: false },
  { kind: 'stairs', orientable: true },
  { kind: 'ramp', orientable: true },
] as const;

const ENTITY_KINDS = [
  {
    kind: 'character',
    footprintX: 1,
    footprintZ: 1,
    height: 1.8,
    allowedYawSteps: [0, 90, 180, 270],
    pivot: 'center',
  },
  {
    kind: 'tree',
    footprintX: 1,
    footprintZ: 1,
    height: 2.5,
    allowedYawSteps: [0],
    pivot: 'center',
  },
  {
    kind: 'rock',
    footprintX: 1,
    footprintZ: 1,
    height: 0.6,
    allowedYawSteps: [0, 90, 180, 270],
    pivot: 'center',
  },
  {
    kind: 'chest',
    footprintX: 1,
    footprintZ: 1,
    height: 0.7,
    allowedYawSteps: [0, 90, 180, 270],
    pivot: 'center',
  },
  {
    kind: 'building',
    footprintX: 2,
    footprintZ: 2,
    height: 3,
    allowedYawSteps: [0, 90, 180, 270],
    pivot: 'center',
  },
] as const;

const VALID_GAME_INFO_RESPONSE = {
  gameInfo: {
    gameName: 'Starvalley',
    serverVersion: '0.1.0',
    protocolVersion: ARBITRARY_PROTOCOL_VERSION,
    serverTime: SERVER_TIME,
  },
  blockKinds: BLOCK_KINDS,
  entityKinds: ENTITY_KINDS,
};

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  bounds: BOUNDS,
  blockGrid: BLOCK_GRID,
  // A block exists at cell (0, 0, 0) so a client MIGHT think that cell is
  // occupied; the server is still the only authority on legality.
  blocks: [{ coord: { x: 0, y: 0, z: 0 }, kind: 'grass', orientation: 0 }],
  entities: [],
  controlledActorId: null,
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

/** A stream connection that opens on the next tick so `streamStatus` reaches `live`. */
function openingEventSource(): EventSourceLike {
  const source: EventSourceLike = {
    onopen: null,
    onerror: null,
    addEventListener: () => {},
    close: () => {},
  };
  setTimeout(() => {
    source.onopen?.(undefined);
  }, 0);
  return source;
}

interface RecordedRequest {
  type: string;
  [key: string]: unknown;
}

/** A valid `ValidatePlacementResponse`-shaped body. */
function validateVerdict(
  valid: boolean,
  options: {
    reason?: string;
    occupied?: { x: number; y: number; z: number }[];
    resolved?: { x: number; y: number; z: number };
  } = {},
): Record<string, unknown> {
  return {
    valid,
    reason: valid ? null : (options.reason ?? 'not allowed'),
    occupiedCells: options.occupied ?? [],
    resolvedTransform: valid
      ? {
          position: options.resolved ?? { x: 0.5, y: 0, z: 0.5 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        }
      : null,
  };
}

// --- Fetch harness ---------------------------------------------------------

let validateBodies: RecordedRequest[] = [];
let commandBodies: RecordedRequest[] = [];
let validateHandler: (
  body: RecordedRequest,
  index: number,
) => unknown | Promise<unknown> = () => validateVerdict(true);

function installWorldFetch(): void {
  setWorldFetch(async (_url, init) => {
    if (init?.method !== 'POST') {
      return fakeResponse(VALID_WORLD_RESPONSE);
    }
    const body = JSON.parse(String(init.body)) as RecordedRequest;
    if (body.type === 'entity.validatePlacement') {
      const index = validateBodies.length;
      validateBodies.push(body);
      return fakeResponse(await validateHandler(body, index));
    }
    commandBodies.push(body);
    return fakeResponse({ events: [], serverTime: SERVER_TIME });
  });
}

/** Flush resolved promises/timers enough for verdict delivery. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// --- Recording runtime -----------------------------------------------------

interface RecordingRuntime {
  runtime: RenderRuntime;
  factory: (options: SceneViewOptions) => RenderRuntime;
  mountCalls: number;
  pickCalls: { x: number; y: number }[];
  orientationCalls: { yawDegrees?: number }[];
  gridOverlayCalls: boolean[];
  ghostCalls: (PlacementGhost | null)[];
  pickResult: RenderPick;
}

const CAMERA_STATE: CameraState = {
  pitchDegrees: 35,
  yawDegrees: 0,
  zoom: 1,
  focus: { x: 0, y: 0, z: 0 },
};

function createRecordingRuntime(): RecordingRuntime {
  const recorder: RecordingRuntime = {
    mountCalls: 0,
    pickCalls: [],
    orientationCalls: [],
    gridOverlayCalls: [],
    ghostCalls: [],
    pickResult: null,
    factory: undefined as unknown as RecordingRuntime['factory'],
    runtime: undefined as unknown as RenderRuntime,
  };
  const cameraState: CameraState = { ...CAMERA_STATE, focus: { ...CAMERA_STATE.focus } };

  recorder.runtime = {
    mount: () => {
      recorder.mountCalls += 1;
    },
    apply: () => {},
    update: () => {},
    setFollowTarget: () => {},
    getCameraState: () => ({ ...cameraState, focus: { ...cameraState.focus } }),
    setCameraOrientation: (orientation) => {
      recorder.orientationCalls.push({ ...orientation });
      if (orientation.yawDegrees !== undefined) {
        cameraState.yawDegrees = orientation.yawDegrees;
      }
    },
    setCameraPitch: () => {},
    setZoom: () => {},
    setGridOverlayVisible: (visible) => {
      recorder.gridOverlayCalls.push(visible);
    },
    setHighlightedCell: () => {},
    setPlacementGhost: (ghost) => {
      recorder.ghostCalls.push(ghost);
    },
    pick: (x, y) => {
      recorder.pickCalls.push({ x, y });
      return recorder.pickResult;
    },
    inspect: (): RenderInspection => ({
      mounted: false,
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
        near: 21,
        far: 70,
        aspect: 1,
        pitchDegrees: cameraState.pitchDegrees,
        yawDegrees: cameraState.yawDegrees,
        zoom: cameraState.zoom,
        focus: { ...cameraState.focus },
        position: { x: 0, y: 28.88, z: 28.88 },
        forward: { x: 0, y: -0.7071, z: -0.7071 },
        up: { x: 0, y: 0.7071, z: -0.7071 },
      },
      nodes: [],
      buckets: [],
      gridOverlay: {
        visible: false,
        highlightedCell: null,
        lineObjectCount: 0,
        highlightMarkerCount: 0,
      },
      placementGhost: null,
    }),
    dispose: () => {},
  };

  recorder.factory = (options) => {
    void options;
    return recorder.runtime;
  };

  return recorder;
}

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

/** Load game info + world, render `WorldView`, and return the canvas. */
async function mountEditor(recorder: RecordingRuntime): Promise<HTMLElement> {
  setGameInfoFetch(async () => fakeResponse(VALID_GAME_INFO_RESPONSE));
  await act(async () => {
    await loadGameInfo();
    await loadWorld();
  });
  render(<WorldView createRuntime={recorder.factory} />);
  await waitFor(() => {
    expect(recorder.mountCalls).toBe(1);
  });
  const canvas = screen.getByTestId('scene-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(fixedCanvasRect());
  return canvas;
}

function openEditor(): void {
  if (screen.queryByTestId('editor-panel') === null) {
    fireEvent.click(screen.getByTestId('editor-button'));
  }
}

function selectBlock(kind: string): void {
  openEditor();
  fireEvent.click(screen.getByTestId(`block-kind-${kind}`));
}

function selectEntity(kind: string): void {
  openEditor();
  fireEvent.click(screen.getByTestId(`entity-kind-${kind}`));
}

/** Hover the canvas so the editor resolves a candidate from `pickResult`. */
function hover(canvas: HTMLElement, clientX = 60, clientY = 60, pointerId = 1): void {
  fireEvent.pointerMove(canvas, { pointerId, clientX, clientY });
}

/** Primary click on the canvas (a complete press/release below the drag threshold). */
function clickCanvas(canvas: HTMLElement, button: 0 | 2 = 0, pointerId = 11): void {
  fireEvent.pointerDown(canvas, { pointerId, button, clientX: 60, clientY: 60 });
  fireEvent.pointerUp(canvas, { pointerId, button, clientX: 60, clientY: 60 });
}

/** Dispatch a real, cancelable keydown at `target` (default: window). */
function pressKey(key: string, target: Element | Window = window): void {
  act(() => {
    fireEvent.keyDown(target, { key, bubbles: true, cancelable: true });
  });
}

beforeEach(() => {
  validateBodies = [];
  commandBodies = [];
  validateHandler = () => validateVerdict(true);
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
  setWorldEventSource(openingEventSource);
  installWorldFetch();
});

afterEach(() => {
  cleanup();
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
});

describe('Editor palettes derive from the catalogues', () => {
  it('renders one block entry per catalogued kind (including air) and one entity entry per kind', async () => {
    const recorder = createRecordingRuntime();
    await mountEditor(recorder);
    openEditor();

    const blockIds = within(screen.getByTestId('block-palette'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'));
    expect([...blockIds].sort()).toEqual(
      BLOCK_KINDS.map((entry) => `block-kind-${entry.kind}`).sort(),
    );
    expect(blockIds).toContain('block-kind-air');
    expect(blockIds).toContain('block-kind-stairs');
    expect(blockIds).toContain('block-kind-ramp');

    const entityIds = within(screen.getByTestId('entity-palette'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'));
    expect([...entityIds].sort()).toEqual(
      ENTITY_KINDS.map((entry) => `entity-kind-${entry.kind}`).sort(),
    );
  });

  it('does not hardcode kinds: a reduced catalogue yields exactly its entries', async () => {
    const recorder = createRecordingRuntime();
    setGameInfoFetch(async () =>
      fakeResponse({
        ...VALID_GAME_INFO_RESPONSE,
        blockKinds: [{ kind: 'stone', orientable: true }],
        entityKinds: [ENTITY_KINDS[1]],
      }),
    );
    await act(async () => {
      await loadGameInfo();
      await loadWorld();
    });
    render(<WorldView createRuntime={recorder.factory} />);
    await waitFor(() => {
      expect(recorder.mountCalls).toBe(1);
    });
    openEditor();

    expect(screen.getByTestId('block-kind-stone')).toBeTruthy();
    expect(screen.queryByTestId('block-kind-grass')).toBeNull();
    expect(screen.getByTestId('entity-kind-tree')).toBeTruthy();
    expect(screen.queryByTestId('entity-kind-rock')).toBeNull();
  });
});

describe('Block editing emits block.set / block.remove', () => {
  it('left click places the selected block at the picked cell', async () => {
    const recorder = createRecordingRuntime();
    // Picked world point (0.1, 0, 0.2) -> cell (5, 0, 5) for origin (-5,0,-5).
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    hover(canvas);
    clickCanvas(canvas, 0, 11);
    await flush();

    expect(commandBodies).toHaveLength(1);
    expect(commandBodies[0]).toEqual({
      type: 'block.set',
      coord: { x: 5, y: 0, z: 5 },
      kind: 'grass',
      orientation: 0,
    });
  });

  it('right click removes the block at the picked cell', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    hover(canvas);
    clickCanvas(canvas, 2, 12);
    await flush();

    expect(commandBodies).toHaveLength(1);
    expect(commandBodies[0]).toEqual({
      type: 'block.remove',
      coord: { x: 5, y: 0, z: 5 },
    });
  });

  it('left click on an existing block node targets that block cell', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:0,0,0' as never,
      point: { x: 0.5, y: 0.9, z: 0.5 },
      normal: { x: 1, y: 0, z: 0 },
    };
    const canvas = await mountEditor(recorder);
    selectBlock('stone');

    hover(canvas);
    clickCanvas(canvas, 0, 13);
    await flush();

    expect(commandBodies[0]).toMatchObject({
      type: 'block.set',
      coord: { x: 0, y: 0, z: 0 },
      kind: 'stone',
    });
  });

  it('left click on a block TOP face targets the cell above it (air cells are reachable)', async () => {
    const recorder = createRecordingRuntime();
    // Block at cell (0,0,0); its top face is the floor of the air cell (0,1,0).
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:0,0,0' as never,
      point: { x: -4.5, y: 1, z: -4.5 },
      normal: { x: 0, y: 1, z: 0 },
    };
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    clickCanvas(canvas, 0, 15);
    await flush();

    expect(commandBodies).toHaveLength(1);
    expect(commandBodies[0]).toMatchObject({
      type: 'block.set',
      coord: { x: 0, y: 1, z: 0 },
      kind: 'grass',
    });
  });

  it('left click on a block SIDE face keeps targeting the hit cell', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:0,0,0' as never,
      point: { x: -4, y: 0.5, z: -4.5 },
      normal: { x: 1, y: 0, z: 0 },
    };
    const canvas = await mountEditor(recorder);
    selectBlock('stone');

    clickCanvas(canvas, 0, 16);
    await flush();

    expect(commandBodies[0]).toMatchObject({
      type: 'block.set',
      coord: { x: 0, y: 0, z: 0 },
      kind: 'stone',
    });
  });

  it('two successive left clicks stack two blocks (first on the ground, then on its top face)', async () => {
    const recorder = createRecordingRuntime();
    const canvas = await mountEditor(recorder);
    selectBlock('soil');

    // First click: bare ground under cell (5,0,5) -> place there.
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    clickCanvas(canvas, 0, 17);
    await flush();
    expect(commandBodies[0]).toMatchObject({
      type: 'block.set',
      coord: { x: 5, y: 0, z: 5 },
      kind: 'soil',
    });

    // Second click: the newly placed block's TOP face -> the air cell above it.
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:5,0,5' as never,
      point: { x: 0.5, y: 1, z: 0.5 },
      normal: { x: 0, y: 1, z: 0 },
    };
    clickCanvas(canvas, 0, 18);
    await flush();

    expect(commandBodies).toHaveLength(2);
    expect(commandBodies[1]).toMatchObject({
      type: 'block.set',
      coord: { x: 5, y: 1, z: 5 },
      kind: 'soil',
    });
  });

  it('builds the block ghost from the resolved target cell centre, not the raw pick point', async () => {
    const recorder = createRecordingRuntime();
    // Top face of cell (0,0,0): the resolved target is (0,1,0), whose world
    // centre for grid origin (-5,0,-5) is (-4.5, 1.5, -4.5).
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:0,0,0' as never,
      point: { x: -4.5, y: 1, z: -4.5 },
      normal: { x: 0, y: 1, z: 0 },
    };
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    hover(canvas, 55, 55, 1);

    const ghost = recorder.ghostCalls.at(-1);
    expect(ghost).not.toBeNull();
    expect(ghost?.position).toEqual({ x: -4.5, y: 1.5, z: -4.5 });
    // A block node root is the cell centre, so the ghost is centre-anchored.
    expect(ghost?.pivot).toBe('center');
    expect(ghost?.height).toBe(1);
  });

  it('builds the block ghost from the target cell centre for a bare ground click too', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    hover(canvas, 55, 55, 1);

    // Picked point is in cell (5,0,5); its world centre is (0.5, 0.5, 0.5).
    expect(recorder.ghostCalls.at(-1)?.position).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    expect(recorder.ghostCalls.at(-1)?.pivot).toBe('center');
  });

  it('selecting air left-clicks as a removal', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);
    selectBlock('air');

    hover(canvas);
    clickCanvas(canvas, 0, 14);
    await flush();

    expect(commandBodies[0]).toMatchObject({ type: 'block.remove', coord: { x: 5, y: 0, z: 5 } });
  });
});

describe('R rotates only directional kinds', () => {
  it('advances an orientable block orientation and leaves a non-orientable one at yaw 0', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);

    // stairs is orientable: R advances 0 -> 90.
    selectBlock('stairs');
    hover(canvas);
    pressKey('r');
    clickCanvas(canvas, 0, 21);
    await flush();
    expect(commandBodies.at(-1)).toMatchObject({ type: 'block.set', kind: 'stairs', orientation: 90 });

    // grass is NOT orientable: R is harmless, orientation stays 0.
    selectBlock('grass');
    hover(canvas);
    pressKey('r');
    pressKey('r');
    clickCanvas(canvas, 0, 22);
    await flush();
    expect(commandBodies.at(-1)).toMatchObject({ type: 'block.set', kind: 'grass', orientation: 0 });
  });

  it('also rotates while focus is inside the editor panel (panel-local R handler)', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    const canvas = await mountEditor(recorder);
    selectBlock('ramp');
    hover(canvas);

    const entry = screen.getByTestId('block-kind-ramp');
    entry.focus();
    pressKey('r', entry);
    clickCanvas(canvas, 0, 23);
    await flush();

    expect(commandBodies.at(-1)).toMatchObject({ type: 'block.set', kind: 'ramp', orientation: 90 });
  });
});

describe('Placement ghost is server-authoritative', () => {
  it('asks validatePlacement only when the candidate changes', async () => {
    const recorder = createRecordingRuntime();
    const canvas = await mountEditor(recorder);
    selectEntity('tree');

    // Two hover points inside the SAME snapped cell (both snap to 0.5/0.5).
    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    hover(canvas, 40, 40, 1);
    await flush();
    recorder.pickResult = { kind: 'ground', point: { x: 0.4, y: 0, z: 0.45 } };
    hover(canvas, 45, 45, 1);
    await flush();
    expect(validateBodies).toHaveLength(1);

    // Another hover in the same cell / no re-ask.
    hover(canvas, 48, 48, 1);
    await flush();
    expect(validateBodies).toHaveLength(1);

    // A point in a different cell -> exactly one more request.
    recorder.pickResult = { kind: 'ground', point: { x: 1.2, y: 0, z: 0.2 } };
    hover(canvas, 55, 55, 1);
    await flush();
    expect(validateBodies).toHaveLength(2);
    expect(validateBodies[1]).toMatchObject({ type: 'entity.validatePlacement', kind: 'tree' });
  });

  it('discards a stale response and paints only the current candidate', async () => {
    const recorder = createRecordingRuntime();
    const canvas = await mountEditor(recorder);
    selectEntity('tree');

    // Defer both verdicts so we can resolve them out of order.
    const resolvers: Array<(value: unknown) => void> = [];
    validateHandler = () =>
      new Promise<unknown>((resolve) => {
        resolvers.push(resolve);
      });

    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    hover(canvas, 40, 40, 1);
    await flush();
    recorder.pickResult = { kind: 'ground', point: { x: 1.2, y: 0, z: 0.2 } };
    hover(canvas, 60, 60, 1);
    await flush();
    expect(validateBodies).toHaveLength(2);

    // The FIRST (superseded) answer arrives last: it must not paint the ghost.
    resolvers[0](validateVerdict(false, { reason: 'stale answer' }));
    await flush();
    const ghostAfterStale = recorder.ghostCalls.at(-1);
    expect(ghostAfterStale === null || ghostAfterStale === undefined || ghostAfterStale.valid === null).toBe(
      true,
    );
    expect(screen.queryByText('stale answer')).toBeNull();

    // The current answer paints.
    resolvers[1](validateVerdict(true, { resolved: { x: 0.5, y: 0, z: 0.5 } }));
    await flush();
    await waitFor(() => {
      expect(recorder.ghostCalls.at(-1)?.valid).toBe(true);
    });
  });

  it('takes the colour strictly from the server verdict, never from client knowledge', async () => {
    const recorder = createRecordingRuntime();
    let answer: unknown = validateVerdict(false, { reason: 'server says no' });
    validateHandler = () => answer;
    const canvas = await mountEditor(recorder);
    selectEntity('tree');

    // Client picks an EMPTY cell (5.5, 0, 5.5) the snapshot has no block for.
    recorder.pickResult = { kind: 'ground', point: { x: 5.1, y: 0, z: 5.1 } };
    hover(canvas, 40, 40, 1);
    await flush();
    await waitFor(() => {
      expect(recorder.ghostCalls.at(-1)?.valid).toBe(false);
    });
    expect(screen.getByTestId('editor-reason').textContent).toBe('server says no');

    // Now the server says VALID for a cell the client MIGHT believe is occupied
    // (cell 0,0,0 already holds grass). Colour follows the server, not the client.
    answer = validateVerdict(true, { resolved: { x: 0.5, y: 0, z: 0.5 } });
    recorder.pickResult = {
      kind: 'node',
      nodeId: 'block:0,0,0' as never,
      point: { x: 0.5, y: 0.9, z: 0.5 },
      normal: { x: 0, y: 1, z: 0 },
    };
    hover(canvas, 55, 55, 1);
    await flush();
    await waitFor(() => {
      expect(recorder.ghostCalls.at(-1)?.valid).toBe(true);
    });
    // And the valid answer snaps the ghost to the server's resolved transform.
    expect(recorder.ghostCalls.at(-1)?.position).toEqual({ x: 0.5, y: 0, z: 0.5 });
  });

  it('snaps the ghost to the resolved transform and highlights server occupied cells', async () => {
    const recorder = createRecordingRuntime();
    validateHandler = () =>
      validateVerdict(true, {
        resolved: { x: 1.5, y: 0, z: 0.5 },
        occupied: [{ x: 1, y: 0, z: 0 }],
      });
    const canvas = await mountEditor(recorder);
    selectEntity('building');

    recorder.pickResult = { kind: 'ground', point: { x: 1.2, y: 0, z: 0.2 } };
    hover(canvas, 40, 40, 1);
    await flush();
    await waitFor(() => {
      expect(recorder.ghostCalls.at(-1)?.valid).toBe(true);
    });
    const ghost = recorder.ghostCalls.at(-1);
    expect(ghost?.position).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(ghost?.footprintX).toBe(2);
    expect(ghost?.footprintZ).toBe(2);
    expect(ghost?.occupiedCells).toEqual([{ x: 1, y: 0, z: 0 }]);
  });
});

describe('Place sends the command; the preview is never authority', () => {
  it('sends entity.place even when the preview verdict is invalid', async () => {
    const recorder = createRecordingRuntime();
    validateHandler = () => validateVerdict(false, { reason: 'unsupported' });
    const canvas = await mountEditor(recorder);
    selectEntity('tree');

    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    hover(canvas, 40, 40, 1);
    await flush();
    await waitFor(() => {
      expect(recorder.ghostCalls.at(-1)?.valid).toBe(false);
    });

    fireEvent.click(screen.getByTestId('editor-place'));
    await flush();

    expect(commandBodies).toHaveLength(1);
    expect(commandBodies[0]).toEqual({
      type: 'entity.place',
      kind: 'tree',
      position: { x: 0.5, y: 0, z: 0.5 },
      yawDegrees: 0,
    });
  });

  it('uses the current yaw for the placement command', async () => {
    const recorder = createRecordingRuntime();
    const canvas = await mountEditor(recorder);
    // rock allows every yaw step, so R advances 0 -> 90.
    selectEntity('rock');

    recorder.pickResult = { kind: 'ground', point: { x: 0.1, y: 0, z: 0.2 } };
    hover(canvas, 40, 40, 1);
    await flush();
    pressKey('r');
    fireEvent.click(screen.getByTestId('editor-place'));
    await flush();

    expect(commandBodies.at(-1)).toMatchObject({
      type: 'entity.place',
      kind: 'rock',
      yawDegrees: 90,
    });
  });
});

describe('Editor input isolation', () => {
  it('does not pick, rotate, or emit an intent from a palette interaction', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    await mountEditor(recorder);
    openEditor();

    const beforePicks = recorder.pickCalls.length;
    const beforeOrient = recorder.orientationCalls.length;

    const entry = screen.getByTestId('block-kind-grass');
    fireEvent.pointerDown(entry, { pointerId: 7, clientX: 40, clientY: 60, button: 0 });
    fireEvent.pointerMove(entry, { pointerId: 7, clientX: 160, clientY: 90 });
    fireEvent.pointerUp(entry, { pointerId: 7, clientX: 160, clientY: 90, button: 0 });
    fireEvent.click(entry);
    await flush();

    expect(recorder.pickCalls).toHaveLength(beforePicks);
    expect(recorder.orientationCalls).toHaveLength(beforeOrient);
    expect(commandBodies).toHaveLength(0);
  });

  it('still lets a canvas drag rotate and wheel zoom while the editor is armed', async () => {
    const recorder = createRecordingRuntime();
    const canvas = await mountEditor(recorder);
    selectBlock('grass');

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, pointerId: 31, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 31 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 31, button: 0 });
    await flush();

    expect(recorder.orientationCalls.length).toBeGreaterThan(0);
    expect(commandBodies).toHaveLength(0);
  });

  it('keeps the keyboard isolation guard while focus is in the editor panel', async () => {
    const recorder = createRecordingRuntime();
    await mountEditor(recorder);
    openEditor();

    const entry = screen.getByTestId('block-kind-grass');
    entry.focus();

    pressKey('ArrowRight', entry);
    pressKey('w', entry);
    pressKey('g', entry);
    await flush();

    // No movement intent, no rig rotation, no grid toggle reached the runtime.
    expect(commandBodies).toHaveLength(0);
    expect(recorder.orientationCalls).toHaveLength(0);
    expect(recorder.gridOverlayCalls).not.toContain(true);
  });
});
