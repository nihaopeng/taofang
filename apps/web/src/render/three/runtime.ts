/**
 * The Three.js runtime: the **only** module allowed to import `three`.
 *
 * It is an *executor* of the Render ISA. It knows nothing about the game: no
 * `actor`, no `entity`, no Organizer import, no game protocol. It receives
 * opaque `NodeId` / `AppearanceId` values and maps them onto a Three.js scene
 * graph.
 *
 * Testability without WebGL
 * -------------------------
 * The scene **composition** (scene, camera, ground, lights) is built at
 * construction, so `apply`, `update`, and `inspect` never touch the GPU and a
 * test can assert what the runtime owns without a WebGL context. Only
 * `mount(canvas)` constructs the `WebGLRenderer`, sizes it, wires a resize
 * observer, and starts the `requestAnimationFrame` loop.
 *
 * Coordinate mapping
 * ------------------
 * Game tiles are 2D with an origin at the top-left and `y` growing south. The
 * scene maps a tile to `scene.x = tile.x` and `scene.y = -tile.y` (so scene `y`
 * grows north), with `scene.z = 0`. This is the only place the mapping exists;
 * `inspect()` inverts it from the real `Object3D` position so a change to the
 * mapping is observable in tests.
 */

import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import type { Light, Material } from 'three';
import type { AppearanceId, NodeId, RenderFrame } from '@starvalley/render-protocol';

/**
 * Plain-data view of the runtime for tests and debugging. Never Three objects.
 *
 * `nodes` coordinates are derived from the real `Object3D` position (inverted
 * back to tile space), not from the runtime's interpolation bookkeeping, so the
 * scene mapping itself is under test.
 */
export interface RenderInspection {
  mounted: boolean;
  /** Number of lights the runtime still owns (0 after `dispose`). */
  lights: number;
  /** Whether the runtime's ground plane is still in the scene. */
  ground: boolean;
  /** The orthographic camera frustum; lets projection be inspected without WebGL. */
  camera: { left: number; right: number; top: number; bottom: number };
  nodes: readonly {
    nodeId: string;
    x: number;
    y: number;
    visible: boolean;
    appearance: string;
  }[];
}

/** The executor surface the UI wires to the bridge. */
export interface RenderRuntime {
  /**
   * Create the `WebGLRenderer` for `canvas`, size it, observe resizes, and start
   * the render loop. The scene composition already exists from construction.
   * Idempotent while mounted (a second call is a no-op). Mounting a *disposed*
   * runtime is unsupported: its ground/lights are already released and `mount`
   * has no guard for it, so callers must construct a fresh runtime instead of
   * re-mounting an old one.
   */
  mount(canvas: HTMLCanvasElement): void;
  /** Apply one ordered render diff. Works without `mount`. */
  apply(frame: RenderFrame): void;
  /** Advance transform interpolation to wall-clock `nowMs`. Works without `mount`. */
  update(nowMs: number): void;
  /** Snapshot the runtime as plain data. Works without `mount`. */
  inspect(): RenderInspection;
  /**
   * Stop the loop and release *everything* the runtime created: nodes, ground,
   * lights, the resize observer, the renderer, and the loop handle. Terminal.
   */
  dispose(): void;
}

/** Internal per-node bookkeeping. `mesh` is the Three object; the rest is state. */
interface RuntimeNode {
  mesh: Mesh;
  /** Tile-space position (interpolated). */
  x: number;
  y: number;
  appearance: AppearanceId;
  /** Authoritative interpolation target, or `null` when the node is settled. */
  target: { x: number; y: number; durationMs: number } | null;
  /** Start time of the current interpolation, established by the first `update`. */
  startMs: number | null;
  startX: number;
  startY: number;
}

/** Visible stand-in for an appearance id the runtime catalogue does not know. */
const FALLBACK_COLOUR = 0xe8d5a8;

/** Appearance catalogue: what a bridge-chosen `AppearanceId` looks like in the scene. */
const APPEARANCE_COLOURS: Readonly<Record<string, number>> = {
  'appearance.character': 0x8fbf5a,
  'appearance.tree': 0x4f7a2c,
  // The bridge emits this for a kind it does not know yet; it is a first-class
  // catalogue entry so the binding test can assert it is covered.
  'appearance.fallback': FALLBACK_COLOUR,
};

/**
 * Appearance ids the runtime has a colour for. Exported so tests can assert the
 * bridge's emitted catalogue (see `BRIDGE_APPEARANCES`) is fully covered; an
 * unknown id still falls back to {@link FALLBACK_COLOUR} rather than crashing.
 */
export const KNOWN_APPEARANCES: readonly AppearanceId[] = Object.keys(APPEARANCE_COLOURS).map(
  (id) => id as AppearanceId,
);

/**
 * Pixel size used to size the drawing buffer before the canvas has a layout
 * size. This only affects the backing store; the projection is world-sized.
 */
const FALLBACK_PIXELS_PER_TILE = 32;

function colourFor(appearance: AppearanceId): number {
  return APPEARANCE_COLOURS[appearance] ?? FALLBACK_COLOUR;
}

function createMaterial(appearance: AppearanceId): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colourFor(appearance) });
}

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }
  material.dispose();
}

/**
 * Create a render runtime for an authoritative world size.
 *
 * `worldSize` is required (there is no magic default): the caller that owns the
 * authoritative dimensions must supply them. The whole scene composition exists
 * immediately, so `apply` works before (and without) `mount`; only `mount` needs
 * a real canvas.
 *
 * Projection trade-off: the camera uses a uniform scale with the world HEIGHT as
 * the fixed vertical extent and the horizontal extent derived from the canvas
 * aspect. Tiles therefore stay square and the world height always fits, but a
 * canvas narrower than the world's aspect ratio crops the world horizontally
 * (it does not squash it).
 */
export function createThreeRuntime(options: {
  worldSize: { width: number; height: number };
}): RenderRuntime {
  const worldWidth = options.worldSize.width;
  const worldHeight = options.worldSize.height;

  const scene = new Scene();
  const nodes = new Map<NodeId, RuntimeNode>();

  // Centre of the tile grid in scene space: tiles run x = 0..width-1 and
  // y = 0..height-1, and scene y is negated.
  const centerX = (worldWidth - 1) / 2;
  const centerY = -(worldHeight - 1) / 2;

  // Composition is built here, not in `mount`, so `dispose()` owns it and tests
  // can assert scene contents without a GPU.
  //
  // Projection: the world HEIGHT is the fixed vertical extent and the horizontal
  // extent is derived from the canvas aspect ratio (see `resizeRenderer`), which
  // keeps a world tile square on screen on any canvas shape. The initial frustum
  // fits the world exactly; `mount`/resize replaces it with the canvas aspect.
  const camera = new OrthographicCamera(
    -worldWidth / 2,
    worldWidth / 2,
    worldHeight / 2,
    -worldHeight / 2,
    0.1,
    100,
  );
  camera.position.set(centerX, centerY, 10);
  camera.lookAt(centerX, centerY, 0);
  camera.updateProjectionMatrix();

  const groundGeometry = new PlaneGeometry(worldWidth, worldHeight);
  const groundMaterial = new MeshStandardMaterial({ color: 0x2a2119 });
  let ground: Mesh | null = new Mesh(groundGeometry, groundMaterial);
  ground.position.set(centerX, centerY, -0.5);
  scene.add(ground);

  const ambient = new AmbientLight(0xffffff, 0.7);
  const sun = new DirectionalLight(0xffffff, 1.1);
  sun.position.set(centerX + 4, centerY + 6, 8);
  scene.add(ambient);
  scene.add(sun);
  const lights: Light[] = [ambient, sun];

  let mounted = false;
  let renderer: WebGLRenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let frameHandle: number | null = null;

  function createNode(command: {
    nodeId: NodeId;
    appearance: AppearanceId;
    transform: { x: number; y: number };
    visible: boolean;
  }): void {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), createMaterial(command.appearance));
    // Tile -> scene: scene y grows north, tile y grows south.
    mesh.position.set(command.transform.x, -command.transform.y, 0);
    mesh.visible = command.visible;
    scene.add(mesh);
    nodes.set(command.nodeId, {
      mesh,
      x: command.transform.x,
      y: command.transform.y,
      appearance: command.appearance,
      target: null,
      startMs: null,
      startX: command.transform.x,
      startY: command.transform.y,
    });
  }

  function destroyNode(nodeId: NodeId): void {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      return;
    }
    scene.remove(node.mesh);
    node.mesh.geometry.dispose();
    disposeMaterial(node.mesh.material);
    nodes.delete(nodeId);
  }

  function apply(frame: RenderFrame): void {
    for (const command of frame) {
      switch (command.type) {
        case 'node.create': {
          // A create for an existing node replaces it (idempotent materialise).
          destroyNode(command.nodeId);
          createNode(command);
          break;
        }
        case 'node.destroy': {
          destroyNode(command.nodeId);
          break;
        }
        case 'transform.set': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            // Instant by definition: snap and drop any interpolation target.
            node.x = command.transform.x;
            node.y = command.transform.y;
            node.target = null;
            node.startMs = null;
            node.mesh.position.set(node.x, -node.y, 0);
          }
          break;
        }
        case 'transform.setTarget': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            node.target = {
              x: command.transform.x,
              y: command.transform.y,
              durationMs: command.durationMs,
            };
            // `apply` reads no clock: the start time is set by the first
            // `update(nowMs)` after this command, which keeps `apply` pure.
            node.startMs = null;
            node.startX = node.x;
            node.startY = node.y;
          }
          break;
        }
        case 'visibility.set': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            node.mesh.visible = command.visible;
          }
          break;
        }
        case 'appearance.set': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            const material = createMaterial(command.appearance);
            disposeMaterial(node.mesh.material);
            node.mesh.material = material;
            node.appearance = command.appearance;
          }
          break;
        }
        default: {
          // Exhaustiveness: adding an ISA primitive is a compile error here until
          // it is handled above.
          const exhaustive: never = command;
          throw new Error(`Unhandled render command: ${String(exhaustive)}`);
        }
      }
    }
  }

  function update(nowMs: number): void {
    for (const node of nodes.values()) {
      const target = node.target;
      if (target === null) {
        continue;
      }
      if (node.startMs === null) {
        node.startMs = nowMs;
        node.startX = node.x;
        node.startY = node.y;
      }
      const elapsed = nowMs - node.startMs;
      const progress =
        target.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / target.durationMs));
      node.x = node.startX + (target.x - node.startX) * progress;
      node.y = node.startY + (target.y - node.startY) * progress;
      if (progress >= 1) {
        node.x = target.x;
        node.y = target.y;
        node.target = null;
        node.startMs = null;
      }
      node.mesh.position.set(node.x, -node.y, 0);
    }
  }

  function inspect(): RenderInspection {
    return {
      mounted,
      lights: lights.length,
      ground: ground !== null,
      camera: {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
      },
      nodes: [...nodes.entries()].map(([nodeId, node]) => ({
        nodeId,
        // Derive from the real Object3D, inverting the tile -> scene mapping, so
        // a regression in that mapping cannot hide behind bookkeeping.
        x: node.mesh.position.x,
        y: -node.mesh.position.y,
        visible: node.mesh.visible,
        appearance: node.appearance,
      })),
    };
  }

  /**
   * Size the drawing buffer and reframe the camera from the canvas' current
   * layout size. The world height is the vertical extent; the horizontal extent
   * is `height / 2 * aspect`, so one tile stays square on a non-square canvas.
   */
  function resizeRenderer(): void {
    if (renderer === null) {
      return;
    }
    const canvas = renderer.domElement;
    const width =
      canvas.clientWidth > 0 ? canvas.clientWidth : worldWidth * FALLBACK_PIXELS_PER_TILE;
    const height =
      canvas.clientHeight > 0 ? canvas.clientHeight : worldHeight * FALLBACK_PIXELS_PER_TILE;
    renderer.setSize(width, height, false);

    const aspect = height > 0 ? width / height : 1;
    const halfHeight = worldHeight / 2;
    const halfWidth = halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }

  function mount(canvas: HTMLCanvasElement): void {
    if (mounted) {
      return;
    }

    renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(globalThis.devicePixelRatio ?? 1);
    resizeRenderer();

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        resizeRenderer();
      });
      resizeObserver.observe(canvas);
    }

    const loop = (nowMs: number): void => {
      update(nowMs);
      if (renderer !== null) {
        renderer.render(scene, camera);
      }
      frameHandle = globalThis.requestAnimationFrame(loop);
    };

    mounted = true;
    frameHandle = globalThis.requestAnimationFrame(loop);
  }

  function dispose(): void {
    if (frameHandle !== null) {
      globalThis.cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }

    resizeObserver?.disconnect();
    resizeObserver = null;

    for (const nodeId of [...nodes.keys()]) {
      destroyNode(nodeId);
    }

    if (ground !== null) {
      scene.remove(ground);
      ground.geometry.dispose();
      disposeMaterial(ground.material);
      ground = null;
    }

    for (const light of lights) {
      scene.remove(light);
    }
    lights.length = 0;

    if (renderer !== null) {
      // The canvas itself is owned by the caller (React removes it on unmount).
      renderer.dispose();
      renderer = null;
    }

    mounted = false;
  }

  return { mount, apply, update, inspect, dispose };
}
