// @vitest-environment jsdom
/**
 * Phase-12 HTML HUD tests.
 *
 * The world is still rendered by Three.js through the Render ISA, which needs a
 * real WebGL context; these tests therefore inject the recording `RenderRuntime`
 * (the same pattern `scene-view.test.tsx` uses) through `WorldView`'s
 * `createRuntime` prop. That lets the HUD be exercised in a real DOM without a
 * GPU, and lets the interaction-safety assertions observe `setCameraOrientation`
 * / `pick` / Organizer-intent calls exactly.
 *
 * What is being proven:
 *  - the HUD is a DOM layer painted after (above) the canvas in a positioned
 *    viewport container;
 *  - the toolbar selection and bag panel are purely presentational;
 *  - the server stream status and the transient notice stay visible;
 *  - a HUD interaction rotates nothing, picks nothing and emits no Organizer
 *    intent, while a canvas drag/click/wheel still works exactly as before;
 *  - the overlay is input-transparent outside its own controls (declared in the
 *    stylesheet, since jsdom does not apply CSS hit-testing).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadWorld,
  moveTo,
  resetGameInfoFetch,
  resetGameInfoState,
  resetWorldEventSource,
  resetWorldFetch,
  resetWorldState,
  setWorldEventSource,
  setWorldFetch,
} from '../src/organizer/index.ts';
import type { EventSourceLike } from '../src/organizer/index.ts';
import type {
  CameraState,
  RenderInspection,
  RenderPick,
  RenderRuntime,
} from '../src/render/three/runtime.ts';
import type { SceneViewOptions } from '../src/ui/SceneView.tsx';
import { WorldView } from '../src/ui/WorldView.tsx';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
const GRID = { origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 };

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  bounds: BOUNDS,
  grid: GRID,
  tiles: [{ cell: { x: 0, z: 0 }, terrain: 'grass' }],
  surfaces: [],
  colliders: [],
  entities: [
    {
      entityId: 'entity-a',
      actorId: 'actor-1',
      kind: 'character',
      transform: {
        position: { x: 3, y: 0, z: 4 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      visible: true,
    },
  ],
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

interface CapturedRequest {
  method: string | undefined;
  body: unknown;
}

/**
 * Serve the world snapshot, and optionally capture POST bodies (Organizer
 * intents). A HUD interaction must leave these empty.
 */
function installWorldFetch(requests: CapturedRequest[] = []): void {
  setWorldFetch(async (_url, init) => {
    if (init?.method !== 'POST') {
      return fakeResponse(VALID_WORLD_RESPONSE);
    }
    requests.push({
      method: init.method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return fakeResponse({ events: [], serverTime: SERVER_TIME });
  });
}

interface RecordingRuntime {
  runtime: RenderRuntime;
  factory: (options: SceneViewOptions) => RenderRuntime;
  mountCalls: number;
  disposeCalls: number;
  orientationCalls: { yawDegrees?: number }[];
  zoomCalls: number[];
  pitchCalls: number[];
  pickCalls: { x: number; y: number }[];
  /** Result the injected `pick` returns; default `null`. */
  pickResult: RenderPick;
}

const CAMERA_STATE: CameraState = {
  pitchDegrees: 35,
  yawDegrees: 0,
  zoom: 1,
  focus: { x: 0, y: 0, z: 0 },
};

/** A `RenderRuntime` that records calls instead of touching WebGL. */
function createRecordingRuntime(): RecordingRuntime {
  const recorder: RecordingRuntime = {
    mountCalls: 0,
    disposeCalls: 0,
    orientationCalls: [],
    zoomCalls: [],
    pitchCalls: [],
    pickCalls: [],
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
    setCameraPitch: (degrees) => {
      recorder.pitchCalls.push(degrees);
      // Mirror the real rig: clamp to the documented range.
      cameraState.pitchDegrees = Math.min(Math.max(degrees, 25), 75);
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
    }),
    dispose: () => {
      recorder.disposeCalls += 1;
    },
  };

  recorder.factory = (options) => {
    void options;
    return recorder.runtime;
  };

  return recorder;
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

/** Load a valid world, render `WorldView` with the recorder, and return the canvas. */
async function mountWorldHud(recorder: RecordingRuntime): Promise<HTMLElement> {
  await act(async () => {
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

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
  setWorldEventSource(openingEventSource);
});

afterEach(() => {
  cleanup();
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  resetGameInfoState();
  resetGameInfoFetch();
});

describe('HTML HUD layout', () => {
  it('renders the HUD as a sibling layer painted after the canvas inside a positioned viewport', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await mountWorldHud(recorder);

    const viewport = screen.getByTestId('world-viewport');
    const canvas = screen.getByTestId('scene-canvas');
    const hud = screen.getByTestId('world-hud');

    // Both live in the same positioned container, and the canvas still exists
    // underneath the HUD.
    expect(viewport.contains(canvas)).toBe(true);
    expect(viewport.contains(hud)).toBe(true);
    // The HUD follows the canvas in DOM order, i.e. it paints on top.
    expect(hud.previousElementSibling).toBe(canvas);
    expect(canvas.compareDocumentPosition(hud) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The overlay is a labelled group so assistive tech can find it.
    expect(hud.getAttribute('role')).toBe('group');
    expect(hud.getAttribute('aria-label')).toBe('World overlay');
  });

  it('declares the overlay input-transparent outside its own controls', () => {
    // jsdom does not apply CSS hit-testing, so the interaction-transparency
    // contract is asserted against the stylesheet that ships in the browser.
    // The behavioural proof that controls stay isolated is the next describe().
    const cssPath = resolve(process.cwd(), 'apps/web/src/ui/styles.css');
    const css = readFileSync(cssPath, 'utf8');

    const hudRule = css.match(/\.world__hud\s*\{([^}]*)\}/);
    expect(hudRule).not.toBeNull();
    expect(hudRule?.[1]).toMatch(/pointer-events:\s*none/);
    expect(hudRule?.[1]).toMatch(/position:\s*absolute/);
    expect(hudRule?.[1]).toMatch(/z-index:\s*\d+/);

    const controlRule = css.match(/\.world__hud-control\s*\{([^}]*)\}/);
    expect(controlRule).not.toBeNull();
    expect(controlRule?.[1]).toMatch(/pointer-events:\s*auto/);
  });

  it('shows placeholder tool slots with accessible names and presentational selection', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await mountWorldHud(recorder);

    const toolbar = screen.getByTestId('world-toolbar');
    expect(toolbar.getAttribute('role')).toBe('toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe('Tools');

    const hoe = screen.getByTestId('tool-hoe');
    const axe = screen.getByTestId('tool-axe');
    expect(hoe.getAttribute('aria-label')).toBe('Hoe');
    expect(axe.getAttribute('aria-label')).toBe('Axe');
    expect(hoe.getAttribute('aria-pressed')).toBe('false');

    // Selecting a slot is presentational: only `aria-pressed` moves.
    fireEvent.click(axe);
    expect(axe.getAttribute('aria-pressed')).toBe('true');
    expect(hoe.getAttribute('aria-pressed')).toBe('false');

    // Clicking the selected slot again clears the selection.
    fireEvent.click(axe);
    expect(axe.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles the bag panel between an honest empty state and hidden', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await mountWorldHud(recorder);

    const bag = screen.getByTestId('bag-button');
    expect(bag.getAttribute('aria-label')).toBe('Bag');
    expect(bag.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('bag-panel')).toBeNull();

    fireEvent.click(bag);
    const panel = screen.getByTestId('bag-panel');
    expect(bag.getAttribute('aria-expanded')).toBe('true');
    // Honest placeholder: it states the limitation and invents no items/counts.
    expect(panel.textContent).toContain('Inventory is not implemented yet.');
    expect(panel.textContent).not.toMatch(/\b\d+\s*(item|slot|count)/i);

    fireEvent.click(bag);
    expect(screen.queryByTestId('bag-panel')).toBeNull();
    expect(bag.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens an in-world settings panel with a labelled pitch control, its range, and a no-persistence note', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await mountWorldHud(recorder);

    const button = screen.getByTestId('settings-button');
    expect(button.getAttribute('aria-label')).toBe('Settings');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('world-settings-panel');
    expect(screen.queryByTestId('settings-panel')).toBeNull();

    // The button lives inside the world viewport, not in a panel below it.
    expect(screen.getByTestId('world-viewport').contains(button)).toBe(true);

    fireEvent.click(button);
    const panel = screen.getByTestId('settings-panel');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    // A labelled control (slider and/or number input) with the current value
    // shown, the allowed range stated, and the reset-on-reload honesty note.
    expect(within(panel).getByLabelText('Camera pitch')).toBe(screen.getByTestId('camera-pitch'));
    expect(screen.getByTestId('camera-pitch-value').textContent).toBe('35°');
    expect(screen.getByTestId('camera-pitch-range').textContent).toContain('25°–75°');
    expect(within(panel).getByText(/reload resets the camera pitch to 35°/i)).toBeTruthy();
  });

  it('keeps the server stream status and a rejected-intent notice visible in the HUD', async () => {
    const recorder = createRecordingRuntime();
    installWorldFetch();
    await mountWorldHud(recorder);

    const stream = screen.getByTestId('world-stream-status');
    await waitFor(() => {
      expect(stream.getAttribute('data-stream-status')).toBe('live');
    });
    expect(stream.textContent).toBe('Live');

    // A refused intent is a transient Organizer notice, rendered over the world.
    setWorldFetch(async (_url, init) => {
      if (init?.method === 'POST') {
        return fakeResponse(
          { error: { code: 'CONFLICT', message: 'Too far away.' } },
          { ok: false, status: 409 },
        );
      }
      return fakeResponse(VALID_WORLD_RESPONSE);
    });
    await act(async () => {
      await moveTo({ x: 100, y: 0, z: 100 });
    });

    const notice = await screen.findByTestId('world-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toBe('Too far away.');
  });
});

describe('HUD interaction safety', () => {
  it('never rotates the camera, picks, or emits an Organizer intent from a HUD interaction', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    installWorldFetch(requests);
    await mountWorldHud(recorder);

    // A toolbar selection, a bag toggle, and a drag on the bag panel.
    fireEvent.click(screen.getByTestId('tool-hoe'));
    fireEvent.click(screen.getByTestId('bag-button'));
    const panel = screen.getByTestId('bag-panel');
    fireEvent.pointerDown(panel, { clientX: 40, clientY: 60, pointerId: 7, button: 0 });
    fireEvent.pointerMove(panel, { clientX: 160, clientY: 90, pointerId: 7 });
    fireEvent.pointerUp(panel, { clientX: 160, clientY: 90, pointerId: 7, button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorder.orientationCalls).toHaveLength(0);
    expect(recorder.pickCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('changes the pitch from the settings slider without rotating, picking, or emitting an Organizer intent', async () => {
    const recorder = createRecordingRuntime();
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    installWorldFetch(requests);
    await mountWorldHud(recorder);

    fireEvent.click(screen.getByTestId('settings-button'));
    const slider = screen.getByTestId('camera-pitch');

    // A drag gesture on the slider is captured by the panel (a `pointer-events:
    // auto` control); it must never reach the canvas' drag-to-orbit handler.
    fireEvent.pointerDown(slider, { clientX: 40, clientY: 60, pointerId: 9, button: 0 });
    fireEvent.pointerMove(slider, { clientX: 120, clientY: 60, pointerId: 9 });
    fireEvent.pointerUp(slider, { clientX: 120, clientY: 60, pointerId: 9, button: 0 });
    fireEvent.change(slider, { target: { value: '55' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The only effect is the rig pitch; it is presentation, not an intent.
    expect(recorder.pitchCalls).toEqual([55]);
    expect(screen.getByTestId('camera-pitch-value').textContent).toBe('55°');
    expect(recorder.orientationCalls).toHaveLength(0);
    expect(recorder.pickCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('still rotates the camera on a canvas drag, picks on a canvas click, and zooms on wheel', async () => {
    const recorder = createRecordingRuntime();
    // If the drag wrongly clicked, this would emit an intent.
    recorder.pickResult = { kind: 'ground', point: { x: 0, y: 0, z: 0 } };
    const requests: CapturedRequest[] = [];
    installWorldFetch(requests);
    const canvas = await mountWorldHud(recorder);

    // Drag: > click threshold, so it rotates and never picks or emits.
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 90, pointerId: 1, button: 0 });
    await waitFor(() => {
      expect(recorder.orientationCalls.length).toBeGreaterThan(0);
    });
    expect(recorder.pickCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);

    // Wheel still dollies the zoom.
    fireEvent.wheel(canvas, { deltaY: -100 });
    expect(recorder.zoomCalls.at(-1)).toBeGreaterThan(1);

    // Click: picks and maps a ground hit to a move intent.
    fireEvent.pointerDown(canvas, { clientX: 110, clientY: 70, pointerId: 2, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 110, clientY: 70, pointerId: 2, button: 0 });
    await waitFor(() => {
      expect(recorder.pickCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({
      type: 'actor.moveTo',
      target: { x: 0, y: 0, z: 0 },
    });
  });
});
