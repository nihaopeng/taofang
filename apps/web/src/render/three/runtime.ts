/**
 * The Three.js runtime: the **only** module allowed to import `three`.
 *
 * It is an *executor* of the Render ISA. It knows nothing about the game: no
 * `actor`, no `entity`, no Organizer import, no game protocol. It receives
 * opaque `NodeId` / `AppearanceId` values and maps them onto a Three.js scene
 * graph. In particular, **which scene group a node lives in is decided by the
 * runtime's PREFAB registry entry for its appearance id, never by any game
 * concept** — the ISA only ever says "a node with an appearance in a layer".
 *
 * Testability without WebGL
 * -------------------------
 * The scene **composition** (scene, groups, camera rig, lights, ground) is built
 * at construction, so `apply`, `update`, and `inspect` never touch the GPU and a
 * test can assert what the runtime owns without a WebGL context. Only
 * `mount(canvas)` constructs the `WebGLRenderer`, sizes it, wires a resize
 * observer, and starts the `requestAnimationFrame` loop.
 *
 * 2.5D coordinate mapping (runtime-only; the ISA keeps tile coordinates)
 * ---------------------------------------------------------------------
 * The world is Y-up with the ground in the XZ plane. A render tile
 * `(x, y) -> scene (x, 0, y)`, so tile `+y` (south) is scene `+z`, i.e. toward
 * the camera, and a larger tile `y` appears LOWER on screen. This mapping exists
 * **only here**: `RenderTransform` on the wire carries tile coordinates, and
 * `inspect()` inverts the real `Object3D` position back to tile space so a
 * regression in the mapping is observable in tests.
 *
 * Camera stance (frozen by Main)
 * ------------------------------
 * Orthographic, front-facing, **no yaw**, tilted down by
 * {@link RENDER_CAMERA.pitchDegrees}. The camera lives in a `CameraRig` that is
 * moved to the focus point; the camera itself is a fixed child of the rig at a
 * fixed offset/rotation. A `setFollowTarget(nodeId)` follows a node's visual
 * position with light smoothing.
 *
 * There is deliberately **no camera primitive in the ISA**: the ISA describes
 * scene content, while a camera is a viewer. A single fixed camera behaviour
 * does not justify a primitive. The extension point for multi-camera/cutscenes
 * is this rig: when a second camera must be selected/ordered by scene content,
 * that is the moment a `camera.*` primitive should be considered.
 *
 * Layer / depth / occlusion (frozen policy)
 * ----------------------------------------
 * Occlusion is resolved by a **real 3D depth buffer** plus the tilted
 * orthographic camera. There is no per-object hand-written z, and none may be
 * added. The ISA's `layer` ('base' | 'object') is coarse ordering only and is
 * applied here as a small **depth offset along the camera view axis**, so it
 * separates terrain from objects without changing their on-screen position.
 *
 * Recorded consequence: real sprite/billboard art with alpha transparency will
 * need a uniform y-sorted transparent pass applied to every transparent node —
 * still a runtime-internal policy, still never a per-object patch.
 *
 * Prefab registry / asset abstraction
 * -----------------------------------
 * `AppearanceId -> Prefab { group, defaultAnimation, motion?, createVisual() }`.
 * Prefabs are built from standard Three.js primitives only. Swapping to a sprite
 * atlas / billboards / GLTF / instanced meshes is a change to this registry
 * alone, because the ISA only ever names an appearance; the per-`(layer,
 * appearance)` `Set<NodeId>` bucket index at {@link bucketKey} is a pre-indexed
 * key whose only current consumer is `inspect()` — an instanced realisation is
 * what would consume it for real.
 *
 * The registry also owns animation vocabulary as **data**: `defaultAnimation` is
 * the animation a node rests at, and `motion?` is the placeholder motion for the
 * recorded animation. The runtime logic therefore contains no animation literal;
 * it compares/resets against `defaultAnimation` and calls `motion`.
 */

import {
  AmbientLight,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Light, Material, Object3D } from 'three';
import type {
  AnimationId,
  AppearanceId,
  NodeId,
  RenderFrame,
  RenderLayer,
} from '@starvalley/render-protocol';

/** Scene group a prefab's nodes are parented to. */
export type PrefabGroup = 'Terrain' | 'WorldObjects' | 'Actors' | 'Effects';

/**
 * A runtime-internal description of how one appearance is realised.
 *
 * This is the asset-abstraction seam: `group` decides scene organisation,
 * `createVisual()` builds the placeholder from standard primitives, and
 * `defaultAnimation`/`motion` keep animation vocabulary registry-local. It
 * deliberately carries no `footprint`/`height` metadata: the real dimensions are
 * the geometry `createVisual()` builds, measured back off that geometry (see
 * {@link measureVisualTopY}) rather than duplicated where nothing consumes them.
 */
interface Prefab {
  /** The scene group this appearance's nodes belong to. */
  readonly group: PrefabGroup;
  /** Animation a node of this appearance rests at; a completed move resets to it. */
  readonly defaultAnimation: AnimationId;
  /**
   * Optional placeholder motion for the recorded animation, applied to the visual
   * child each `update`. Absent means the appearance does not move.
   */
  readonly motion?: (animation: AnimationId, nowMs: number, visual: Group) => void;
  /** Build a fresh visual rooted at the node's feet (local origin at y = 0). */
  createVisual(): Group;
}

/**
 * Plain-data view of the runtime for tests and debugging. Never Three objects.
 *
 * `nodes` coordinates are derived from the real `Object3D` position (inverted
 * back to tile space), so the scene mapping itself is under test. `depth` is the
 * real scene-space `z`; because the camera sits on `+z` looking toward `-z`, a
 * LARGER `depth` is CLOSER to the camera and therefore in front.
 */
export interface RenderInspection {
  mounted: boolean;
  /** Number of lights the runtime still owns (0 after `dispose`). */
  lights: number;
  /** Whether the runtime's ground plane is still in the scene. */
  ground: boolean;
  /** The scene clear colour as a hex number, or `null` when unset. */
  background: number | null;
  /** Number of prefab groups still parented under `WorldRoot` (0 after `dispose`). */
  groups: number;
  /** Sun shadow configuration, or `null` once the light rig has been released. */
  shadow: { sunCasts: boolean; mapWidth: number; mapHeight: number } | null;
  /** The orthographic camera frustum plus its world position and view axes. */
  camera: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    position: { x: number; y: number; z: number };
    /** Normalised world-space direction the camera looks along. */
    forward: { x: number; y: number; z: number };
    /** Normalised world-space up direction of the camera. */
    up: { x: number; y: number; z: number };
  };
  nodes: readonly {
    nodeId: string;
    /** The node's render layer; `base` is drawn behind `object`. */
    layer: RenderLayer;
    /** The prefab group the node is parented to. */
    group: PrefabGroup;
    x: number;
    y: number;
    /** Real scene-space `z`; a LARGER value is closer to the camera. */
    depth: number;
    /** Real world-space position of the node root. */
    world: { x: number; y: number; z: number };
    /** Presentation-only yaw (radians) derived from the visual movement delta. */
    yaw: number;
    visible: boolean;
    appearance: string;
    /** Current animation: recorded from `animation.play`, or the prefab default. */
    animation: string;
    /** Animation the runtime returns this node to when a move is over. */
    defaultAnimation: string;
    /** Placeholder motion offset on the visual child (0 at rest). */
    visualY: number;
    /** Placeholder motion roll on the visual child (0 at rest). */
    visualRoll: number;
    /** Highest local Y of any mesh in the visual subtree, measured from geometry. */
    visualTopY: number;
    castsShadow: boolean;
    receivesShadow: boolean;
  }[];
  /**
   * Per-`(layer, appearance)` bucket sizes, keyed `"<layer>:<appearance>"` and
   * sorted by key. This is the batching/instancing seam made observable.
   */
  buckets: readonly { key: string; count: number }[];
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
  /** Advance transform interpolation and camera following to wall-clock `nowMs`. */
  update(nowMs: number): void;
  /**
   * Follow the visual position of `nodeId` with light smoothing, or stop
   * following (`null`). Stopping leaves the camera where it is. This is viewer
   * configuration, not scene content, which is why it is not an ISA primitive.
   */
  setFollowTarget(nodeId: NodeId | null): void;
  /** Snapshot the runtime as plain data. Works without `mount`. */
  inspect(): RenderInspection;
  /**
   * Stop the loop and release *everything* the runtime created: nodes, groups,
   * ground, lights (including shadow resources), the resize observer, the
   * renderer, and the loop handle. Terminal.
   */
  dispose(): void;
}

/** Internal per-node bookkeeping. `root` is the Three object; the rest is state. */
interface RuntimeNode {
  root: Group;
  /** Visual child; procedural placeholder motion is applied here, not to `root`. */
  visual: Group;
  layer: RenderLayer;
  group: PrefabGroup;
  /** Tile-space position (interpolated). */
  x: number;
  y: number;
  appearance: AppearanceId;
  animation: AnimationId;
  /** Animation this node's prefab rests at; a completed move resets to it. */
  defaultAnimation: AnimationId;
  /** Placeholder motion for this node's prefab, or `undefined`. */
  motion: Prefab['motion'];
  /** Highest local Y of the visual's meshes, measured from real geometry. */
  visualTopY: number;
  castsShadow: boolean;
  receivesShadow: boolean;
  /** Authoritative interpolation target, or `null` when the node is settled. */
  target: { x: number; y: number; durationMs: number } | null;
  /** Start time of the current interpolation, established by the first `update`. */
  startMs: number | null;
  startX: number;
  startY: number;
  /** Presentation-only facing (radians), smoothed toward `targetYaw`. */
  yaw: number;
  targetYaw: number;
}

/** Camera stance, frozen by Main. Exported so projection tests share one source. */
export const RENDER_CAMERA = {
  /** Downward pitch from the horizontal, in degrees. */
  pitchDegrees: 58,
  /** Camera distance from its focus point (orthographic, so scale-independent). */
  distance: 40,
  /** Extra world units of vertical half-extent so tall props are not clipped. */
  verticalHeadroom: 1,
} as const;

const PITCH_RADIANS = (RENDER_CAMERA.pitchDegrees * Math.PI) / 180;
const SIN_PITCH = Math.sin(PITCH_RADIANS);
const COS_PITCH = Math.cos(PITCH_RADIANS);

/**
 * Unit vector from the focus point toward the camera. Moving a node along it
 * changes only its depth (not its on-screen position), because the camera has no
 * yaw. That is what makes a layer offset a *depth* offset.
 */
const VIEW_AXIS = new Vector3(0, SIN_PITCH, COS_PITCH);

/**
 * Depth offset per layer, along {@link VIEW_AXIS}. `base` sits slightly farther
 * from the camera than `object`, so terrain is behind objects without any
 * per-object z fight and without moving either on screen.
 */
const LAYER_DEPTH: Readonly<Record<RenderLayer, number>> = {
  base: -0.05,
  object: 0,
};

/** Smoothing time constants (ms) for presentation motion. */
const FOLLOW_SMOOTHING_MS = 140;
const TURN_SMOOTHING_MS = 120;
/** Clamp for a single frame's delta so a long pause cannot cause a jump. */
const MAX_FRAME_DELTA_MS = 100;

/** Visible stand-in colour for an appearance id the runtime catalogue does not know. */
const FALLBACK_COLOUR = 0xe8d5a8;

/**
 * Scene clear colour, in the same family as the canvas/page background in
 * `apps/web/src/ui/styles.css`. Without it the area outside the ground plate
 * would be the WebGL default opaque black.
 */
const SCENE_BACKGROUND_COLOUR = 0x1a140e;

/**
 * Pixel size used to size the drawing buffer before the canvas has a layout
 * size. This only affects the backing store; the projection is world-sized.
 */
const FALLBACK_PIXELS_PER_TILE = 32;

function material(colour: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour });
}

function disposeMaterial(materialOrList: Material | Material[]): void {
  if (Array.isArray(materialOrList)) {
    for (const entry of materialOrList) {
      entry.dispose();
    }
    return;
  }
  materialOrList.dispose();
}

/** Recursively release the geometries/materials of a node's visual subtree. */
function disposeObject(object: Object3D): void {
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

/** Bucket key for the per-`(layer, appearance)` index. */
function bucketKey(layer: RenderLayer, appearance: AppearanceId): string {
  return `${layer}:${appearance}`;
}

/**
 * Orthographic frustum for a world size and canvas aspect.
 *
 * The world's projected DEPTH is the baseline vertical half-extent (a world
 * `height` of tiles foreshortens to `height * sin(pitch)`), plus a small headroom
 * for tall props. The world is never cropped: if half the world `width` needs
 * more horizontal room than the canvas aspect provides, the *vertical* extent is
 * grown to match, so `halfWidth / halfHeight` always equals the canvas aspect and
 * the world-to-screen scale stays uniform (tiles are never stretched). A
 * narrow/portrait canvas therefore shows extra vertical world rather than
 * clipping horizontal world off the edges.
 */
export function orthographicBounds(options: {
  worldSize: { width: number; height: number };
  aspect: number;
}): { left: number; right: number; top: number; bottom: number } {
  const depthHalfHeight =
    (options.worldSize.height / 2) * SIN_PITCH + RENDER_CAMERA.verticalHeadroom;
  const aspect = options.aspect > 0 ? options.aspect : 1;
  // A single uniform half-height must satisfy both the projected depth and the
  // full world width (`halfWidth = halfHeight * aspect >= width / 2`).
  const halfHeight = Math.max(depthHalfHeight, options.worldSize.width / 2 / aspect);
  const halfWidth = halfHeight * aspect;
  return { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight };
}

// ---------------------------------------------------------------------------
// Prefab realisation (standard primitives only; no external art)
// ---------------------------------------------------------------------------

/** A grid tile: a thin plate whose top surface sits at `surfaceY`. */
function createPlate(size: number, colour: number, surfaceY: number): Mesh {
  const plate = new Mesh(new BoxGeometry(size, 0.2, size), material(colour));
  // Top at `surfaceY`, so the box centre is 0.1 below it.
  plate.position.y = surfaceY - 0.1;
  plate.receiveShadow = true;
  return plate;
}

function createGrassVisual(): Group {
  const group = new Group();
  // Slightly inset so the dark ground shows through as grid gaps.
  group.add(createPlate(0.96, 0x5cab3f, 0));
  return group;
}

function createPathVisual(): Group {
  const group = new Group();
  // Recessed base, as before.
  group.add(createPlate(0.98, 0xc2a76b, -0.03));
  // Raised inset inlay. This is an OPAQUE geometry cue (a visible bevel/step)
  // so path reads differently from grass by shape, not colour alone. No custom
  // shader and no transparency: the depth buffer resolves it.
  group.add(createPlate(0.7, 0xb08f4f, 0.02));
  return group;
}

function createBlockedVisual(): Group {
  const group = new Group();
  group.add(createPlate(0.96, 0x454545, 0));
  const rock = new Mesh(new IcosahedronGeometry(0.32, 0), material(0x757575));
  rock.position.y = 0.24;
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);
  return group;
}

function createWaterVisual(): Group {
  const group = new Group();
  // Recessed opaque water with a lighter raised ripple patch. Opaque on purpose:
  // the depth buffer resolves it, not a transparent pass.
  group.add(createPlate(0.98, 0x2f6fb0, -0.06));
  const ripple = new Mesh(new BoxGeometry(0.5, 0.06, 0.5), material(0x63a9e0));
  ripple.position.y = -0.03;
  ripple.receiveShadow = true;
  group.add(ripple);
  return group;
}

/**
 * Character placeholder: body + head + a facing marker on the local `+z` front,
 * anchored at the feet. Its silhouette and its facing are both readable, and it
 * is opaque.
 */
function createCharacterVisual(): Group {
  const group = new Group();
  const body = new Mesh(new BoxGeometry(0.42, 0.5, 0.32), material(0x3f6fb5));
  body.position.y = 0.25;
  body.castShadow = true;

  const head = new Mesh(new SphereGeometry(0.19, 16, 12), material(0xe8c9a0));
  head.position.y = 0.63;
  head.castShadow = true;

  // Asymmetric front marker: a small nose/visor on +z, plus a backpack on -z.
  const nose = new Mesh(new BoxGeometry(0.1, 0.08, 0.12), material(0xe07a4a));
  nose.position.set(0, 0.63, 0.2);
  const pack = new Mesh(new BoxGeometry(0.26, 0.3, 0.12), material(0x2f4f7a));
  pack.position.set(0, 0.3, -0.2);

  group.add(body, head, nose, pack);
  return group;
}

/** Tree placeholder: trunk plus two stacked cones, tall enough to occlude. */
function createTreeVisual(): Group {
  const group = new Group();
  const trunk = new Mesh(new CylinderGeometry(0.12, 0.16, 1.0, 8), material(0x6b4a2b));
  trunk.position.y = 0.5;
  trunk.castShadow = true;

  const lower = new Mesh(new ConeGeometry(0.5, 0.9, 8), material(0x2f7a34));
  lower.position.y = 1.25;
  lower.castShadow = true;

  const upper = new Mesh(new ConeGeometry(0.36, 0.7, 8), material(0x3f9444));
  upper.position.y = 1.7;
  upper.castShadow = true;

  group.add(trunk, lower, upper);
  return group;
}

/** Documented fallback: a neutral opaque block for an unknown appearance. */
function createFallbackVisual(): Group {
  const group = new Group();
  const block = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), material(FALLBACK_COLOUR));
  block.position.y = 0.2;
  block.castShadow = true;
  block.receiveShadow = true;
  group.add(block);
  return group;
}

/** Animation the placeholder prefabs rest at. Registry data, never read by runtime logic. */
const IDLE_ANIMATION = 'idle' as AnimationId;

/**
 * Placeholder motion for the character: a bob/roll while walking, decaying to
 * rest otherwise. This is registry data, not runtime logic — the `walk` literal
 * lives here with the appearance it animates. It is not an animation system: no
 * clips, blending, or keyframes.
 */
const placeholderMotion: NonNullable<Prefab['motion']> = (
  animation: AnimationId,
  nowMs: number,
  visual: Group,
): void => {
  if (animation === 'walk') {
    const phase = nowMs * 0.012;
    visual.position.y = Math.abs(Math.sin(phase)) * 0.06;
    visual.rotation.z = Math.sin(phase) * 0.05;
  } else {
    visual.position.y *= 0.7;
    visual.rotation.z *= 0.7;
  }
};

/**
 * Highest local Y of any mesh in a visual, measured from the real geometry.
 * The registry carries no `height` metadata, so this is the single source of
 * truth for how tall a realisation actually is.
 */
function measureVisualTopY(visual: Object3D): number {
  let top = Number.NEGATIVE_INFINITY;
  visual.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox;
      if (box !== null) {
        top = Math.max(top, box.max.y + child.position.y);
      }
    }
  });
  return top === Number.NEGATIVE_INFINITY ? 0 : top;
}

/**
 * Shadow flags measured from the real meshes a visual created, never from
 * registry metadata. `inspect()` therefore reports what the scene graph
 * contains: a prefab that stops setting `castShadow`/`receiveShadow` fails its
 * test.
 */
function measureShadowFlags(visual: Object3D): {
  castsShadow: boolean;
  receivesShadow: boolean;
} {
  let castsShadow = false;
  let receivesShadow = false;
  visual.traverse((child) => {
    if (child instanceof Mesh) {
      castsShadow = castsShadow || child.castShadow;
      receivesShadow = receivesShadow || child.receiveShadow;
    }
  });
  return { castsShadow, receivesShadow };
}

const PREFABS: Readonly<Record<string, Prefab>> = {
  'appearance.terrain.grass': {
    group: 'Terrain',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createGrassVisual,
  },
  'appearance.terrain.path': {
    group: 'Terrain',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createPathVisual,
  },
  'appearance.terrain.blocked': {
    group: 'Terrain',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createBlockedVisual,
  },
  'appearance.terrain.water': {
    group: 'Terrain',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createWaterVisual,
  },
  'appearance.character': {
    group: 'Actors',
    defaultAnimation: IDLE_ANIMATION,
    motion: placeholderMotion,
    createVisual: createCharacterVisual,
  },
  'appearance.tree': {
    group: 'WorldObjects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createTreeVisual,
  },
  'appearance.fallback': {
    group: 'Effects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createFallbackVisual,
  },
};

/** The prefab used for an appearance id the catalogue does not know. */
const FALLBACK_PREFAB: Prefab = PREFABS['appearance.fallback'];

/**
 * Appearance ids the runtime has a prefab for. Exported so tests can assert the
 * bridge's emitted catalogue is fully covered; an unknown id still renders with
 * {@link FALLBACK_PREFAB} rather than crashing.
 */
export const KNOWN_APPEARANCES: readonly AppearanceId[] = Object.keys(PREFABS).map(
  (id) => id as AppearanceId,
);

function prefabFor(appearance: AppearanceId): Prefab {
  return PREFABS[appearance] ?? FALLBACK_PREFAB;
}

/** Normalise an angle difference into `[-π, π]`. */
function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * Create a render runtime for an authoritative world size.
 *
 * `worldSize` is required (there is no magic default): the caller that owns the
 * authoritative dimensions must supply them. The whole scene composition exists
 * immediately, so `apply` works before (and without) `mount`; only `mount` needs
 * a real canvas.
 */
export function createThreeRuntime(options: {
  worldSize: { width: number; height: number };
}): RenderRuntime {
  const worldWidth = options.worldSize.width;
  const worldHeight = options.worldSize.height;

  const scene = new Scene();
  // Fill the whole viewport, including the area outside the finite ground plate,
  // with the page-family background instead of the WebGL default black.
  const background = new Color(SCENE_BACKGROUND_COLOUR);
  scene.background = background;
  const nodes = new Map<NodeId, RuntimeNode>();
  // Per-`(layer, appearance)` node index: the seam a future instanced / atlas
  // realisation swaps behind, keyed off the same bucket the ISA already implies.
  const buckets = new Map<string, Set<NodeId>>();

  // Centre of the tile grid in render space.
  const centerX = (worldWidth - 1) / 2;
  const centerZ = (worldHeight - 1) / 2;

  // Scene graph: WorldRoot -> { Terrain, WorldObjects, Actors, Effects }.
  const worldRoot = new Group();
  worldRoot.name = 'WorldRoot';
  const groups: Record<PrefabGroup, Group> = {
    Terrain: new Group(),
    WorldObjects: new Group(),
    Actors: new Group(),
    Effects: new Group(),
  };
  for (const [name, group] of Object.entries(groups)) {
    group.name = name;
    worldRoot.add(group);
  }
  scene.add(worldRoot);

  const cameraRig = new Group();
  cameraRig.name = 'CameraRig';
  const cameraFocus = new Vector3(centerX, 0, centerZ);
  cameraRig.position.copy(cameraFocus);
  scene.add(cameraRig);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  // Fixed child of the rig: offset up/back along the view axis and pitched down.
  camera.position.set(
    0,
    RENDER_CAMERA.distance * SIN_PITCH,
    RENDER_CAMERA.distance * COS_PITCH,
  );
  camera.rotation.set(-PITCH_RADIANS, 0, 0);
  cameraRig.add(camera);
  const initialBounds = orthographicBounds({
    worldSize: { width: worldWidth, height: worldHeight },
    aspect: worldWidth / worldHeight,
  });
  camera.left = initialBounds.left;
  camera.right = initialBounds.right;
  camera.top = initialBounds.top;
  camera.bottom = initialBounds.bottom;
  camera.updateProjectionMatrix();

  const groundGeometry = new PlaneGeometry(worldWidth, worldHeight);
  const groundMaterial = new MeshStandardMaterial({ color: 0x241c14 });
  let ground: Mesh | null = new Mesh(groundGeometry, groundMaterial);
  // Ground lies in the XZ plane, slightly below the tile plates.
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centerX, -0.3, centerZ);
  ground.receiveShadow = true;
  scene.add(ground);

  const lightsGroup = new Group();
  lightsGroup.name = 'Lights';
  const ambient = new AmbientLight(0xffffff, 0.7);
  const sunLight = new DirectionalLight(0xffffff, 1.15);
  let sun: DirectionalLight | null = sunLight;
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const shadowExtent = Math.max(worldWidth, worldHeight) / 2 + 4;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 80;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.position.set(centerX + 6, 14, centerZ + 6);
  sunLight.target.position.set(centerX, 0, centerZ);
  lightsGroup.add(ambient, sunLight, sunLight.target);
  scene.add(lightsGroup);
  const lights: Light[] = [ambient, sunLight];

  let followNodeId: NodeId | null = null;
  // Separate from the frame clock: follow smoothing re-baselines when the
  // target changes, without perturbing interpolation/turn timing.
  let lastFollowMs: number | null = null;
  let lastFrameMs: number | null = null;

  let mounted = false;
  let renderer: WebGLRenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let frameHandle: number | null = null;

  function addToBucket(layer: RenderLayer, appearance: AppearanceId, nodeId: NodeId): void {
    const key = bucketKey(layer, appearance);
    let set = buckets.get(key);
    if (set === undefined) {
      set = new Set<NodeId>();
      buckets.set(key, set);
    }
    set.add(nodeId);
  }

  function removeFromBucket(
    layer: RenderLayer,
    appearance: AppearanceId,
    nodeId: NodeId,
  ): void {
    const key = bucketKey(layer, appearance);
    const set = buckets.get(key);
    if (set === undefined) {
      return;
    }
    set.delete(nodeId);
    if (set.size === 0) {
      buckets.delete(key);
    }
  }

  /** Place a node's root from its tile position, applying the layer depth offset. */
  function positionNode(node: RuntimeNode): void {
    node.root.position.set(node.x, 0, node.y).addScaledVector(VIEW_AXIS, LAYER_DEPTH[node.layer]);
    node.root.rotation.y = node.yaw;
  }

  function createNode(command: {
    nodeId: NodeId;
    layer: RenderLayer;
    appearance: AppearanceId;
    transform: { x: number; y: number };
    visible: boolean;
  }): void {
    const prefab = prefabFor(command.appearance);
    const root = new Group();
    const visual = prefab.createVisual();
    root.add(visual);
    groups[prefab.group].add(root);
    const shadowFlags = measureShadowFlags(visual);
    const node: RuntimeNode = {
      root,
      visual,
      layer: command.layer,
      group: prefab.group,
      x: command.transform.x,
      y: command.transform.y,
      appearance: command.appearance,
      animation: prefab.defaultAnimation,
      defaultAnimation: prefab.defaultAnimation,
      motion: prefab.motion,
      visualTopY: measureVisualTopY(visual),
      castsShadow: shadowFlags.castsShadow,
      receivesShadow: shadowFlags.receivesShadow,
      target: null,
      startMs: null,
      startX: command.transform.x,
      startY: command.transform.y,
      yaw: 0,
      targetYaw: 0,
    };
    root.visible = command.visible;
    positionNode(node);
    nodes.set(command.nodeId, node);
    addToBucket(command.layer, command.appearance, command.nodeId);
  }

  function destroyNode(nodeId: NodeId): void {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      return;
    }
    node.root.parent?.remove(node.root);
    disposeObject(node.root);
    removeFromBucket(node.layer, node.appearance, nodeId);
    nodes.delete(nodeId);
  }

  /** Swap an existing node's appearance, moving its group if the prefab requires. */
  function setAppearance(node: RuntimeNode, nodeId: NodeId, appearance: AppearanceId): void {
    const prefab = prefabFor(appearance);
    node.root.remove(node.visual);
    disposeObject(node.visual);
    node.visual = prefab.createVisual();
    node.root.add(node.visual);
    if (node.group !== prefab.group) {
      node.root.parent?.remove(node.root);
      groups[prefab.group].add(node.root);
      node.group = prefab.group;
    }
    const shadowFlags = measureShadowFlags(node.visual);
    node.defaultAnimation = prefab.defaultAnimation;
    node.motion = prefab.motion;
    node.visualTopY = measureVisualTopY(node.visual);
    node.castsShadow = shadowFlags.castsShadow;
    node.receivesShadow = shadowFlags.receivesShadow;
    removeFromBucket(node.layer, node.appearance, nodeId);
    addToBucket(node.layer, appearance, nodeId);
    node.appearance = appearance;
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
            // A snap ends any move just as completing the interpolation does.
            node.animation = node.defaultAnimation;
            positionNode(node);
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
            node.root.visible = command.visible;
          }
          break;
        }
        case 'appearance.set': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            setAppearance(node, command.nodeId, command.appearance);
          }
          break;
        }
        case 'animation.play': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            // Recorded, and observable through `inspect()`. `loop` is accepted
            // and deliberately unused: placeholder motion below has no clip to
            // loop, so there is no looping behaviour to implement honestly yet.
            node.animation = command.animation;
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

  /**
   * Apply the placeholder motion the node's prefab declares. This is NOT an
   * animation system: there are no clips, blending, or keyframes. The runtime
   * deliberately holds no animation literal — the prefab's `motion` owns what
   * each recorded animation looks like, and it writes to the visual child so the
   * node's feet anchor never moves.
   */
  function updateVisualMotion(node: RuntimeNode, nowMs: number): void {
    node.motion?.(node.animation, nowMs, node.visual);
  }

  function update(nowMs: number): void {
    const frameDt =
      lastFrameMs === null ? 0 : Math.max(0, Math.min(nowMs - lastFrameMs, MAX_FRAME_DELTA_MS));
    lastFrameMs = nowMs;
    const turnAlpha = frameDt === 0 ? 0 : 1 - Math.exp(-frameDt / TURN_SMOOTHING_MS);

    for (const node of nodes.values()) {
      const target = node.target;
      if (target !== null) {
        if (node.startMs === null) {
          node.startMs = nowMs;
          node.startX = node.x;
          node.startY = node.y;
        }
        const elapsed = nowMs - node.startMs;
        const progress =
          target.durationMs <= 0
            ? 1
            : Math.min(1, Math.max(0, elapsed / target.durationMs));
        node.x = node.startX + (target.x - node.startX) * progress;
        node.y = node.startY + (target.y - node.startY) * progress;
        if (progress >= 1) {
          node.x = target.x;
          node.y = target.y;
          node.target = null;
          node.startMs = null;
          // The runtime owns WHEN a move is over: it interpolated to the target,
          // so it — not the bridge — returns the node to its rest animation. The
          // bridge has no further frame after the last move to emit a settle on.
          node.animation = node.defaultAnimation;
        }
        // Presentation-only facing from the visual movement delta (tile space,
        // where local +z is the actor's front).
        node.targetYaw = Math.atan2(target.x - node.startX, target.y - node.startY);
        node.yaw += shortestAngle(node.yaw, node.targetYaw) * turnAlpha;
        positionNode(node);
      }
      updateVisualMotion(node, nowMs);
    }

    // Camera following: smooth the rig focus toward the followed node's visual
    // (interpolated) position. `null` leaves the focus where it is.
    if (followNodeId !== null) {
      const followed = nodes.get(followNodeId);
      if (followed !== undefined) {
        const followDt =
          lastFollowMs === null
            ? 0
            : Math.max(0, Math.min(nowMs - lastFollowMs, MAX_FRAME_DELTA_MS));
        lastFollowMs = nowMs;
        const followAlpha =
          followDt === 0 ? 0 : 1 - Math.exp(-followDt / FOLLOW_SMOOTHING_MS);
        cameraFocus.x += (followed.x - cameraFocus.x) * followAlpha;
        cameraFocus.z += (followed.y - cameraFocus.z) * followAlpha;
        cameraRig.position.set(cameraFocus.x, 0, cameraFocus.z);
      }
    }
  }

  function inspect(): RenderInspection {
    camera.updateMatrixWorld(true);
    const cameraWorld = new Vector3();
    camera.getWorldPosition(cameraWorld);
    const cameraQuaternion = camera.getWorldQuaternion(new Quaternion());
    const cameraForward = new Vector3(0, 0, -1).applyQuaternion(cameraQuaternion).normalize();
    const cameraUp = new Vector3(0, 1, 0).applyQuaternion(cameraQuaternion).normalize();
    const nodeList = [...nodes.entries()].map(([nodeId, node]) => {
      // Invert the runtime-only tile -> scene mapping from the real Object3D.
      // `y` removes the layer's depth offset so a base tile still reads as its
      // own tile row; `depth` is the raw scene-space z used for occlusion.
      const depthOffset = LAYER_DEPTH[node.layer] * COS_PITCH;
      const position = node.root.position;
      return {
        nodeId,
        layer: node.layer,
        group: node.group,
        x: position.x,
        y: position.z - depthOffset,
        depth: position.z,
        world: { x: position.x, y: position.y, z: position.z },
        yaw: node.yaw,
        visible: node.root.visible,
        appearance: node.appearance,
        animation: node.animation,
        defaultAnimation: node.defaultAnimation,
        visualY: node.visual.position.y,
        visualRoll: node.visual.rotation.z,
        visualTopY: node.visualTopY,
        castsShadow: node.castsShadow,
        receivesShadow: node.receivesShadow,
      };
    });
    return {
      mounted,
      lights: lights.length,
      ground: ground !== null,
      background: scene.background instanceof Color ? scene.background.getHex() : null,
      groups: worldRoot.children.length,
      shadow:
        sun === null
          ? null
          : {
              sunCasts: sun.castShadow,
              mapWidth: sun.shadow.mapSize.width,
              mapHeight: sun.shadow.mapSize.height,
            },
      camera: {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        position: { x: cameraWorld.x, y: cameraWorld.y, z: cameraWorld.z },
        forward: { x: cameraForward.x, y: cameraForward.y, z: cameraForward.z },
        up: { x: cameraUp.x, y: cameraUp.y, z: cameraUp.z },
      },
      nodes: nodeList,
      buckets: [...buckets.entries()]
        .map(([key, set]) => ({ key, count: set.size }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    };
  }

  /**
   * Size the drawing buffer and reframe the camera from the canvas' current
   * layout size. See {@link orthographicBounds} for the projection policy.
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
    const bounds = orthographicBounds({
      worldSize: { width: worldWidth, height: worldHeight },
      aspect,
    });
    camera.left = bounds.left;
    camera.right = bounds.right;
    camera.top = bounds.top;
    camera.bottom = bounds.bottom;
    camera.updateProjectionMatrix();
  }

  function mount(canvas: HTMLCanvasElement): void {
    if (mounted) {
      return;
    }

    renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(globalThis.devicePixelRatio ?? 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
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

  function setFollowTarget(nodeId: NodeId | null): void {
    if (nodeId === followNodeId) {
      return;
    }
    followNodeId = nodeId;
    // Re-baseline smoothing so changing the target cannot cause a jump.
    lastFollowMs = null;
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

    for (const group of Object.values(groups)) {
      group.clear();
      worldRoot.remove(group);
    }
    scene.remove(worldRoot);

    if (ground !== null) {
      scene.remove(ground);
      ground.geometry.dispose();
      disposeMaterial(ground.material);
      ground = null;
    }

    for (const light of lights) {
      scene.remove(light);
      lightsGroup.remove(light);
    }
    lights.length = 0;
    if (sun !== null) {
      // Shadow map textures are GPU resources owned by the light; release them.
      sun.shadow.map?.dispose();
      sun = null;
    }
    scene.remove(lightsGroup);

    scene.remove(cameraRig);
    scene.background = null;

    if (renderer !== null) {
      // The canvas itself is owned by the caller (React removes it on unmount).
      renderer.dispose();
      renderer = null;
    }

    mounted = false;
  }

  return { mount, apply, update, setFollowTarget, inspect, dispose };
}
