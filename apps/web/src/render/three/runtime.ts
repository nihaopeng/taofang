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
 * It is deliberately a **narrow-FOV perspective** camera (phase 11): the tilt and
 * the narrow FOV give a gentle near-large/far-small read without a strong
 * third-person look. Wave C makes the view a **pure orbit**: the camera DISTANCE
 * is fixed per aspect/zoom (no yaw dolly), and the FOV is derived per yaw from
 * the bounds fit so the composition is preserved while the foreshortening stays
 * constant. The world model, the Actor motion model, and the Render ISA
 * carry no projection assumption, so the rig remains the *only* module that knows
 * how the scene is projected. Yaw rotates the rig (and therefore the view); it
 * never changes the world coordinate system.
 *
 * `inspect()` exposes the rig as plain data (`pitchDegrees`, `yawDegrees`,
 * `zoom`, the honest perspective frustum — `fovDegrees`/`near`/`far`/`aspect` —
 * and the camera's world position/forward/up) so tests can assert pitch clamping,
 * yaw view changes, and zoom extent numerically.
 *
 * Layer / depth / occlusion (frozen policy)
 * ----------------------------------------
 * Occlusion is resolved by a **real 3D depth buffer** plus the tilted camera.
 * There is no per-object hand-written z, and none may be added. The ISA's
 * `layer` ('base' | 'object') is coarse ordering only and is applied here as
 * `renderOrder`.
 *
 * Seamless terrain + an independent grid layer (phase 9)
 * -----------------------------------------------------
 * Every terrain plate is exactly `cellSize` on both axes, so neighbouring cells
 * share their edges exactly and the surface is continuous. Per-terrain
 * differentiation never changes that horizontal footprint: it is colour/material,
 * a FULL-footprint vertical step (path/water are recessed), and/or a smaller
 * decoration resting ON TOP of the full-size plate (path inlay, blocked rock,
 * water ripple). The old "dark ground shows through as grid gaps" technique is
 * gone; grid lines are an independent `GridOverlay` layer instead.
 *
 * `GridOverlay` (one `LineSegments` plus one reusable marker, built once from the
 * grid spec) is hidden by default, sits under `WorldRoot` alongside the prefab
 * groups, and is lifted by one layer-wide `GRID_OVERLAY_LIFT` to avoid z-fighting.
 * The lift is an overlay concern only; it is never a per-tile seam fix.
 * `setGridOverlayVisible` / `setHighlightedCell` drive it and `inspect()` reports
 * it as plain data.
 *
 * Prefab registry / asset abstraction
 * -----------------------------------
 * `AppearanceId -> Prefab { group, defaultAnimation, motion?, createVisual(cellSize) }`.
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
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
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
  /**
   * Build a fresh visual rooted at the node's feet (local origin at y = 0).
   * `cellSize` is the world-space edge length a terrain plate must occupy; a
   * prefab that is not terrain ignores it. Threading it here is what makes the
   * terrain footprint exactly the grid cell, with no per-terrain inset.
   */
  createVisual(cellSize: number): Group;
}

/** Plain-data snapshot of the camera rig: the only place 2.5D lives. */
export interface CameraState {
  /** Downward pitch from the horizontal, in degrees, within the rig's limits. */
  pitchDegrees: number;
  /** Yaw about `+Y`, in degrees, normalised to `[0, 360)`. */
  yawDegrees: number;
  /** Perspective zoom factor; larger is closer. */
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
  /**
   * World-space geometry of the single ground backdrop as plain data, or `null`
   * after `dispose`. `sizeX`/`sizeZ` are its full extents along world X/Z and
   * `center` its world position (below the terrain plates). It is sized from the
   * frustum's projected footprint with an overshoot (see
   * {@link backdropHalfExtents}). Tests can prove the floor silhouette never
   * reaches the viewport edge at any yaw or zoom.
   *
   * `castsShadow`/`receivesShadow` are both `false` by design: the backdrop is
   * larger than the sun's shadow frustum, so a shadow lookup on it clamps to the
   * border texel and paints a false straight boundary in WORLD space (read as a
   * tapering floor under a yawed camera). Pinned so a mutation cannot silently
   * re-enable shadowing on it.
   */
  backdrop: {
    sizeX: number;
    sizeZ: number;
    center: { x: number; y: number; z: number };
    castsShadow: boolean;
    receivesShadow: boolean;
  } | null;
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
  /** The camera rig state and the perspective frustum it produces. */
  camera: {
    /** Vertical field of view, in degrees, actually applied to the camera. */
    fovDegrees: number;
    /** Near clip plane, in world units. */
    near: number;
    /** Far clip plane, in world units. */
    far: number;
    /** Canvas aspect (width / height) the frustum was fitted to. */
    aspect: number;
    /** Constrained downward pitch, in degrees. */
    pitchDegrees: number;
    /** Free yaw, in degrees, normalised to `[0, 360)`. */
    yawDegrees: number;
    /** Perspective zoom factor; larger is closer. */
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
    /** The node root's real scale, read off its `Object3D` (1 everywhere today). */
    scale: { x: number; y: number; z: number };
    /**
     * Horizontal footprint of the node's visual, measured from the real
     * world-space AABB the same way {@link visualTopY} measures height (the
     * node's own authoritative transform cancels). For every terrain appearance
     * this is exactly the grid `cellSize`, which is the "no shrink, no seams"
     * proof: a reintroduced per-terrain inset changes this measured value.
     */
    footprintX: number;
    footprintZ: number;
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
  /**
   * State of the independent `GridOverlay` presentation layer, as plain data.
   *
   * `lineObjectCount`/`highlightMarkerCount` are the overlay's real child
   * objects, so a test can prove the overlay is one line object plus one reusable
   * marker regardless of how many tiles exist (it is never one object per tile).
   * After `dispose` every field reads empty and every count is 0.
   */
  gridOverlay: {
    visible: boolean;
    highlightedCell: { x: number; z: number } | null;
    lineObjectCount: number;
    highlightMarkerCount: number;
  };
}

/** Structural world AABB the runtime frames; deliberately not the Organizer type. */
export interface RuntimeWorldBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Structural grid spec the runtime builds its terrain footprint and the
 * `GridOverlay` from; deliberately not the Organizer type, but structurally the
 * same shape so the UI can pass its view model through unchanged.
 *
 * `width`/`depth` are cell counts, not world units: the grid spans
 * `origin + width * cellSize` in x (and `depth` in z).
 */
export interface RuntimeGridSpec {
  origin: { x: number; y: number; z: number };
  width: number;
  depth: number;
  cellSize: number;
}

/** Cell edge length used when a caller supplies no grid spec (the default grid). */
export const DEFAULT_CELL_SIZE = 1;

/**
 * Single, layer-wide lift of the `GridOverlay` above the terrain surface so the
 * overlay's lines do not z-fight with the plates.
 *
 * This is an OVERLAY LIFT, not a seam fix: it is one constant for the whole
 * layer (never per-tile, never per-terrain) and says nothing about the terrain
 * geometry, which stays exactly cell-sized and continuous.
 */
const GRID_OVERLAY_LIFT = 0.05;

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
  /** Set the perspective zoom factor (clamped to the rig's limits). */
  setZoom(zoom: number): void;
  /**
   * Show or hide the independent `GridOverlay` layer (hidden by default). This is
   * the layer farming / placement / selection / debug modes will switch on; those
   * modes do not exist yet, so the UI toggle stands in for the future switch.
   */
  setGridOverlayVisible(visible: boolean): void;
  /**
   * Record (and move the reusable marker to) a highlighted grid cell, or clear it
   * with `null`. The runtime derives the cell's world centre from the grid spec;
   * no gameplay meaning is attached to a cell here.
   */
  setHighlightedCell(cell: { x: number; z: number } | null): void;
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
  /** Horizontal footprint of the visual's meshes, relative to the node root (see {@link measureVisualFootprint}). */
  footprintX: number;
  footprintZ: number;
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
  /**
   * Widest vertical field of view, in degrees. Deliberately narrow (phase 11)
   * so the projected near/far size difference stays gentle.
   *
   * Wave C: the FOV is no longer fixed. The camera DISTANCE is fixed (once per
   * aspect/zoom) from the WORST-case yaw fit at this FOV; the per-yaw FOV is then
   * derived from the same fit so the composition is preserved exactly while
   * perspective strength (which depends on distance only) stays constant. See
   * {@link perspectiveFrustum}.
   */
  fovMaxDegrees: 28,
  /**
   * Narrowest vertical field of view, in degrees. A guard for degenerate
   * bounds/aspect fits; for the shipped world shapes the derived FOV stays
   * around 20 (axis-aligned) to 28 (diagonal) and this never binds.
   */
  fovMinDegrees: 15,
  /**
   * Minimum near clip distance, in world units. `near` is otherwise derived from
   * the geometry (see {@link perspectiveFrustum}); this only guards a positive
   * near when the camera is closer to the focus than the world radius.
   */
  minNear: 0.5,
  /**
   * World units of clearance between the near plane and the nearest world
   * geometry, so rounding at the plane never shaves a tile.
   */
  nearClearance: 1,
  /** Extra world units of vertical half-extent so tall props are not clipped. */
  verticalHeadroom: 1,
  /**
   * Framing margin: the tight bounds-fit frustum is multiplied by this factor on
   * both axes. It keeps the world's silhouette off the viewport edge at every
   * yaw (the fit-driving world corner lands at `|ndc| = 1 / framingMargin`, i.e.
   * ~0.833 at 1.2, a ~16.7% screen gap). This is a FRAMING decision — how much
   * air surrounds the world — not a seam fix, and it changes no geometry.
   */
  framingMargin: 1.2,
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

/** How far below the world's ground plane the single backdrop mesh sits. */
const BACKDROP_DROP = 0.3;

/**
 * How far past the frustum's projected footprint the backdrop is grown. The
 * floor must read as unbounded, so its silhouette is pushed well off-screen
 * rather than sized exactly to the visible footprint (which would put the
 * left/right extremes exactly on the viewport edge at some yaws and clip them
 * into an inverted-trapezoid look).
 */
const BACKDROP_OVERSHOOT = 2;

/**
 * Pixel size used to size the drawing buffer before the canvas has a layout
 * size. This only affects the backing store; the projection is world-sized.
 */
const FALLBACK_PIXELS_PER_UNIT = 32;

const DEGREES_TO_RADIANS = Math.PI / 180;

function material(
  colour: number,
  options: { roughness?: number; metalness?: number } = {},
): MeshStandardMaterial {
  const entry = new MeshStandardMaterial({ color: colour });
  if (options.roughness !== undefined) {
    entry.roughness = options.roughness;
  }
  if (options.metalness !== undefined) {
    entry.metalness = options.metalness;
  }
  return entry;
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
 * Perspective frustum plus the visible ground footprint that frame the world's
 * ground rectangle for the rig's current pitch/yaw/zoom and a canvas aspect.
 *
 * Wave C (phase 11): the rig is a **pure orbit with constant foreshortening**.
 *
 * - The camera basis (right/up/forward) and the symmetric bounds fit are the
 *   phase-10 orthographic fit: the world bounds' XZ footprint (at ground level)
 *   is projected onto the camera's right/up axes, `verticalHeadroom` keeps tall
 *   props off the clip edge, and `framingMargin` pushes both axes past the tight
 *   fit so the fit-driving corner lands at `|ndc| = 1 / framingMargin` AT THE
 *   FOCUS PLANE — the same composition the orthographic rig produced.
 * - The camera DISTANCE is fixed for a given aspect/zoom, from the fit at the
 *   WORST yaw and the widest FOV
 *   (`distance = worstCaseFit(aspect, zoom) / tan(fovMax / 2)`). It does NOT
 *   depend on yaw, so rotating is a pure orbit with no dolly.
 * - The FOV is derived per yaw from the same fit
 *   (`fov(yaw) = 2 * atan(fit(yaw, aspect, zoom) / distance)`), clamped to
 *   `[fovMin, fovMax]`. The fit fixes the apparent size of the world, while
 *   perspective strength is set by the fixed DISTANCE, so the floor's
 *   foreshortening does not breathe with yaw. This is the honest perspective
 *   analogue of the orthographic rig's per-yaw frustum fit.
 * - `zoom` is a DOLLY: `distance` is inversely proportional to zoom while the
 *   derived FOV is zoom-invariant. A dolly does change perspective strength (a
 *   farther camera foreshortens less), which is expected for an explicit zoom
 *   action; at any single zoom the pure-orbit property is exact.
 * - `near` is derived from the geometry, not a close constant. The camera may
 *   follow anywhere inside the world, so a conservative world radius (the bounds
 *   diagonal) is subtracted from the distance, leaving `nearClearance` as
 *   margin. It is additionally clamped below the nearest VISIBLE ground depth so
 *   the backdrop can never be clipped on-screen. `far` is derived from the
 *   visible ground footprint (1.2x the farthest viewport ground corner plus 1),
 *   so terrain and backdrop stay inside the frustum.
 */

/** The symmetric half-height the rig must show to frame `bounds` at one yaw. */
function fittedHalfHeight(
  bounds: RuntimeWorldBounds,
  aspect: number,
  pitchDegrees: number,
  yawDegrees: number,
  zoom: number,
): number {
  const pitch = pitchDegrees * DEGREES_TO_RADIANS;
  const yaw = yawDegrees * DEGREES_TO_RADIANS;
  const sinPitch = Math.sin(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const rightX = cosYaw;
  const rightZ = -sinYaw;
  const upX = -sinPitch * sinYaw;
  const upZ = -sinPitch * cosYaw;
  const halfWidthWorld = (bounds.max.x - bounds.min.x) / 2;
  const halfDepthWorld = (bounds.max.z - bounds.min.z) / 2;
  let extentRight = 0;
  let extentUp = 0;
  for (const signX of [-1, 1]) {
    for (const signZ of [-1, 1]) {
      const dx = signX * halfWidthWorld;
      const dz = signZ * halfDepthWorld;
      extentRight = Math.max(extentRight, Math.abs(dx * rightX + dz * rightZ));
      extentUp = Math.max(extentUp, Math.abs(dx * upX + dz * upZ));
    }
  }
  const vertical = extentUp + RENDER_CAMERA.verticalHeadroom;
  // Tight, aspect-preserving bounds fit, then a symmetric framing margin on both
  // axes so the world silhouette keeps clear of the viewport edge at every yaw.
  // Dividing by `zoom` keeps a larger zoom closer.
  return (Math.max(vertical, extentRight / aspect) / zoom) * RENDER_CAMERA.framingMargin;
}

/**
 * The largest {@link fittedHalfHeight} over every yaw, computed in closed form.
 *
 * `max_theta max(f(theta), g(theta)) = max(max_theta f, max_theta g)`, and over a
 * full turn those two projected extents attain `sin(pitch) * diag + headroom`
 * (up axis) and `diag` (right axis), with `diag = hypot(halfWidth, halfDepth)`.
 * This is exact, not a yaw sample, so the fixed orbit distance can never be too
 * small and no yaw can overflow the framed composition.
 */
function worstCaseFittedHalfHeight(
  bounds: RuntimeWorldBounds,
  aspect: number,
  pitchDegrees: number,
  zoom: number,
): number {
  const sinPitch = Math.sin(pitchDegrees * DEGREES_TO_RADIANS);
  const halfWidthWorld = (bounds.max.x - bounds.min.x) / 2;
  const halfDepthWorld = (bounds.max.z - bounds.min.z) / 2;
  const diagonal = Math.hypot(halfWidthWorld, halfDepthWorld);
  const vertical = sinPitch * diagonal + RENDER_CAMERA.verticalHeadroom;
  const horizontal = diagonal / aspect;
  return (Math.max(vertical, horizontal) / zoom) * RENDER_CAMERA.framingMargin;
}

/** The fixed orbit distance for an aspect/zoom: worst-case fit at the widest FOV. */
function orbitDistance(
  bounds: RuntimeWorldBounds,
  aspect: number,
  pitchDegrees: number,
  zoom: number,
): number {
  const tanHalfFovMax = Math.tan((RENDER_CAMERA.fovMaxDegrees * DEGREES_TO_RADIANS) / 2);
  return worstCaseFittedHalfHeight(bounds, aspect, pitchDegrees, zoom) / tanHalfFovMax;
}

export function perspectiveFrustum(options: {
  bounds: RuntimeWorldBounds;
  aspect: number;
  pitchDegrees: number;
  yawDegrees: number;
  zoom: number;
}): {
  fovDegrees: number;
  near: number;
  far: number;
  aspect: number;
  distance: number;
  halfHeight: number;
  halfWidth: number;
  /** Half-extent of the visible ground footprint around the focus, on world X. */
  footprintHalfX: number;
  /** Half-extent of the visible ground footprint around the focus, on world Z. */
  footprintHalfZ: number;
} {
  const pitch = options.pitchDegrees * DEGREES_TO_RADIANS;
  const yaw = options.yawDegrees * DEGREES_TO_RADIANS;
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);

  // Camera basis in world space (the same convention `applyCameraTransform`
  // writes to the rig):
  //   right   = Ry(yaw) * (1, 0, 0)
  //   up      = Ry(yaw) * (0,  cosPitch, -sinPitch)
  //   forward = Ry(yaw) * (0, -sinPitch, -cosPitch)
  const rightX = cosYaw;
  const rightZ = -sinYaw;
  const upX = -sinPitch * sinYaw;
  const upY = cosPitch;
  const upZ = -sinPitch * cosYaw;
  const forwardX = -cosPitch * sinYaw;
  const forwardY = -sinPitch;
  const forwardZ = -cosPitch * cosYaw;

  const aspect = options.aspect > 0 ? options.aspect : 1;
  const zoom = options.zoom > 0 ? options.zoom : 1;

  const fitted = fittedHalfHeight(
    options.bounds,
    aspect,
    options.pitchDegrees,
    options.yawDegrees,
    zoom,
  );
  const distance = orbitDistance(options.bounds, aspect, options.pitchDegrees, zoom);
  const requiredFovDegrees = (2 * Math.atan(fitted / distance)) / DEGREES_TO_RADIANS;
  const fovDegrees = clamp(
    requiredFovDegrees,
    RENDER_CAMERA.fovMinDegrees,
    RENDER_CAMERA.fovMaxDegrees,
  );
  const tanHalfFov = Math.tan((fovDegrees * DEGREES_TO_RADIANS) / 2);
  // Visible half-height at the focus plane. Equals the fitted value unless the
  // `fovMin` guard widened the view.
  const halfHeight = distance * tanHalfFov;
  const halfWidth = halfHeight * aspect;

  // Camera position relative to the focus. The focus lies on the ground plane,
  // so the camera height above it is `distance * sin(pitch)`. The distance is
  // yaw-independent, so rotating the rig orbits without dollying.
  const camX = distance * cosPitch * sinYaw;
  const camY = distance * sinPitch;
  const camZ = distance * cosPitch * cosYaw;

  // Project the four viewport corners onto the ground plane. For the rig's
  // pitch/fov clamps every ray points below the horizon, so the footprint is a
  // finite trapezoid; `footprintHalfX/Z` are measured from the focus,
  // `maxDepth` is the farthest camera-to-corner distance used for `far`, and
  // `minDepth` is the nearest VISIBLE ground distance used to keep the near
  // plane from clipping the backdrop on-screen.
  let footprintHalfX = 0;
  let footprintHalfZ = 0;
  let maxDepth = 0;
  let minDepth = Number.POSITIVE_INFINITY;
  let parallelToGround = false;
  for (const u of [-1, 1]) {
    for (const v of [-1, 1]) {
      const dirX = forwardX + rightX * (u * tanHalfFov * aspect) + upX * (v * tanHalfFov);
      const dirY = forwardY + upY * (v * tanHalfFov);
      const dirZ = forwardZ + rightZ * (u * tanHalfFov * aspect) + upZ * (v * tanHalfFov);
      if (dirY >= -1e-9) {
        // A ray at/above the horizon never meets the ground: the footprint is
        // unbounded. Cannot happen for the rig's clamps (pitch >= 20 > fov/2),
        // but keep the guard so a future FOV/pitch change cannot produce NaN.
        parallelToGround = true;
        continue;
      }
      const t = -camY / dirY;
      footprintHalfX = Math.max(footprintHalfX, Math.abs(camX + t * dirX));
      footprintHalfZ = Math.max(footprintHalfZ, Math.abs(camZ + t * dirZ));
      const depth = Math.hypot(t * dirX, t * dirY, t * dirZ);
      maxDepth = Math.max(maxDepth, depth);
      minDepth = Math.min(minDepth, depth);
    }
  }

  // Near clip derived from the geometry. The world radius is the bounds diagonal
  // (full extents, not halves): the camera may follow to ANY point inside the
  // world, so `distance - worldRadius` bounds the closest any world point can be
  // from ANY focus the rig can reach. The extra `minDepth` clamp below the
  // nearest visible ground corner guarantees the oversized backdrop is never
  // clipped on-screen, even at the most zoomed-out state.
  const worldRadius = Math.hypot(
    options.bounds.max.x - options.bounds.min.x,
    Math.max(0, options.bounds.max.y - options.bounds.min.y),
    options.bounds.max.z - options.bounds.min.z,
  );
  let near = Math.max(
    RENDER_CAMERA.minNear,
    distance - worldRadius - RENDER_CAMERA.nearClearance,
  );
  if (Number.isFinite(minDepth)) {
    near = Math.max(RENDER_CAMERA.minNear, Math.min(near, minDepth - RENDER_CAMERA.nearClearance));
  }

  return {
    fovDegrees,
    near,
    far: parallelToGround ? Math.max(distance, 1) * 8 : maxDepth * 1.2 + 1,
    aspect,
    distance,
    halfHeight,
    halfWidth,
    footprintHalfX,
    footprintHalfZ,
  };
}

/**
 * Half-extents (world units on X and Z) of the single ground backdrop that make
 * the perspective frustum's projected footprint land well inside it, so the
 * floor reads as unbounded instead of showing a clipped silhouette.
 *
 * The visible ground through a perspective frustum is a trapezoid running toward
 * (but never reaching) the horizon. This uses the trapezoid's world-space
 * bounding half-extents measured from the rig focus by {@link perspectiveFrustum}
 * (exact over the four viewport corners, no sampling), multiplies them by
 * `overshoot` (> 1) so the silhouette sits off-screen, and adds the world
 * half-extents so the backdrop still covers the viewport when the rig follows a
 * node anywhere inside the world. Because the focus is free to move within the
 * world, adding the world half-extents is what keeps the floor edge off-screen
 * in every follow position, not only at the centre.
 */
export function backdropHalfExtents(options: {
  bounds: RuntimeWorldBounds;
  aspect: number;
  pitchDegrees: number;
  yawDegrees: number;
  zoom: number;
  overshoot?: number;
}): { halfX: number; halfZ: number } {
  const frustum = perspectiveFrustum({
    bounds: options.bounds,
    aspect: options.aspect,
    pitchDegrees: options.pitchDegrees,
    yawDegrees: options.yawDegrees,
    zoom: options.zoom,
  });
  const overshoot = options.overshoot ?? 1;
  const halfWorldX = (options.bounds.max.x - options.bounds.min.x) / 2;
  const halfWorldZ = (options.bounds.max.z - options.bounds.min.z) / 2;
  return {
    halfX: halfWorldX + frustum.footprintHalfX * overshoot,
    halfZ: halfWorldZ + frustum.footprintHalfZ * overshoot,
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

/**
 * Grass: one FULL-cell plate, differentiated from other terrain by colour alone.
 *
 * Every terrain plate is exactly `cellSize` on both axes so neighbouring cells
 * share their edges exactly and the surface is continuous. There is deliberately
 * no inset and no per-terrain shrink anywhere: the old "dark ground shows through
 * as grid gaps" technique is gone, and grid lines are now an independent
 * presentation layer (the `GridOverlay`).
 */
function createGrassVisual(cellSize: number): Group {
  const group = new Group();
  group.add(createPlate(cellSize, 0x5cab3f, 0));
  return group;
}

/**
 * Path: a full-cell base recessed by a small vertical step, differentiated by
 * MATERIAL ONLY.
 *
 * The base keeps the FULL footprint, so the step is vertical only (allowed) and
 * path neighbours still share edges exactly. There is deliberately no raised
 * inlay: a per-cell shrunken flat pad (the old 0.7 plate) reads as a *smaller
 * tile*, which is precisely the artefact this layer must not produce. Richer
 * terrain differentiation belongs to real terrain art (a texture/atlas or a
 * continuous terrain mesh), not to a per-cell inset.
 */
function createPathVisual(cellSize: number): Group {
  const group = new Group();
  group.add(createPlate(cellSize, 0xc2a76b, -0.03));
  return group;
}

/**
 * Blocked: a full-cell plate plus a rock decoration resting ON the plate. The
 * rock is smaller, but the ground plate under it is the full cell.
 */
function createBlockedVisual(cellSize: number): Group {
  const group = new Group();
  group.add(createPlate(cellSize, 0x454545, 0));
  const rock = new Mesh(new IcosahedronGeometry(0.32, 0), material(0x757575));
  rock.position.y = 0.24;
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);
  return group;
}

/**
 * Water: a full-cell plate recessed by a small vertical step (a pond bank), plus
 * a full-cell shallow sheen on its surface. The recess and the sheen are both
 * full-footprint, never an inset, so water neighbours share edges exactly. Opaque
 * on purpose: the depth buffer resolves it, not a transparent pass.
 */
function createWaterVisual(cellSize: number): Group {
  const group = new Group();
  // Slightly shinier than the land plates: material differentiation that does
  // not touch the horizontal footprint.
  const pond = new Mesh(
    new BoxGeometry(cellSize, 0.2, cellSize),
    material(0x2f6fb0, { roughness: 0.25, metalness: 0.1 }),
  );
  // Top at -0.06, so the box centre is 0.1 below it: a full-footprint vertical
  // step (a pond bank), not an inset.
  pond.position.y = -0.16;
  pond.receiveShadow = true;
  group.add(pond);
  // A FULL-cell shallow sheen, not a smaller pad: a per-cell shrunken patch reads
  // as a shrunken tile (the same artefact the path inlay had). Because it is
  // full-cell, neighbouring water sheens meet at their edges and the surface stays
  // continuous.
  const sheen = new Mesh(
    new BoxGeometry(cellSize, 0.02, cellSize),
    material(0x63a9e0, { roughness: 0.15, metalness: 0.05 }),
  );
  // Top at -0.04, i.e. 0.02 above the pond surface, so it never z-fights.
  sheen.position.y = -0.05;
  sheen.receiveShadow = true;
  group.add(sheen);
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

/**
 * The independent `GridOverlay` presentation layer: ONE line object plus ONE
 * reusable cell marker, built once from the grid spec.
 *
 * It is deliberately not one object per tile: the cell boundaries are a single
 * `LineSegments` geometry (a positions buffer of all boundary segments) and the
 * highlight is a single marker mesh that is re-positioned. Farming / placement /
 * selection / debug modes will switch this layer on; none of those modes exist
 * yet, so it is hidden by default and the UI toggle stands in for that switch.
 *
 * The whole group is lifted by one layer-wide {@link GRID_OVERLAY_LIFT} in
 * {@link createThreeRuntime}; the geometry here is authored at local y = 0.
 */
function buildGridOverlay(grid: RuntimeGridSpec): {
  group: Group;
  line: LineSegments;
  marker: Mesh;
} {
  const group = new Group();
  group.name = 'GridOverlay';

  const startX = grid.origin.x;
  const endX = grid.origin.x + grid.width * grid.cellSize;
  const startZ = grid.origin.z;
  const endZ = grid.origin.z + grid.depth * grid.cellSize;
  const positions: number[] = [];
  for (let i = 0; i <= grid.width; i += 1) {
    const x = startX + i * grid.cellSize;
    positions.push(x, 0, startZ, x, 0, endZ);
  }
  for (let i = 0; i <= grid.depth; i += 1) {
    const z = startZ + i * grid.cellSize;
    positions.push(startX, 0, z, endX, 0, z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const line = new LineSegments(geometry, new LineBasicMaterial({ color: 0xffe08a }));
  group.add(line);

  const marker = new Mesh(
    new BoxGeometry(grid.cellSize * 0.96, 0.04, grid.cellSize * 0.96),
    new MeshBasicMaterial({ color: 0xffd23f }),
  );
  marker.visible = false;
  group.add(marker);

  return { group, line, marker };
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

/** Reused across `measureVisualTopY`/`measureVisualFootprint` calls so measurement does not allocate. */
const scratchParentInverse = new Matrix4();
const scratchTransform = new Matrix4();
const scratchBox = new Box3();
const scratchFootprintBox = new Box3();

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
 * Horizontal footprint (x and z extents) of a visual, measured from the real
 * geometry and every transform in between, relative to the node root.
 *
 * Mirrors {@link measureVisualTopY}: each mesh's full matrix relative to the
 * root is applied to its geometry AABB, so a nested/rotated decoration and the
 * catalogue's `scale` on a loaded model all contribute. The node's own
 * authoritative world transform cancels, so this is the visual's own footprint.
 *
 * This is the seamlessness proof: a full-cell terrain plate measures exactly the
 * grid `cellSize` on both axes, so any per-terrain inset shows up here as a
 * measured shrink rather than passing inspection unnoticed.
 */
function measureVisualFootprint(visual: Object3D): { x: number; z: number } {
  visual.updateWorldMatrix(true, true);
  if (visual.parent !== null) {
    scratchParentInverse.copy(visual.parent.matrixWorld).invert();
  } else {
    scratchParentInverse.identity();
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
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
    scratchFootprintBox.copy(box).applyMatrix4(scratchTransform);
    minX = Math.min(minX, scratchFootprintBox.min.x);
    maxX = Math.max(maxX, scratchFootprintBox.max.x);
    minZ = Math.min(minZ, scratchFootprintBox.min.z);
    maxZ = Math.max(maxZ, scratchFootprintBox.max.z);
  });
  if (minX === Number.POSITIVE_INFINITY || minZ === Number.POSITIVE_INFINITY) {
    return { x: 0, z: 0 };
  }
  return { x: maxX - minX, z: maxZ - minZ };
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
  /**
   * Grid spec the terrain footprint and the `GridOverlay` are built from. When
   * omitted the runtime derives the default grid from `bounds` with
   * {@link DEFAULT_CELL_SIZE}; the real client passes its view-model grid through
   * so a non-default `cellSize`/origin is honoured.
   */
  grid?: RuntimeGridSpec;
  /** Injectable model loader; defaults to the real `GLTFLoader` (`loadGlbTemplate`). */
  loadModel?: ModelLoader;
  /** Injectable asset catalogue; defaults to `MODEL_CATALOGUE`. */
  catalogue?: AppearanceModelCatalogue;
}): RenderRuntime {
  const bounds = options.bounds;
  const cellSize = options.grid?.cellSize ?? DEFAULT_CELL_SIZE;
  const grid: RuntimeGridSpec = options.grid ?? {
    origin: { ...bounds.min },
    width: Math.max(0, Math.round((bounds.max.x - bounds.min.x) / cellSize)),
    depth: Math.max(0, Math.round((bounds.max.z - bounds.min.z) / cellSize)),
    cellSize,
  };
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

  // Scene graph: WorldRoot -> { Terrain, WorldObjects, Actors, Effects, GridOverlay }.
  // GridOverlay is a presentation layer, not a prefab group: `inspect().groups`
  // counts only the four prefab groups, and the overlay is reported separately.
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

  // Independent grid-layer state (hidden by default). The group itself is built
  // ONCE here from the grid spec and is never rebuilt per frame or per tile.
  let gridOverlay: ReturnType<typeof buildGridOverlay> | null = buildGridOverlay(grid);
  gridOverlay.group.position.y = groundY + GRID_OVERLAY_LIFT;
  gridOverlay.group.visible = false;
  worldRoot.add(gridOverlay.group);
  let gridOverlayVisible = false;
  let highlightedCell: { x: number; z: number } | null = null;

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

  const camera = new PerspectiveCamera(RENDER_CAMERA.fovMaxDegrees, 1, RENDER_CAMERA.minNear, 100);
  // Fixed child of the rig: offset up/back along the (rig-local) view axis and
  // pitched down. The rig's yaw rotates the whole assembly. The offset distance
  // is yaw-independent (`reframe` derives it from the worst-case fit and it only
  // changes with aspect/zoom), so rotating is a pure orbit. The FOV is what
  // changes per yaw to preserve the orthographic composition.
  cameraRig.add(camera);

  // Canvas aspect, updated on resize; defaults to square before any layout.
  let cameraAspect = 1;

  /**
   * Apply the rig's rotation, then reframe the perspective frustum. The camera is
   * a fixed local child of the rig; only `rightX/rightY/rightZ`-equivalent yaw on
   * the rig and the pitch-down rotation on the camera are set here. The camera's
   * local offset is written by {@link reframe} because it depends on the fit.
   */
  function applyCameraTransform(): void {
    cameraRig.rotation.y = yawDegrees * DEGREES_TO_RADIANS;
    camera.rotation.set(-pitchDegrees * DEGREES_TO_RADIANS, 0, 0);
    reframe();
  }

  /** Reframe the perspective frustum for the current rig state and aspect. */
  function reframe(): void {
    const frustum = perspectiveFrustum({
      bounds,
      aspect: cameraAspect,
      pitchDegrees,
      yawDegrees,
      zoom,
    });
    const pitch = pitchDegrees * DEGREES_TO_RADIANS;
    camera.position.set(
      0,
      frustum.distance * Math.sin(pitch),
      frustum.distance * Math.cos(pitch),
    );
    camera.aspect = frustum.aspect;
    camera.fov = frustum.fovDegrees;
    camera.near = frustum.near;
    camera.far = frustum.far;
    camera.updateProjectionMatrix();
    sizeBackdrop();
  }

  // Single ground backdrop. The geometry stays a unit plane so reframing only
  // rescales ONE mesh instead of rebuilding/disposing geometry every frame. It
  // lies in the XZ plane just below the terrain plates.
  const groundGeometry = new PlaneGeometry(1, 1);
  const groundMaterial = new MeshStandardMaterial({ color: 0x241c14 });
  let ground: Mesh | null = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(worldCenterX, groundY - BACKDROP_DROP, worldCenterZ);
  //
  // It deliberately does NOT receive (or cast) shadows. This backdrop is an
  // effectively unbounded base sized from the frustum footprint plus overshoot,
  // so it extends far beyond the sun's shadow frustum (which only covers the
  // world plus a margin: `shadowExtent = max(worldWidth, worldDepth) / 2 + 4`,
  // i.e. +-10 for the default world). Measured before this fix:
  //   zoom 1:    backdrop  75.3 x  75.3 (half  37.6) -> 73.4% of the visible
  //              floor lay beyond the +-10 shadow map
  //   zoom 0.25: backdrop 263.6 x 263.6 (half 131.8) -> 92.4% lay beyond it
  // Outside a directional light's shadow frustum the lookup clamps to the border
  // texel, so most of the floor was shaded by a value that is not its own,
  // producing a hard straight boundary in WORLD space. Projected through a yawed
  // camera that boundary reads exactly as a floor that tapers away / is seen from
  // below (the false "trapezoid"). The TERRAIN plates keep receiving shadows:
  // they are the visible lit ground and lie inside the +-10 frustum, as do all
  // props (the world is only +-6 here), so nothing else meaningful is outside it.
  // Do NOT restore receiveShadow here and do NOT shrink the backdrop back to a
  // bounds-sized plane (that reintroduces the phase-10 clipped floor edge).
  ground.receiveShadow = false;
  ground.castShadow = false;
  scene.add(ground);

  /**
   * Grow the single backdrop so the current frustum's projected footprint lands
   * well inside it (see {@link backdropHalfExtents}). Called from `reframe`, so
   * every yaw / zoom / aspect change re-covers before the next render. The
   * overshoot pushes the silhouette off-screen and is what makes the floor read
   * as unbounded rather than as a clipped trapezoid.
   */
  function sizeBackdrop(): void {
    if (ground === null) {
      return;
    }
    const extents = backdropHalfExtents({
      bounds,
      aspect: cameraAspect,
      pitchDegrees,
      yawDegrees,
      zoom,
      overshoot: BACKDROP_OVERSHOOT,
    });
    ground.scale.set(extents.halfX * 2, extents.halfZ * 2, 1);
  }

  applyCameraTransform();

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
    const footprint = measureVisualFootprint(wrapper);
    node.footprintX = footprint.x;
    node.footprintZ = footprint.z;
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
    const visual = prefab.createVisual(cellSize);
    root.add(visual);
    // Coarse draw order only; the depth buffer resolves real occlusion.
    root.renderOrder = LAYER_RENDER_ORDER[command.layer];
    groups[prefab.group].add(root);
    const shadowFlags = measureShadowFlags(visual);
    const footprint = measureVisualFootprint(visual);
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
      footprintX: footprint.x,
      footprintZ: footprint.z,
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
    node.visual = prefab.createVisual(cellSize);
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
    const footprint = measureVisualFootprint(node.visual);
    node.footprintX = footprint.x;
    node.footprintZ = footprint.z;
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
        scale: { x: node.root.scale.x, y: node.root.scale.y, z: node.root.scale.z },
        footprintX: node.footprintX,
        footprintZ: node.footprintZ,
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
      backdrop:
        ground === null
          ? null
          : {
              // The backdrop is a unit `PlaneGeometry` scaled on local X/Y, so
              // the full world extent is the geometry size times the real mesh
              // scale, read back off the mesh that lives below the terrain.
              sizeX: groundGeometry.parameters.width * ground.scale.x,
              sizeZ: groundGeometry.parameters.height * ground.scale.y,
              center: {
                x: ground.position.x,
                y: ground.position.y,
                z: ground.position.z,
              },
              castsShadow: ground.castShadow,
              receivesShadow: ground.receiveShadow,
            },
      background: scene.background instanceof Color ? scene.background.getHex() : null,
      groups: Object.values(groups).filter((group) => group.parent === worldRoot).length,
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
        fovDegrees: camera.fov,
        near: camera.near,
        far: camera.far,
        aspect: camera.aspect,
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
      gridOverlay:
        gridOverlay === null
          ? {
              visible: false,
              highlightedCell: null,
              lineObjectCount: 0,
              highlightMarkerCount: 0,
            }
          : {
              visible: gridOverlayVisible,
              highlightedCell:
                highlightedCell === null ? null : { ...highlightedCell },
              lineObjectCount: gridOverlay.group.children.filter(
                (child) => child instanceof LineSegments,
              ).length,
              highlightMarkerCount: gridOverlay.group.children.filter(
                (child) => child instanceof Mesh,
              ).length,
            },
    };
  }

  /**
   * Size the drawing buffer and reframe the camera from the canvas' current
   * layout size. See {@link perspectiveFrustum} for the projection policy.
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

  /** Show or hide the independent grid layer (hidden by default). */
  function setGridOverlayVisible(visible: boolean): void {
    if (gridOverlay === null) {
      return;
    }
    gridOverlayVisible = visible;
    gridOverlay.group.visible = visible;
  }

  /**
   * Record a highlighted grid cell and move the single reusable marker to its
   * world centre, or hide the marker with `null`. The cell is plain grid data; no
   * gameplay meaning is attached to it in the runtime.
   */
  function setHighlightedCell(cell: { x: number; z: number } | null): void {
    highlightedCell = cell === null ? null : { x: cell.x, z: cell.z };
    if (gridOverlay === null) {
      return;
    }
    const marker = gridOverlay.marker;
    if (highlightedCell === null) {
      marker.visible = false;
      return;
    }
    marker.position.set(
      grid.origin.x + (highlightedCell.x + 0.5) * grid.cellSize,
      0,
      grid.origin.z + (highlightedCell.z + 0.5) * grid.cellSize,
    );
    marker.visible = true;
  }

  // Reused across picks so a drag/click loop does not allocate per query.
  const raycaster = new Raycaster();
  const pickNdc = new Vector2();
  // The mathematical ground plane at the world's floor; independent of the tile
  // plates, which are full-footprint and seamless by construction.
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
    if (gridOverlay !== null) {
      // The overlay is presentation-only but owns real GPU resources; release
      // them rather than only detaching the group with the rest of WorldRoot.
      worldRoot.remove(gridOverlay.group);
      gridOverlay.line.geometry.dispose();
      released.geometries += 1;
      accumulateRelease(releaseMaterial(gridOverlay.line.material));
      gridOverlay.marker.geometry.dispose();
      released.geometries += 1;
      accumulateRelease(releaseMaterial(gridOverlay.marker.material));
      gridOverlay = null;
    }
    gridOverlayVisible = false;
    highlightedCell = null;
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
    setGridOverlayVisible,
    setHighlightedCell,
    pick,
    inspect,
    dispose,
  };
}
