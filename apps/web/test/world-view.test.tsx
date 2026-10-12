// @vitest-environment jsdom
/**
 * UI tests for `WorldView` / the page shell's world wiring.
 *
 * These mount real components in a DOM (so effects, event listeners, and
 * re-renders actually run). They consume only the Organizer-facing API
 * (`organizer/index.ts`) plus its test-only fetch hook, `setWorldFetch`; they
 * never import Protocol, backend, or Node modules, and they never call `fetch`
 * themselves.
 *
 * The world itself is rendered by Three.js through the Render ISA, which needs a
 * real WebGL context. The runtime module is therefore mocked with a recording
 * responder for this file: these tests cover the HUD (camera-relative controls,
 * keyboard, held intent, stream status, retry, mount) while
 * `scene-view.test.tsx` covers the bridge/runtime wiring.
 *
 * Phase 7: the client controls an actor named by `controlledActorId`, and the
 * move intent is a level-triggered world-space direction (`actor.moveIntent`)
 * computed from WASD/buttons and the rig's yaw. The request carries no actor id
 * (the server resolves the actor from transport context) and no position.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getWorldState,
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
import { App } from '../src/ui/App.tsx';
import { WorldView } from '../src/ui/WorldView.tsx';
import type { RenderFrame } from '../src/render/bridge.ts';

/** Shared recorder for the mocked Three.js runtime (hoisted for `vi.mock`). */
const mockRuntime = vi.hoisted(() => ({
  frames: [] as RenderFrame[],
  mountCalls: 0,
  yawDegrees: 0,
}));

// Replace the WebGL runtime with a recording no-op so mounting `<App />` /
// `<WorldView />` under jsdom never needs a canvas or WebGL context.
vi.mock('../src/render/three/runtime.ts', () => ({
  createThreeRuntime: () => ({
    mount: () => {
      mockRuntime.mountCalls += 1;
    },
    apply: (frame: RenderFrame) => {
      mockRuntime.frames.push(frame);
    },
    update: () => {},
    setFollowTarget: () => {},
    getCameraState: () => ({
      pitchDegrees: 58,
      yawDegrees: mockRuntime.yawDegrees,
      zoom: 1,
      focus: { x: 0, y: 0, z: 0 },
    }),
    setCameraOrientation: (orientation: { pitchDegrees?: number; yawDegrees?: number }) => {
      if (orientation.yawDegrees !== undefined) {
        mockRuntime.yawDegrees = orientation.yawDegrees;
      }
    },
    setZoom: () => {},
    inspect: () => ({
      mounted: false,
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
        yawDegrees: mockRuntime.yawDegrees,
        zoom: 1,
        focus: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
      },
      nodes: [],
      buckets: [],
    }),
    dispose: () => {},
  }),
}));

/** Does any recorded frame contain a command of `type`? */
function hasCommand(frames: readonly RenderFrame[], type: RenderFrame[number]['type']): boolean {
  return frames.some((frame) => frame.some((command) => command.type === type));
}

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

// Arbitrary: the protocol guard accepts any finite integer, the UI never reads
// this field, and a real client-side version gate belongs in the Organizer.
const ARBITRARY_PROTOCOL_VERSION = 1;

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
const GRID = { origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 };

const VALID_ENTITY = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: {
    position: { x: 3, y: 0, z: 4 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  visible: true,
};

const VALID_SNAPSHOT = {
  worldId: 'world-1',
  bounds: BOUNDS,
  grid: GRID,
  tiles: [
    { cell: { x: 0, z: 0 }, terrain: 'grass' },
    { cell: { x: 3, z: 4 }, terrain: 'path' },
  ],
  entities: [VALID_ENTITY],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

const VALID_GAME_INFO_RESPONSE = {
  gameInfo: {
    gameName: 'Starvalley',
    serverVersion: '0.1.0',
    protocolVersion: ARBITRARY_PROTOCOL_VERSION,
    serverTime: SERVER_TIME,
  },
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

/** Build a valid `GameEventBatch` body from a transformed entity. */
function moveResponse(x: number, z: number): unknown {
  return {
    events: [
      {
        type: 'transform.changed',
        entityId: 'entity-a',
        transform: {
          position: { x, y: 0, z },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
    ],
    serverTime: SERVER_TIME,
  };
}

interface CapturedRequest {
  method: string | undefined;
  body: unknown;
}

/** Load a valid world snapshot so world-dependent tests start from `ready`. */
async function loadValidWorld(): Promise<void> {
  setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
  await loadWorld();
}

/** Record POST requests made through the Organizer's injectable fetch. */
function captureMoves(requests: CapturedRequest[]): void {
  setWorldFetch(async (_url, init) => {
    if (init?.method !== 'POST') {
      return fakeResponse(VALID_WORLD_RESPONSE);
    }
    requests.push({
      method: init.method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return fakeResponse(moveResponse(4, 4));
  });
}

/** Read the movement vector out of a recorded `actor.moveIntent` body. */
function intentOf(request: CapturedRequest | undefined): { x: number; z: number } {
  return (request?.body as { movement: { x: number; z: number } }).movement;
}

/** Dispatch a real, cancelable keydown so `defaultPrevented` is observable. */
function pressKey(key: string, init: KeyboardEventInit = {}): boolean {
  let prevented = false;
  act(() => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

/** Dispatch a physical keyup (releases a held axis). */
function releaseKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  mockRuntime.frames.length = 0;
  mockRuntime.mountCalls = 0;
  mockRuntime.yawDegrees = 0;
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
  setWorldEventSource(openingEventSource);
});

afterEach(() => {
  cleanup();
  resetGameInfoState();
  resetGameInfoFetch();
  resetWorldState();
  resetWorldFetch();
  resetWorldEventSource();
});

describe('WorldView rendering', () => {
  it('renders the scene canvas, the live stream indicator, and the actor world position', async () => {
    await loadValidWorld();

    render(<WorldView />);

    const canvas = screen.getByTestId('scene-canvas');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.getAttribute('class')).toBe('scene-view__canvas');

    // The recorder proves the bridge actually fed the runtime a create command.
    await waitFor(() => {
      expect(mockRuntime.mountCalls).toBe(1);
      expect(hasCommand(mockRuntime.frames, 'node.create')).toBe(true);
    });

    const info = screen.getByTestId('controlled-actor-info');
    expect(info.textContent).toContain('(3.0, 0.0, 4.0)');

    const stream = screen.getByTestId('world-stream-status');
    await waitFor(() => {
      expect(stream.getAttribute('data-stream-status')).toBe('live');
    });
    expect(stream.textContent).toBe('Live');
  });

  it('renders a loading indication before the world is ready', () => {
    render(<WorldView />);

    const panel = screen.getByTestId('world-panel');
    expect(panel.getAttribute('data-status')).toBe('idle');
    const loading = within(panel).getByText(/Loading world/i);
    expect(loading.tagName).toBe('P');
    expect(loading.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('controlled-actor-info')).toBeNull();
    // No world snapshot -> no runtime is created, but the canvas still renders.
    expect(screen.getByTestId('scene-canvas').tagName).toBe('CANVAS');
  });
});

describe('WorldView direction controls', () => {
  it('disables every direction control before the world is ready', () => {
    render(<WorldView />);

    for (const direction of ['up', 'down', 'left', 'right']) {
      const button = screen.getByTestId(`move-${direction}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
  });

  it('drives a continuous world-space intent while pressed and stops on release', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);
    const right = screen.getByTestId('move-right');

    fireEvent.pointerDown(right);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // At rig yaw 0 "right" is world +X. The intent is the direction alone: the
    // server resolves which actor the caller controls.
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ type: 'actor.moveIntent', movement: { x: 1, z: 0 } });
    expect(requests[0].body).not.toHaveProperty('actorId');
    expect(requests[0].body).not.toHaveProperty('playerId');

    fireEvent.pointerUp(right);
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    // Releasing all input sends an explicit stop.
    expect(requests[1].body).toEqual({ type: 'actor.moveIntent', movement: { x: 0, z: 0 } });

    // The move also reached the render runtime as an interpolation target.
    await waitFor(() => {
      expect(hasCommand(mockRuntime.frames, 'transform.setTarget')).toBe(true);
    });
  });

  it('maps a pointer release outside the button to a stop', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);
    const up = screen.getByTestId('move-up');

    fireEvent.pointerDown(up);
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({ type: 'actor.moveIntent', movement: { x: 0, z: -1 } });

    fireEvent.pointerLeave(up);
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1].body).toEqual({ type: 'actor.moveIntent', movement: { x: 0, z: 0 } });
  });
});

describe('WorldView keyboard input', () => {
  it('maps ArrowRight to a held +X intent, prevents default, and ignores auto-repeat', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);

    const prevented = pressKey('ArrowRight');
    expect(prevented).toBe(true);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({ type: 'actor.moveIntent', movement: { x: 1, z: 0 } });

    // A repeat event is the same physical press held down; it must not post again.
    pressKey('ArrowRight', { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);

    // Releasing the key posts the stop.
    releaseKey('ArrowRight');
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1].body).toEqual({ type: 'actor.moveIntent', movement: { x: 0, z: 0 } });
  });

  it('ignores modifier-key presses but still moves on the unmodified press', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);

    // Ctrl/Cmd/Alt chords are browser/OS shortcuts, not movement intent.
    pressKey('ArrowRight', { ctrlKey: true });
    pressKey('ArrowRight', { metaKey: true });
    pressKey('ArrowRight', { altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);

    // The bare press still produces exactly the one move the guard let through.
    pressKey('ArrowRight');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].body).toEqual({ type: 'actor.moveIntent', movement: { x: 1, z: 0 } });
    releaseKey('ArrowRight');
  });

  it('rotates the posted world vector by the rig yaw', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    // The rig is already facing +X (yaw 90) before the key is pressed.
    mockRuntime.yawDegrees = 90;

    render(<WorldView />);

    pressKey('ArrowUp');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    // "Away from the camera" at yaw 90 is world -X; a constant 0 yaw would send
    // (0, -1) and pass every other UI test.
    expect(intentOf(requests[0]).x).toBeCloseTo(-1, 9);
    expect(intentOf(requests[0]).z).toBeCloseTo(0, 9);

    releaseKey('ArrowUp');
  });

  it('re-posts a held intent after a camera rotation, without a re-press', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    captureMoves(requests);

    render(<WorldView />);

    pressKey('ArrowUp');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(intentOf(requests[0]).x).toBeCloseTo(0, 9);
    expect(intentOf(requests[0]).z).toBeCloseTo(-1, 9);

    // Six 15-degree turns bring the rig to yaw 90 while "up" stays held. The
    // controller must re-post the rotated world vector on each rotation without
    // the key being released.
    for (let i = 0; i < 6; i += 1) {
      pressKey('e');
    }

    await waitFor(() => {
      expect(mockRuntime.yawDegrees).toBe(90);
      expect(intentOf(requests.at(-1)).x).toBeCloseTo(-1, 9);
      expect(intentOf(requests.at(-1)).z).toBeCloseTo(0, 9);
    });

    releaseKey('ArrowUp');
  });
});

describe('WorldView stop intent while errored', () => {
  it('still posts the stop when a held intent is released in the error state', async () => {
    await loadValidWorld();

    const requests: CapturedRequest[] = [];
    let postCount = 0;
    setWorldFetch(async (_url, init) => {
      if (init?.method !== 'POST') {
        return fakeResponse(VALID_WORLD_RESPONSE);
      }
      postCount += 1;
      requests.push({
        method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      // The second command fails, driving the store into `error` while a non-zero
      // intent is still retained server-side.
      if (postCount === 2) {
        throw new TypeError('Failed to fetch');
      }
      return fakeResponse(moveResponse(4, 4));
    });

    render(<WorldView />);

    // Hold one key (non-zero), then add a second (a changed intent that fails), so
    // the world is left in `error` with a held non-zero intent on the server.
    pressKey('ArrowRight');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    pressKey('ArrowUp');
    await waitFor(() => {
      expect(getWorldState().status).toBe('error');
    });
    expect(requests).toHaveLength(2);
    // Let the intent loop finish and clear its in-flight slot before releasing.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Releasing must still reach the Organizer: a suppressed stop would leave the
    // actor walking on the retained server-side intent.
    releaseKey('ArrowRight');
    releaseKey('ArrowUp');
    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(requests.at(-1)?.body).toEqual({
      type: 'actor.moveIntent',
      movement: { x: 0, z: 0 },
    });
  });
});

describe('WorldView load failure', () => {
  it('renders the Organizer message and recovers through Retry', async () => {
    let worldCalls = 0;
    setWorldFetch(async (_url, init) => {
      if (init?.method === 'POST') {
        return fakeResponse(moveResponse(4, 4));
      }
      worldCalls += 1;
      if (worldCalls === 1) {
        throw new TypeError('Failed to fetch');
      }
      return fakeResponse(VALID_WORLD_RESPONSE);
    });
    setGameInfoFetch(async () => fakeResponse(VALID_GAME_INFO_RESPONSE));

    render(<App />);

    const panel = screen.getByTestId('world-panel');
    const alert = await within(panel).findByRole('alert');

    const message = getWorldState().error;
    expect(message).toBeTruthy();
    if (message === null) {
      throw new Error('expected the organizer to expose an error message');
    }
    expect(alert.textContent).toContain(message);
    expect(screen.queryByTestId('controlled-actor-info')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await screen.findByTestId('controlled-actor-info');
    expect(worldCalls).toBe(2);
    expect(screen.getByTestId('controlled-actor-info').textContent).toContain('(3.0, 0.0, 4.0)');
  });
});

describe('App mount', () => {
  it('starts the world load on mount', async () => {
    let worldCalls = 0;
    setWorldFetch(async (_url, init) => {
      if (init?.method === 'POST') {
        return fakeResponse(moveResponse(4, 4));
      }
      worldCalls += 1;
      return fakeResponse(VALID_WORLD_RESPONSE);
    });
    setGameInfoFetch(async () => fakeResponse(VALID_GAME_INFO_RESPONSE));

    render(<App />);

    // The mount effect has already driven the store out of `idle`.
    expect(getWorldState().status).not.toBe('idle');

    await screen.findByTestId('controlled-actor-info');
    expect(worldCalls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });
});
