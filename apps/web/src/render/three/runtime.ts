/**
 * The Three.js runtime: the **only** module allowed to import `three`.
 *
 * It is an *executor* of the Render ISA. It knows nothing about the game: no
 * gameplay vocabulary in its logic, no Organizer import, no game protocol. It
 * receives opaque `NodeId` / `AppearanceId` values and maps them onto a Three.js
 * scene graph. **Which scene group a node lives in is decided by the runtime's
 * PREFAB registry entry for its appearance id, never by any game concept** — the
 * ISA only ever says "a node with an appearance in a layer".
 *
 * Testability without WebGL
 * -------------------------
 * The scene **composition** (scene, groups, camera rig, lights, ground) is built
 * at construction, so `apply`, `update`, and `inspect` never touch the GPU and a
 * test can assert what the runtime owns without a WebGL context. Only
 * `mount(canvas)` constructs the `WebGLRenderer`, sizes it, wires a resize
 * observer, and starts the `requestAnimationFrame` loop.
 *
 * World-space placement (phase 7)
 * -------------------------------
 * Nodes are placed **directly at their authoritative world transform**. There is
 * no tile/cell interpretation, no tile -> scene mapping, and no per-layer
 * positional offset: `inspect()` reports real world positions with no inversion.
 * The only ordering rule is `renderOrder` (the `base` layer draws before the
 * `object` layer); every other occlusion decision is the real depth buffer's.
 * Because there is no per-object `z`, an object's on-screen position is fully a
 * function of its world transform and the camera's pitch/yaw.
 *
 * CameraRig (the only place "2.5D" is allowed to live)
 * ---------------------------------------------------
 * The rig owns follow + smoothing, a **constrained** pitch, free yaw, and zoom.
 * It is deliberately **orthographic** — that is the 2.5D look and the pragmatic
 * choice — but the rig is the *only* thing that would change to switch to a
 * perspective camera: the world model, the Actor motion model, and the Render ISA
 * carry no projection assumption. Yaw rotates the rig (and therefore the view);
 * it never changes the world coordinate system.
 *
 * `inspect()` exposes the rig as plain data (`pitchDegrees`, `yawDegrees`,
 * `zoom`, the frustum, and the camera's world position/forward/up) so tests can
 * assert pitch clamping, yaw view changes, and zoom extent numerically.
 *
 * Layer / depth / occlusion (frozen policy)
 * ----------------------------------------
 * Occlusion is resolved by a **real 3D depth buffer** plus the tilted camera.
 * There is no per-object hand-written z, and none may be added. The ISA's
 * `layer` ('base' | 'object') is coarse ordering only and is applied here as
 * `renderOrder`.
 *
 * Prefab registry / asset abstraction
 * -----------------------------------
 * `AppearanceId -> Prefab { group, defaultAnimation, motion?, createVisual() }`.
 * The appearance ids below are **opaque catalogue keys** (data), not game logic:
 * the runtime never interprets them. Prefabs are built from standard Three.js
 * primitives only. Swapping to a sprite atlas / billboards / GLTF / instanced
 * meshes is a change to this registry alone, because the ISA only ever names an
 * appearance; the per-`(layer, appearance)` `Set<NodeId>` bucket index at
 * {@link bucketKey} is a pre-indexed key whose only current consumer is
 * `inspect()` — an instanced realisation is what would consume it for real.
 *
 * The registry also owns animation vocabulary as **data**: `defaultAnimation` is
 * the animation a node rests at, and `motion?` is the placeholder motion for the
 * recorded animation. The runtime logic therefore contains no animation literal;
 * it compares/resets against `defaultAnimation` and calls `motion`.
 */

import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  SkinnedMesh,
  SphereGeometry,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Light, Material, Object3D } from 'three';
// `three/examples/jsm/*` is importable here (and only here) under the lint
// boundary. The default loader is the real GLTFLoader; tests inject a loader so
// they never touch the network, and a checked-in fixture exercises this path.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type {
  AnimationId,
  AppearanceId,
  NodeId,
  RenderFrame,
  RenderLayer,
  RenderTransform,
} from '@starvalley/render-protocol';

import { MODEL_CATALOGUE } from './assets';
import type { AppearanceModelCatalogue, ModelAsset } from './assets';

/** Scene group a prefab's nodes are parented to. */
export type PrefabGroup = 'Terrain' | 'WorldObjects' | 'Actors' | 'Effects';

/**
 * How a node's visual is currently realised.
 *
 * `placeholder` also covers "no asset configured" (the catalogue has no entry),
 * so the placeholder is always a valid, visible state. `loading`/`failed` keep the
 * placeholder on screen: a missing or slow asset must never blank a node.
 */
export type ModelState = 'placeholder' | 'loading' | 'loaded' | 'failed';

/**
 * Resolves a GLB URL to a parsed template `Object3D`.
 *
 * Injected so tests never touch the network. The default is the real
 * `GLTFLoader` (see `loadGlbTemplate`); the runtime caches one parse per URL and
 * clones per node.
 */
export type ModelLoader = (url: string) => Promise<Object3D>;

/**
 * Plain-data result of `pick(ndcX, ndcY)`: a registered node visual, the
 * mathematical ground plane, or nothing.
 *
 * It returns no Three.js object and no camera/ray data, because none of those may
 * ever reach a command. `nodeId` is the runtime's own opaque id; mapping it to
 * game identity is the bridge's job, not the runtime's.
 */
export type RenderPick =
  | { readonly kind: 'node'; readonly nodeId: NodeId }
  | {
      readonly kind: 'ground';
      readonly point: { readonly x: number; readonly y: number; readonly z: number };
    }
  | null;

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

/** Plain-data snapshot of the camera rig: the only place 2.5D lives. */
export interface CameraState {
  /** Downward pitch from the horizontal, in degrees, within the rig's limits. */
  pitchDegrees: number;
  /** Yaw about `+Y`, in degrees, normalised to `[0, 360)`. */
  yawDegrees: number;
  /** Orthographic zoom factor; larger is closer. */
  zoom: number;
  /** World-space point the rig follows/looks at. */
  focus: { x: number; y: number; z: number };
}

/**
 * Plain-data view of the runtime for tests and debugging. Never Three objects.
 *
 * `nodes[].world`/`rotation`/`yaw` are read back off the node root's real
 * `Object3D` world transform (not the runtime's bookkeeping copies), so they pin
 * what the scene graph actually contains.
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
  /** Number of GLB templates currently parsed and cached (0 after `dispose`). */
  models: number;
  /**
   * GPU resources released so far (geometry/material/texture). Non-decreasing
   * across a runtime's life; lets a test prove `dispose()` actually released the
   * loaded model rather than only forgetting it.
   */
  released: { geometries: number; materials: number; textures: number };
  /** The camera rig state and the orthographic frustum it produces. */
  camera: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    /** Constrained downward pitch, in degrees. */
    pitchDegrees: number;
    /** Free yaw, in degrees, normalised to `[0, 360)`. */
    yawDegrees: number;
    /** Orthographic zoom factor; larger is closer. */
    zoom: number;
    /** World-space rig focus. */
    focus: { x: number; y: number; z: number };
    position: { x: number; y: number; z: number };
    /** Normalised world-space direction the camera looks along. */
    forward: { x: number; y: number; z: number };
    /** Normalised world-space up direction of the camera. */
    up: { x: number; y: number; z: number };
  };
  nodes: readonly {
    nodeId: string;
    /** The node's render layer; `base` is drawn before `object` via render order. */
    layer: RenderLayer;
    /** The prefab group the node is parented to. */
    group: PrefabGroup;
    /** Draw order applied to the node root (`base` before `object`). */
    renderOrder: number;
    /** Real world-space position read off the node root's `Object3D`, no inversion. */
    world: { x: number; y: number; z: number };
    /** The node root's real world rotation, read off its `Object3D`. */
    rotation: { x: number; y: number; z: number; w: number };
    /** Yaw about `+Y` (radians) extracted from {@link rotation}. */
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
    /**
     * Highest local Y of any mesh in the node's visual subtree, relative to the
     * node root, with the visual's own scale/anchor and every nested transform
     * applied. This is the visual's real height above its feet, so it includes a
     * catalogue `scale`/`yOffset` on a loaded model.
     */
    visualTopY: number;
    /** How this node's visual is realised: placeholder, loading, loaded, or failed. */
    model: ModelState;
    /**
     * Plain-data identity of the skeleton driving this node's visual, or `null`
     * for a non-skinned visual. Two node clones with independent skeletons have
     * different ids; a plain (non-skeleton-aware) clone shares the template's.
     */
    skeletonId: string | null;
    castsShadow: boolean;
    receivesShadow: boolean;
  }[];
  /**
   * Per-`(layer, appearance)` bucket sizes, keyed `"<layer>:<appearance>"` and
   * sorted by key. This is the batching/instancing seam made observable.
   */
  buckets: readonly { key: string; count: number }[];
}

/** Structural world AABB the runtime frames; deliberately not the Organizer type. */
export interface RuntimeWorldBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
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
  /** Read the rig state as plain data (yaw is what camera-relative input needs). */
  getCameraState(): CameraState;
  /**
   * Set the rig's pitch and/or yaw. Pitch is clamped to the rig's limits; yaw is
   * normalised to `[0, 360)`. Rotating the rig never changes world coordinates.
   */
  setCameraOrientation(orientation: { pitchDegrees?: number; yawDegrees?: number }): void;
  /** Set the orthographic zoom factor (clamped to the rig's limits). */
  setZoom(zoom: number): void;
  /**
   * Resolve a normalized device coordinate (`[-1, 1]`, origin centre, `+y` up)
   * to plain pick data:
   *
   * 1. a registered `object`-layer node visual under the ray ->
   *    `{ kind: 'node', nodeId }` (terrain `base` plates are the visible ground
   *    and are never nodes here);
   * 2. otherwise the mathematical ground plane (`y = bounds.min.y`) ->
   *    `{ kind: 'ground', point }`;
   * 3. otherwise `null`.
   *
   * A ground hit outside `bounds` returns `null`: there is no clamping and no
   * gameplay rule here. Node visuals win over the ground even when the ground is
   * closer, so a click on a tall prop never falls through to a move intent.
   *
   * This is a runtime QUERY, not an ISA primitive: it needs the camera matrix,
   * which is exactly why it can never leave the client.
   */
  pick(ndcX: number, ndcY: number): RenderPick;
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
  /** Authoritative world position (interpolated), applied verbatim to `root`. */
  world: Vector3;
  /** Authoritative rotation (interpolated), applied verbatim to `root`. */
  rotation: Quaternion;
  appearance: AppearanceId;
  animation: AnimationId;
  /** Animation this node's prefab rests at; a completed move resets to it. */
  defaultAnimation: AnimationId;
  /** Placeholder motion for this node's prefab, or `undefined`. */
  motion: Prefab['motion'];
  /** Highest local Y of the visual's meshes, relative to the node root (see {@link measureVisualTopY}). */
  visualTopY: number;
  /**
   * Whether this node owns the geometry/materials of `visual`.
   * Placeholder visuals are built per node and are disposed with the node; a
   * loaded GLB clone shares the cached template's resources and must NOT be
   * disposed when the node is destroyed (that would free resources a sibling is
   * still drawing). Template resources are released once in `dispose()`.
   */
  ownsVisual: boolean;
  /** How the visual is realised (placeholder always renders until a model swaps in). */
  modelState: ModelState;
  /** Bumped whenever `visual` is replaced; invalidates a stale in-flight load. */
  visualToken: number;
  /**
   * Prefab-declared shadow intent (captured from the placeholder at
   * create/setAppearance). A swapped model re-applies this intent to its meshes
   * rather than measuring the imported clone, whose flags default to false.
   */
  castsShadow: boolean;
  receivesShadow: boolean;
  /** Authoritative interpolation target, or `null` when the node is settled. */
  target: { world: Vector3; rotation: Quaternion; durationMs: number } | null;
  /** Start time of the current interpolation, established by the first `update`. */
  startMs: number | null;
  startWorld: Vector3;
  startRotation: Quaternion;
}

/** Camera stance, frozen by Main. Exported so projection tests share one source. */
export const RENDER_CAMERA = {
  /** Default downward pitch from the horizontal, in degrees. */
  pitchDegrees: 58,
  /** Pitch constraint: below this the world reads as a flat top-down map. */
  minPitchDegrees: 20,
  /** Pitch constraint: at/above this the camera is effectively level. */
  maxPitchDegrees: 80,
  /** Camera distance from its focus point (orthographic, so scale-independent). */
  distance: 40,
  /** Extra world units of vertical half-extent so tall props are not clipped. */
  verticalHeadroom: 1,
  /** Zoom constraint: smallest magnification (most zoomed out). */
  minZoom: 0.25,
  /** Zoom constraint: largest magnification (most zoomed in). */
  maxZoom: 8,
} as const;

/**
 * Draw order per layer. Nodes of every layer sit at their exact world position;
 * this only sequences the draw so the `base` layer is submitted before the
 * `object` layer. Real occlusion is the 3D depth buffer's job.
 */
const LAYER_RENDER_ORDER: Readonly<Record<RenderLayer, number>> = {
  base: 0,
  object: 1,
};

/** Smoothing time constants (ms) for presentation motion. */
const FOLLOW_SMOOTHING_MS = 140;
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
const FALLBACK_PIXELS_PER_UNIT = 32;

const DEGREES_TO_RADIANS = Math.PI / 180;

function material(colour: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour });
}

/** How many GPU resources a release pass freed. */
interface ReleaseCounts {
  geometries: number;
  materials: number;
  textures: number;
}

function emptyReleaseCounts(): ReleaseCounts {
  return { geometries: 0, materials: 0, textures: 0 };
}

/** Release a material (or list) and every texture it references. */
function releaseMaterial(materialOrList: Material | Material[]): ReleaseCounts {
  const counts = emptyReleaseCounts();
  const list = Array.isArray(materialOrList) ? materialOrList : [materialOrList];
  for (const entry of list) {
    // Release textures referenced by the material before the material itself.
    // Iterating own enumerable values covers `map`/`normalMap`/`emissiveMap`/...
    // without hardcoding a texture-slot list that a future asset could exceed.
    for (const value of Object.values(entry)) {
      if (value instanceof Texture) {
        value.dispose();
        counts.textures += 1;
      }
    }
    entry.dispose();
    counts.materials += 1;
  }
  return counts;
}

/**
 * Recursively release a subtree's GPU resources: every mesh geometry, material
 * and material-referenced texture.
 *
 * Returns counts so `inspect()` can prove disposal actually happened. Callers
 * must only pass a subtree the runtime OWNS. A loaded GLB clone shares its
 * geometry/materials with the cached template (and with sibling clones), so
 * releasing a clone would free resources another node is still drawing; model
 * resources are released once, from the template, in `dispose()`.
 */
function releaseObject(object: Object3D): ReleaseCounts {
  const counts = emptyReleaseCounts();
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      counts.geometries += 1;
      const materialCounts = releaseMaterial(child.material);
      counts.materials += materialCounts.materials;
      counts.textures += materialCounts.textures;
    }
  });
  return counts;
}

/**
 * Material policy: **opaque or `alphaTest` only**.
 *
 * A blended material (`transparent === true`) needs a uniform back-to-front
 * y-sorted transparent pass, which does not exist yet. Allowing one would let a
 * model draw in arbitrary order and corrupt the depth-buffer occlusion guarantee.
 * A blended material is therefore coerced into an alpha-tested cutout: keep the
 * diffuse/alpha map, set `transparent = false`, raise `alphaTest` above zero so
 * the cutout still discards, and keep depth writes on. This runs ONCE per parsed
 * template, so every clone shares the coerced material.
 *
 * The coercion is reported once per coerced material: an artist who authored a
 * real blend gets a warning naming the material and the asset it came from,
 * so a silently-opaque result is discoverable.
 *
 * @param source the asset URL the template was parsed from, for the report.
 */
function applyOpaqueMaterialPolicy(root: Object3D, source: string): void {
  const coerced = new Set<Material>();
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const entry of list) {
      if (entry.transparent === true && !coerced.has(entry)) {
        coerced.add(entry);
        entry.transparent = false;
        entry.alphaTest = Math.max(entry.alphaTest, 0.5);
        entry.depthWrite = true;
        entry.needsUpdate = true;
        console.warn(
          `[render] material "${entry.name || '(unnamed)'}" in "${source}" was authored transparent but coerced to opaque alphaTest=${entry.alphaTest}; blended transparency has no y-sorted pass yet`,
        );
      }
    }
  });
}

/** Whether a template contains a skinned mesh (choose the clone routine). */
function hasSkinnedMesh(root: Object3D): boolean {
  let skinned = false;
  root.traverse((child) => {
    if (child instanceof SkinnedMesh) {
      skinned = true;
    }
  });
  return skinned;
}

/**
 * Clone a parsed template for one node. A skinned template needs
 * `SkeletonUtils.clone` (it rebinds the skeleton); anything else uses the cheap
 * `Object3D.clone(true)`. Geometry and material are shared with the template by
 * design, so N nodes cost one parse and one set of GPU resources.
 */
function cloneTemplate(template: Object3D): Object3D {
  return hasSkinnedMesh(template) ? cloneSkinned(template) : template.clone(true);
}

/** Apply the catalogue's presentation fixes to a freshly cloned model visual. */
function applyAssetFixes(visual: Group, asset: ModelAsset): void {
  if (asset.scale !== undefined) {
    visual.scale.set(asset.scale.x, asset.scale.y, asset.scale.z);
  }
  if (asset.yawRadians !== undefined) {
    visual.rotation.y = asset.yawRadians;
  }
  if (asset.yOffset !== undefined) {
    visual.position.y = asset.yOffset;
  }
}

/**
 * Production model loader: the real `GLTFLoader`, one parse per call.
 *
 * Extension point: DRACO / KTX2 decoder registration belongs HERE, on the loader
 * instance before `loadAsync` (e.g. `loader.setDRACOLoader(...)` /
 * `loader.setKTX2Loader(...)`). A decoder also owns a worker pool that
 * `dispose()` cannot release, so adding one would need a runtime-level teardown.
 */
export async function loadGlbTemplate(url: string): Promise<Object3D> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return gltf.scene;
}

/** Bucket key for the per-`(layer, appearance)` index. */
function bucketKey(layer: RenderLayer, appearance: AppearanceId): string {
  return `${layer}:${appearance}`;
}

/**
 * Yaw about `+Y` (radians) extracted from a rotation, for inspection only.
 *
 * The prefab front faces its local `+Z`, so this is the actor's heading in the
 * world's convention (`yaw = atan2(vx, vz)`): yaw 0 faces `+Z`.
 */
function yawFromRotation(rotation: Quaternion): number {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.x * rotation.x),
  );
}

/**
 * Orthographic frustum that frames the world's ground rectangle for the rig's
 * current pitch/yaw/zoom and a canvas aspect.
 *
 * The world bounds' XZ footprint (at ground level) is projected onto the
 * camera's own right/up axes, so the fit is correct for yaw too: rotating the
 * rig widens the projected footprint (up to the box diagonal) and the whole
 * world stays visible. A small vertical headroom keeps tall props off the clip
 * edge. The single uniform half-height satisfies both the projected footprint
 * and the canvas aspect, so `halfWidth / halfHeight` always equals the aspect
 * and world-to-screen scale stays uniform (nothing is stretched). Finally the
 * whole frustum is divided by `zoom` (larger zoom is closer).
 */
export function orthographicBounds(options: {
  bounds: RuntimeWorldBounds;
  aspect: number;
  pitchDegrees: number;
  yawDegrees: number;
  zoom: number;
}): { left: number; right: number; top: number; bottom: number } {
  const pitch = options.pitchDegrees * DEGREES_TO_RADIANS;
  const yaw = options.yawDegrees * DEGREES_TO_RADIANS;
  const sinPitch = Math.sin(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);

  // Camera basis in world space: the rig yaw is applied about `+Y` to a camera
  // whose local -Z is pitched down by `pitch`.
  //   right = Ry(yaw) * (1, 0, 0)
  //   up    = Ry(yaw) * (0, cosPitch, -sinPitch)
  const rightX = cosYaw;
  const rightZ = -sinYaw;
  const upX = -sinPitch * sinYaw;
  const upZ = -sinPitch * cosYaw;

  const halfWidth = (options.bounds.max.x - options.bounds.min.x) / 2;
  const halfDepth = (options.bounds.max.z - options.bounds.min.z) / 2;

  let extentRight = 0;
  let extentUp = 0;
  for (const signX of [-1, 1]) {
    for (const signZ of [-1, 1]) {
      const dx = signX * halfWidth;
      const dz = signZ * halfDepth;
      extentRight = Math.max(extentRight, Math.abs(dx * rightX + dz * rightZ));
      extentUp = Math.max(extentUp, Math.abs(dx * upX + dz * upZ));
    }
  }

  const aspect = options.aspect > 0 ? options.aspect : 1;
  const zoom = options.zoom > 0 ? options.zoom : 1;
  const vertical = extentUp + RENDER_CAMERA.verticalHeadroom;
  const halfHeight = Math.max(vertical, extentRight / aspect) / zoom;
  const halfWidthFinal = halfHeight * aspect;
  return {
    left: -halfWidthFinal,
    right: halfWidthFinal,
    top: halfHeight,
    bottom: -halfHeight,
  };
}

// ---------------------------------------------------------------------------
// Prefab realisation (standard primitives only; no external art)
// ---------------------------------------------------------------------------

/** A ground plate: a thin box whose top surface sits at `surfaceY`. */
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
 * is opaque. The local `+Z` front matches the frozen heading convention
 * (`yaw = atan2(vx, vz)`), so applying the authoritative quaternion turns the
 * marker to face the authoritative heading with no extra derivation.
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

/** Reused across `measureVisualTopY` calls so the measurement does not allocate. */
const scratchParentInverse = new Matrix4();
const scratchTransform = new Matrix4();
const scratchBox = new Box3();

/**
 * Highest local Y of any mesh in a visual, relative to the node root, measured
 * from the real geometry and every transform in between.
 *
 * The registry carries no `height` metadata, so this is the single source of
 * truth for how tall a realisation actually is. Measuring with each mesh's full
 * matrix relative to the root (instead of naively adding `child.position.y`)
 * means a nested or rotated mesh, and the catalogue's `scale`/`yawRadians`/
 * `yOffset` on the model wrapper, all contribute. The node's own authoritative
 * world transform cancels, so the result is the visual's height above its feet
 * and does not go stale when the node later moves.
 */
function measureVisualTopY(visual: Object3D): number {
  visual.updateWorldMatrix(true, true);
  if (visual.parent !== null) {
    scratchParentInverse.copy(visual.parent.matrixWorld).invert();
  } else {
    scratchParentInverse.identity();
  }
  let top = Number.NEGATIVE_INFINITY;
  visual.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const geometry = child.geometry;
    if (geometry.boundingBox === null) {
      geometry.computeBoundingBox();
    }
    const box = geometry.boundingBox;
    if (box === null) {
      return;
    }
    scratchTransform.multiplyMatrices(scratchParentInverse, child.matrixWorld);
    scratchBox.copy(box).applyMatrix4(scratchTransform);
    top = Math.max(top, scratchBox.max.y);
  });
  return top === Number.NEGATIVE_INFINITY ? 0 : top;
}

/**
 * Shadow flags measured from the real meshes a placeholder visual created,
 * never from registry metadata. This captures the prefab's declared intent once
 * at create/`appearance.set`; `inspect()` reports it, and a model swap re-applies
 * it (see {@link applyShadowFlags}) before measuring the loaded clone, so an
 * imported asset with default-false flags cannot silently downgrade it.
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

/**
 * Stamp a shadow intent onto every mesh in a freshly cloned model visual.
 *
 * `GLTFLoader` leaves `castShadow`/`receiveShadow` at `false`, so the intent must
 * be written onto the clone explicitly; otherwise real art renders without the
 * shadows its placeholder cast.
 */
function applyShadowFlags(visual: Object3D, castsShadow: boolean, receivesShadow: boolean): void {
  visual.traverse((child) => {
    if (child instanceof Mesh) {
      child.castShadow = castsShadow;
      child.receiveShadow = receivesShadow;
    }
  });
}

/**
 * Plain-data identity of the skeleton driving a visual, or `null` for a
 * non-skinned visual.
 *
 * `SkeletonUtils.clone` rebinds a fresh `Skeleton` per node, while a plain
 * `Object3D.clone(true)` shares the template's skeleton, so exposing the
 * skeleton's uuid lets a test prove the two node clones are independent without
 * leaking a Three object out of `inspect()`.
 */
function skeletonIdOf(visual: Object3D): string | null {
  let skeletonId: string | null = null;
  visual.traverse((child) => {
    if (skeletonId === null && child instanceof SkinnedMesh) {
      skeletonId = child.skeleton.uuid;
    }
  });
  return skeletonId;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Normalise yaw degrees into `[0, 360)`. */
function normalizeYawDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Create a render runtime for an authoritative world AABB.
 *
 * `bounds` is required (there is no magic default): the caller that owns the
 * authoritative world extent must supply it. The whole scene composition exists
 * immediately, so `apply` works before (and without) `mount`; only `mount` needs
 * a real canvas.
 *
 * `loadModel` and `catalogue` are the asset-pipeline seams: the default loader is
 * the real `GLTFLoader` and the default catalogue is (deliberately) empty, so a
 * test injects both to exercise load/clone/swap without a network.
 */
export function createThreeRuntime(options: {
  bounds: RuntimeWorldBounds;
  /** Injectable model loader; defaults to the real `GLTFLoader` (`loadGlbTemplate`). */
  loadModel?: ModelLoader;
  /** Injectable asset catalogue; defaults to `MODEL_CATALOGUE`. */
  catalogue?: AppearanceModelCatalogue;
}): RenderRuntime {
  const bounds = options.bounds;
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldDepth = bounds.max.z - bounds.min.z;
  const worldCenterX = (bounds.min.x + bounds.max.x) / 2;
  const worldCenterZ = (bounds.min.z + bounds.max.z) / 2;
  const groundY = bounds.min.y;

  const loadModel = options.loadModel ?? loadGlbTemplate;
  const catalogue = options.catalogue ?? MODEL_CATALOGUE;
  // One parse per URL. A rejected load is dropped from the cache so a later node
  // can retry; concurrent callers share the same in-flight promise.
  const templateCache = new Map<string, Promise<Object3D>>();
  // Templates whose geometry/material/texture this runtime owns and releases in
  // `dispose()`. A node's clone borrows from these.
  const ownedTemplates = new Set<Object3D>();
  const released: ReleaseCounts = emptyReleaseCounts();
  // A late load resolve after dispose must not touch the scene; this flag plus a
  // per-node token is the guard.
  let disposed = false;

  const scene = new Scene();
  // Fill the whole viewport, including the area outside the finite ground plate,
  // with the page-family background instead of the WebGL default black.
  const background = new Color(SCENE_BACKGROUND_COLOUR);
  scene.background = background;
  const nodes = new Map<NodeId, RuntimeNode>();
  // Reverse index used by `pick` to map an intersected mesh back to its node
  // root, then to the opaque NodeId. Game identity never enters the runtime.
  const nodeIdByRoot = new Map<Object3D, NodeId>();
  // Per-`(layer, appearance)` node index: the seam a future instanced / atlas
  // realisation swaps behind, keyed off the same bucket the ISA already implies.
  const buckets = new Map<string, Set<NodeId>>();

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

  // Rig state. `cameraFocus` is the world point the rig is centred on (also the
  // smooth-follow target); the camera itself is a fixed local child.
  let pitchDegrees: number = RENDER_CAMERA.pitchDegrees;
  let yawDegrees = 0;
  let zoom = 1;
  const cameraFocus = new Vector3(worldCenterX, groundY, worldCenterZ);
  cameraRig.position.copy(cameraFocus);
  scene.add(cameraRig);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  // Fixed child of the rig: offset up/back along the (rig-local) view axis and
  // pitched down. The rig's yaw rotates the whole assembly.
  cameraRig.add(camera);

  // Canvas aspect, updated on resize; defaults to square before any layout.
  let cameraAspect = 1;

  /**
   * Recompute the camera's local offset/rotation from the rig state. Switching to
   * a perspective camera would change only this function and the frustum helper.
   */
  function applyCameraTransform(): void {
    const pitch = pitchDegrees * DEGREES_TO_RADIANS;
    cameraRig.rotation.y = yawDegrees * DEGREES_TO_RADIANS;
    camera.position.set(
      0,
      RENDER_CAMERA.distance * Math.sin(pitch),
      RENDER_CAMERA.distance * Math.cos(pitch),
    );
    camera.rotation.set(-pitch, 0, 0);
    reframe();
  }

  /** Reframe the orthographic frustum for the current rig state and aspect. */
  function reframe(): void {
    const frustum = orthographicBounds({
      bounds,
      aspect: cameraAspect,
      pitchDegrees,
      yawDegrees,
      zoom,
    });
    camera.left = frustum.left;
    camera.right = frustum.right;
    camera.top = frustum.top;
    camera.bottom = frustum.bottom;
    camera.updateProjectionMatrix();
  }

  applyCameraTransform();

  const groundGeometry = new PlaneGeometry(worldWidth, worldDepth);
  const groundMaterial = new MeshStandardMaterial({ color: 0x241c14 });
  let ground: Mesh | null = new Mesh(groundGeometry, groundMaterial);
  // Ground lies in the XZ plane, slightly below the terrain plates.
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(worldCenterX, groundY - 0.3, worldCenterZ);
  ground.receiveShadow = true;
  scene.add(ground);

  const lightsGroup = new Group();
  lightsGroup.name = 'Lights';
  const ambient = new AmbientLight(0xffffff, 0.7);
  const sunLight = new DirectionalLight(0xffffff, 1.15);
  let sun: DirectionalLight | null = sunLight;
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const shadowExtent = Math.max(worldWidth, worldDepth) / 2 + 4;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 80;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.position.set(worldCenterX + 6, groundY + 14, worldCenterZ + 6);
  sunLight.target.position.set(worldCenterX, groundY, worldCenterZ);
  lightsGroup.add(ambient, sunLight, sunLight.target);
  scene.add(lightsGroup);
  const lights: Light[] = [ambient, sunLight];

  let followNodeId: NodeId | null = null;
  // Separate from the frame clock: follow smoothing re-baselines when the
  // target changes, without perturbing interpolation timing.
  let lastFollowMs: number | null = null;

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

  /**
   * Place a node at its authoritative world transform.
   *
   * There is **no tile interpretation and no per-layer positional offset**: the
   * node lands exactly where the ISA says it is. The only ordering rule is
   * `renderOrder` (set at creation), and real occlusion is the depth buffer's.
   */
  function positionNode(node: RuntimeNode): void {
    node.root.position.copy(node.world);
    node.root.quaternion.copy(node.rotation);
  }

  function applyTransform(node: RuntimeNode, transform: RenderTransform): void {
    node.world.set(transform.position.x, transform.position.y, transform.position.z);
    node.rotation.set(
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    );
    node.root.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
    positionNode(node);
  }

  /** Accumulate a release pass's counts into the runtime's disposal ledger. */
  function accumulateRelease(counts: ReleaseCounts): void {
    released.geometries += counts.geometries;
    released.materials += counts.materials;
    released.textures += counts.textures;
  }

  /** Release a node-owned (placeholder) visual. A borrowed model clone is skipped. */
  function releaseOwnedVisual(node: RuntimeNode): void {
    if (!node.ownsVisual) {
      return;
    }
    accumulateRelease(releaseObject(node.visual));
  }

  /**
   * Resolve `url` to a parsed template, caching **one parse per URL**. Concurrent
   * callers share the in-flight promise; a rejected load is dropped so a later
   * node can retry. A parse that lands after `dispose()` is released immediately
   * and never enters the scene.
   */
  function templateFor(url: string): Promise<Object3D> {
    const cached = templateCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const promise = loadModel(url).then((template) => {
      if (disposed) {
        accumulateRelease(releaseObject(template));
        return template;
      }
      ownedTemplates.add(template);
      // Material policy once per template, so every clone shares the coerced
      // material (see `applyOpaqueMaterialPolicy`).
      applyOpaqueMaterialPolicy(template, url);
      return template;
    });
    templateCache.set(url, promise);
    promise.catch(() => {
      if (templateCache.get(url) === promise) {
        templateCache.delete(url);
      }
    });
    return promise;
  }

  /**
   * Begin resolving a node's catalogue asset. The placeholder stays visible until
   * the model resolves; a failure logs and keeps the placeholder. A stale resolve
   * (node destroyed, or appearance/visual replaced while in flight) is ignored via
   * node identity plus the node's `visualToken`.
   */
  function resolveModel(node: RuntimeNode, nodeId: NodeId, asset: ModelAsset): void {
    const token = node.visualToken;
    templateFor(asset.url)
      .then((template) => {
        if (disposed || nodes.get(nodeId) !== node || node.visualToken !== token) {
          return;
        }
        swapInModel(node, asset, template);
      })
      .catch((error: unknown) => {
        if (disposed || nodes.get(nodeId) !== node || node.visualToken !== token) {
          return;
        }
        // A missing or slow asset must never blank the node: keep the placeholder.
        node.modelState = 'failed';
        console.error(
          `[render] failed to load model "${asset.url}" for "${nodeId}"; keeping placeholder`,
          error,
        );
      });
  }

  /** Replace a node's placeholder with a clone of the resolved template. */
  function swapInModel(node: RuntimeNode, asset: ModelAsset, template: Object3D): void {
    // Wrap the clone so the node's visual stays a `Group` and the catalogue's
    // scale/orientation/anchor fixes have a single object to write to.
    const wrapper = new Group();
    wrapper.add(cloneTemplate(template));
    applyAssetFixes(wrapper, asset);
    // The prefab's placeholder declared this node's shadow intent (captured at
    // create/appearance.set). `GLTFLoader` leaves `castShadow`/`receiveShadow`
    // false on every fresh clone, so stamp the intent onto the loaded meshes
    // BEFORE re-measuring; otherwise the swap would silently downgrade the node
    // to "no shadows" and real art would render without them.
    applyShadowFlags(wrapper, node.castsShadow, node.receivesShadow);
    node.root.remove(node.visual);
    releaseOwnedVisual(node);
    node.visual = wrapper;
    node.ownsVisual = false;
    node.root.add(wrapper);
    node.modelState = 'loaded';
    node.visualToken += 1;
    // Re-measure the geometry-derived facts off the real model visual so height
    // and shadow accounting follow the swap instead of the retired placeholder.
    // The shadow measurement now reads back the intent applied just above.
    const shadowFlags = measureShadowFlags(wrapper);
    node.visualTopY = measureVisualTopY(wrapper);
    node.castsShadow = shadowFlags.castsShadow;
    node.receivesShadow = shadowFlags.receivesShadow;
  }

  function createNode(command: {
    nodeId: NodeId;
    layer: RenderLayer;
    appearance: AppearanceId;
    transform: RenderTransform;
    visible: boolean;
  }): void {
    const prefab = prefabFor(command.appearance);
    const asset = catalogue[command.appearance];
    const root = new Group();
    const visual = prefab.createVisual();
    root.add(visual);
    // Coarse draw order only; the depth buffer resolves real occlusion.
    root.renderOrder = LAYER_RENDER_ORDER[command.layer];
    groups[prefab.group].add(root);
    const shadowFlags = measureShadowFlags(visual);
    const node: RuntimeNode = {
      root,
      visual,
      layer: command.layer,
      group: prefab.group,
      world: new Vector3(),
      rotation: new Quaternion(),
      appearance: command.appearance,
      animation: prefab.defaultAnimation,
      defaultAnimation: prefab.defaultAnimation,
      motion: prefab.motion,
      visualTopY: measureVisualTopY(visual),
      ownsVisual: true,
      modelState: asset === undefined ? 'placeholder' : 'loading',
      visualToken: 0,
      castsShadow: shadowFlags.castsShadow,
      receivesShadow: shadowFlags.receivesShadow,
      target: null,
      startMs: null,
      startWorld: new Vector3(),
      startRotation: new Quaternion(),
    };
    root.visible = command.visible;
    applyTransform(node, command.transform);
    nodes.set(command.nodeId, node);
    nodeIdByRoot.set(root, command.nodeId);
    addToBucket(command.layer, command.appearance, command.nodeId);
    // Render the placeholder immediately; a resolved model swaps it in place.
    if (asset !== undefined) {
      resolveModel(node, command.nodeId, asset);
    }
  }

  function destroyNode(nodeId: NodeId): void {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      return;
    }
    node.root.parent?.remove(node.root);
    // Only a node-owned placeholder is released here. A loaded model clone
    // borrows the cached template's resources, which `dispose()` releases once.
    releaseOwnedVisual(node);
    nodeIdByRoot.delete(node.root);
    removeFromBucket(node.layer, node.appearance, nodeId);
    nodes.delete(nodeId);
  }

  /** Swap an existing node's appearance, moving its group if the prefab requires. */
  function setAppearance(node: RuntimeNode, nodeId: NodeId, appearance: AppearanceId): void {
    const prefab = prefabFor(appearance);
    const asset = catalogue[appearance];
    node.root.remove(node.visual);
    releaseOwnedVisual(node);
    // Invalidate any in-flight load for the retired appearance.
    node.visualToken += 1;
    node.visual = prefab.createVisual();
    node.ownsVisual = true;
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
    node.modelState = asset === undefined ? 'placeholder' : 'loading';
    node.castsShadow = shadowFlags.castsShadow;
    node.receivesShadow = shadowFlags.receivesShadow;
    removeFromBucket(node.layer, node.appearance, nodeId);
    addToBucket(node.layer, appearance, nodeId);
    node.appearance = appearance;
    if (asset !== undefined) {
      resolveModel(node, nodeId, asset);
    }
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
            applyTransform(node, command.transform);
            node.target = null;
            node.startMs = null;
            // A snap ends any move just as completing the interpolation does.
            node.animation = node.defaultAnimation;
          }
          break;
        }
        case 'transform.setTarget': {
          const node = nodes.get(command.nodeId);
          if (node !== undefined) {
            const target = {
              world: new Vector3(
                command.transform.position.x,
                command.transform.position.y,
                command.transform.position.z,
              ),
              rotation: new Quaternion(
                command.transform.rotation.x,
                command.transform.rotation.y,
                command.transform.rotation.z,
                command.transform.rotation.w,
              ),
              durationMs: command.durationMs,
            };
            node.target = target;
            // `apply` reads no clock: the start time is set by the first
            // `update(nowMs)` after this command, which keeps `apply` pure.
            node.startMs = null;
            node.startWorld.copy(node.world);
            node.startRotation.copy(node.rotation);
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
    if (node.modelState === 'loaded') {
      // A loaded model carries its own clips (catalogue `idleClip`/`walkClip`) and
      // its catalogue `yOffset` anchor; the procedural bob would fight both.
      // Clip playback is the recorded extension point.
      return;
    }
    node.motion?.(node.animation, nowMs, node.visual);
  }

  function update(nowMs: number): void {
    for (const node of nodes.values()) {
      const target = node.target;
      if (target !== null) {
        if (node.startMs === null) {
          node.startMs = nowMs;
          node.startWorld.copy(node.world);
          node.startRotation.copy(node.rotation);
        }
        const elapsed = nowMs - node.startMs;
        const progress =
          target.durationMs <= 0
            ? 1
            : Math.min(1, Math.max(0, elapsed / target.durationMs));
        node.world.lerpVectors(node.startWorld, target.world, progress);
        node.rotation.slerpQuaternions(node.startRotation, target.rotation, progress);
        if (progress >= 1) {
          node.world.copy(target.world);
          node.rotation.copy(target.rotation);
          node.target = null;
          node.startMs = null;
          // The runtime owns WHEN a move is over: it interpolated to the target,
          // so it — not the bridge — returns the node to its rest animation.
          node.animation = node.defaultAnimation;
        }
        positionNode(node);
      }
      updateVisualMotion(node, nowMs);
    }

    // Camera following: smooth the rig focus toward the followed node's visual
    // (interpolated) world position. `null` leaves the focus where it is.
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
        cameraFocus.x += (followed.world.x - cameraFocus.x) * followAlpha;
        cameraFocus.y += (followed.world.y - cameraFocus.y) * followAlpha;
        cameraFocus.z += (followed.world.z - cameraFocus.z) * followAlpha;
        cameraRig.position.copy(cameraFocus);
      }
    }
  }

  function inspect(): RenderInspection {
    // Update the real scene graph, then report each node's placement off its
    // `Object3D` world transform. `node.world`/`node.rotation` are only the
    // bookkeeping `positionNode()` copies FROM; deriving the report from them
    // would let a broken placement pass inspection.
    scene.updateMatrixWorld(true);
    const cameraWorld = new Vector3();
    camera.getWorldPosition(cameraWorld);
    const cameraQuaternion = camera.getWorldQuaternion(new Quaternion());
    const cameraForward = new Vector3(0, 0, -1).applyQuaternion(cameraQuaternion).normalize();
    const cameraUp = new Vector3(0, 1, 0).applyQuaternion(cameraQuaternion).normalize();
    const nodeList = [...nodes.entries()].map(([nodeId, node]) => {
      const worldPosition = node.root.getWorldPosition(new Vector3());
      const worldRotation = node.root.getWorldQuaternion(new Quaternion());
      return {
        nodeId,
        layer: node.layer,
        group: node.group,
        renderOrder: node.root.renderOrder,
        world: { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z },
        rotation: {
          x: worldRotation.x,
          y: worldRotation.y,
          z: worldRotation.z,
          w: worldRotation.w,
        },
        yaw: yawFromRotation(worldRotation),
        visible: node.root.visible,
        appearance: node.appearance,
        animation: node.animation,
        defaultAnimation: node.defaultAnimation,
        visualY: node.visual.position.y,
        visualRoll: node.visual.rotation.z,
        visualTopY: node.visualTopY,
        model: node.modelState,
        skeletonId: skeletonIdOf(node.visual),
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
      models: ownedTemplates.size,
      released: { ...released },
      camera: {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        pitchDegrees,
        yawDegrees,
        zoom,
        focus: { x: cameraFocus.x, y: cameraFocus.y, z: cameraFocus.z },
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
      canvas.clientWidth > 0 ? canvas.clientWidth : worldWidth * FALLBACK_PIXELS_PER_UNIT;
    const height =
      canvas.clientHeight > 0 ? canvas.clientHeight : worldDepth * FALLBACK_PIXELS_PER_UNIT;
    renderer.setSize(width, height, false);

    cameraAspect = height > 0 ? width / height : 1;
    reframe();
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

  function getCameraState(): CameraState {
    return {
      pitchDegrees,
      yawDegrees,
      zoom,
      focus: { x: cameraFocus.x, y: cameraFocus.y, z: cameraFocus.z },
    };
  }

  function setCameraOrientation(orientation: {
    pitchDegrees?: number;
    yawDegrees?: number;
  }): void {
    if (orientation.pitchDegrees !== undefined) {
      pitchDegrees = clamp(
        orientation.pitchDegrees,
        RENDER_CAMERA.minPitchDegrees,
        RENDER_CAMERA.maxPitchDegrees,
      );
    }
    if (orientation.yawDegrees !== undefined) {
      yawDegrees = normalizeYawDegrees(orientation.yawDegrees);
    }
    applyCameraTransform();
  }

  function setZoom(nextZoom: number): void {
    zoom = clamp(nextZoom, RENDER_CAMERA.minZoom, RENDER_CAMERA.maxZoom);
    reframe();
  }

  // Reused across picks so a drag/click loop does not allocate per query.
  const raycaster = new Raycaster();
  const pickNdc = new Vector2();
  // The mathematical ground plane at the world's floor; independent of the tile
  // plates and their deliberate inset gaps.
  const groundPlane = new Plane(new Vector3(0, 1, 0), -groundY);
  const groundHit = new Vector3();

  /** Walk an intersected object's parents to the registered node root that owns it. */
  function nodeIdForObject(object: Object3D): NodeId | null {
    let current: Object3D | null = object;
    while (current !== null) {
      const nodeId = nodeIdByRoot.get(current);
      if (nodeId !== undefined) {
        return nodeId;
      }
      current = current.parent;
    }
    return null;
  }

  function pick(ndcX: number, ndcY: number): RenderPick {
    // The camera is a child of the rig; refresh the scene graph's matrices before
    // reading the camera's world matrix in `setFromCamera`.
    scene.updateMatrixWorld(true);
    pickNdc.set(ndcX, ndcY);
    raycaster.setFromCamera(pickNdc, camera);

    // 1. Registered node visuals win outright, even over a nearer ground hit, so
    //    a click on a prop never falls through to a move intent. Only the
    //    `object` layer is pickable: terrain plates live in `base` and ARE the
    //    visible ground, so raycasting them would shadow the mathematical-plane
    //    pick and a ground click could never produce a move intent.
    const roots: Object3D[] = [];
    for (const node of nodes.values()) {
      if (node.layer === 'object' && node.root.visible) {
        roots.push(node.root);
      }
    }
    const nodeHits = raycaster.intersectObjects(roots, true);
    if (nodeHits.length > 0) {
      const hitNodeId = nodeIdForObject(nodeHits[0].object);
      if (hitNodeId !== null) {
        return { kind: 'node', nodeId: hitNodeId };
      }
    }

    // 2. Otherwise the mathematical ground plane.
    const hit = raycaster.ray.intersectPlane(groundPlane, groundHit);
    if (hit === null) {
      return null;
    }
    if (
      hit.x < bounds.min.x ||
      hit.x > bounds.max.x ||
      hit.z < bounds.min.z ||
      hit.z > bounds.max.z
    ) {
      // Outside the world: no clamping, no gameplay rule, no intent.
      return null;
    }
    return { kind: 'ground', point: { x: hit.x, y: hit.y, z: hit.z } };
  }

  function dispose(): void {
    // Mark disposed first: an in-flight load that resolves after this point is
    // released immediately and can never add to the scene.
    disposed = true;

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
      accumulateRelease(releaseMaterial(ground.material));
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

    // Release every cached model template once: their geometry/material/texture
    // is shared by all node clones, which is exactly why this happens here and
    // not in `destroyNode`.
    for (const template of ownedTemplates) {
      accumulateRelease(releaseObject(template));
    }
    ownedTemplates.clear();
    templateCache.clear();

    scene.remove(cameraRig);
    scene.background = null;

    if (renderer !== null) {
      // The canvas itself is owned by the caller (React removes it on unmount).
      renderer.dispose();
      renderer = null;
    }

    mounted = false;
  }

  return {
    mount,
    apply,
    update,
    setFollowTarget,
    getCameraState,
    setCameraOrientation,
    setZoom,
    pick,
    inspect,
    dispose,
  };
}
