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
 * The rig owns follow + smoothing, a **clamped, settable** pitch, free yaw, and
 * zoom. It is deliberately a **narrow-FOV perspective** camera (phase 11): the
 * tilt and the narrow FOV give a gentle near-large/far-small read without a
 * strong third-person look. Phase 11 Wave D makes the view a **pure orbit with an
 * unchanging projection at any single pitch**: the FOV is a fixed constant and the
 * camera DISTANCE is fixed from the worst-case yaw fit at the current pitch, so
 * neither depends on yaw, and rotating cannot dolly or zoom. Phase 13 reverses the
 * earlier "no adjustable path" decision and adds {@link RenderRuntime.setCameraPitch}:
 * the pitch is clamped to `[minPitchDegrees, maxPitchDegrees]` and re-runs the same
 * reframe path, while a canvas drag remains yaw-only so it can never tilt the view.
 * The world model, the Actor motion model, and the Render ISA carry no projection
 * assumption, so the rig remains the *only* module that knows how the scene is
 * projected. Yaw rotates the rig (and therefore the view); it never changes the
 * world coordinate system.
 *
 * `inspect()` exposes the rig as plain data (`pitchDegrees`, `yawDegrees`,
 * `zoom`, the honest perspective frustum — `fovDegrees`/`near`/`far`/`aspect` —
 * and the camera's world position/forward/up) so tests can assert the pitch, yaw
 * view changes, and zoom extent numerically.
 *
 * Layer / depth / occlusion (frozen policy)
 * ----------------------------------------
 * Occlusion is resolved by a **real 3D depth buffer** plus the tilted camera.
 * There is no per-object hand-written z, and none may be added. The ISA's
 * `layer` ('base' | 'object') is coarse ordering only and is applied here as
 * `renderOrder`.
 *
 * Block world + an independent grid layer
 * ---------------------------------------
 * The visible ground is the BLOCK layer: one object-layer node per non-air
 * block, each a full-cell visual with an exact `cellSize` horizontal footprint so
 * neighbouring blocks share their edges with no seam. The retired phase-14
 * terrain plates and surface prefabs are gone; a block is placed directly at its
 * authoritative world transform and the runtime knows nothing about cells.
 *
 * `GridOverlay` (one `LineSegments` plus one reusable marker, built once from the
 * grid spec) is hidden by default, sits under `WorldRoot` alongside the prefab
 * groups, and is lifted by one layer-wide `GRID_OVERLAY_LIFT` to avoid z-fighting.
 * The lift is an overlay concern only; it is never a per-cell seam fix.
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
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
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
import type { AnimationAction, AnimationClip, Light, Material, Object3D } from 'three';
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
import type { AppearanceModelCatalogue, AssetClips, AssetDescriptor } from './assets';
import { BLOCK_RENDER_REGISTRY } from './blocks';

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
 * A parsed GLB plus the animation clips it shipped, as returned by a model
 * loader. The runtime only needs the scene graph and the clip list; clip
 * *playback* is owned by the per-node `AnimationMixer`.
 */
export interface LoadedModel {
  readonly scene: Object3D;
  readonly animations?: readonly AnimationClip[];
}

/**
 * Resolves a GLB URL to a parsed template `Object3D` (optionally with clips).
 *
 * Injected so tests never touch the network. The default is the real
 * `GLTFLoader` (see `loadGlbTemplate`); the runtime caches one parse per URL and
 * clones per node. A bare `Object3D` is accepted for backward compatibility and
 * treated as a clip-less template.
 */
export type ModelLoader = (url: string) => Promise<Object3D | LoadedModel>;

/** Narrow a loader result to the clip-carrying shape. */
function isLoadedModel(value: Object3D | LoadedModel): value is LoadedModel {
  return typeof value === 'object' && value !== null && 'scene' in value;
}

/**
 * A cached parse: the scene graph plus the clips the runtime may play. Normalised
 * from the loader's `Object3D | LoadedModel` result so a bare-`Object3D` loader
 * (an older test or caller) is treated as clip-less.
 */
interface ParsedTemplate {
  scene: Object3D;
  animations: readonly AnimationClip[];
}

/**
 * Plain-data result of `pick(ndcX, ndcY)`: a registered node visual, the
 * mathematical ground plane, or nothing.
 *
 * It returns no Three.js object and no camera/ray data, because none of those may
 * ever reach a command. `nodeId` is the runtime's own opaque id; mapping it to
 * game identity is the bridge's job, not the runtime's.
 */
export type RenderPick =
  | {
      readonly kind: 'node';
      readonly nodeId: NodeId;
      /**
       * World-space point where the ray first met the node visual. The runtime
       * does not know whether a node is an entity or a block; the UI uses this
       * point for a non-entity (block) click exactly as it uses the ground
       * point for a flat-ground click.
       */
      readonly point: { readonly x: number; readonly y: number; readonly z: number };
      /**
       * World-space unit normal of the hit face. The runtime reports it so the
       * caller can tell a TOP face (`normal.y > 0.5`) from a side/bottom face
       * without re-deriving geometry; it carries no gameplay meaning.
       */
      readonly normal: { readonly x: number; readonly y: number; readonly z: number };
    }
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
   * `cellSize` is the world-space edge length the visual must span (a block
   * visual fills exactly one cell; a non-cell visual ignores it). Threading it
   * here is what makes a block footprint exactly the grid cell, with no inset.
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
   * `center` its world position (below the block layer). It is sized from the
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
  /**
   * Sun shadow configuration, or `null` once the light rig has been released.
   *
   * `extent` is the half-width of the orthographic shadow camera's frustum, in
   * world units. It is derived from the WORLD bounds alone
   * (`max(worldWidth, worldDepth) / 2 + 4`), never from the visible ground
   * footprint: the oversized backdrop is far larger than the shadow frustum and
   * deliberately neither casts nor receives shadows, so letting the shadow
   * camera grow with the (zoom/pitch-dependent) visible floor would blow up the
   * shadow frustum and collapse the 1024x1024 map's effective resolution. Pinned
   * so a mutation cannot couple the two.
   */
  shadow: {
    sunCasts: boolean;
    mapWidth: number;
    mapHeight: number;
    extent: number;
  } | null;
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
     * node's own authoritative transform cancels). For every full-cell block
     * this is exactly the grid `cellSize`, which is the "no shrink, no seams"
     * proof: a reintroduced inset changes this measured value.
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
    /**
     * Whether a loaded GLB gave this node an `AnimationMixer`. Optional so a
     * caller-authored inspection stub need not supply it; the real runtime
     * always reports it.
     */
    hasMixer?: boolean;
    /**
     * Name of the clip the node's mixer is currently playing, or `null` when it
     * has no mixer / no active action. Proves clip playback beyond the recorded
     * `animation` id.
     */
    mixerClip?: string | null;
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
  /**
   * Plain-data view of the pending placement ghost, or `null` when none.
   * `colour` is the hex colour the server's `valid` verdict mapped to; it exists
   * so a test can prove the mapping is a pure function of that verdict.
   */
  placementGhost: {
    present: boolean;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    footprintX: number;
    footprintZ: number;
    height: number;
    valid: boolean | null;
    colour: number;
    occupiedCellCount: number;
    /**
     * Whether `position` is the footprint's BASE (default) or its CENTRE.
     * A block ghost is centre-anchored because a block node root sits at the
     * cell centre; entity ghosts stay base-anchored.
     */
    pivot: 'base' | 'center';
  } | null;
}

/** Structural world AABB the runtime frames; deliberately not the Organizer type. */
export interface RuntimeWorldBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Structural grid spec the runtime builds its `GridOverlay` from; deliberately
 * not the Organizer type, but structurally compatible so the UI can pass its
 * `blockGrid` view model through unchanged. It is the pure block-grid addressing
 * configuration (`origin` + `cellSize`); `width`/`depth` are no longer part of
 * the block world and are accepted only as an optional debug/legacy span hint.
 */
export interface RuntimeGridSpec {
  origin: { x: number; y: number; z: number };
  cellSize: number;
  /** Optional overlay span in cells; when omitted the overlay spans the bounds. */
  width?: number;
  depth?: number;
}

/** Cell edge length used when a caller supplies no grid spec (the default grid). */
export const DEFAULT_CELL_SIZE = 1;

/**
 * Single, layer-wide lift of the `GridOverlay` above the block tops so the
 * overlay's lines do not z-fight with the block visuals.
 *
 * This is an OVERLAY LIFT, not a seam fix: it is one constant for the whole
 * layer (never per-cell) and says nothing about the block geometry, which stays
 * exactly cell-sized and continuous.
 */
const GRID_OVERLAY_LIFT = 0.05;

/**
 * A pending placement preview, as plain data.
 *
 * PURE PRESENTATION. `valid` is the SERVER's verdict (`null` while pending): the
 * runtime maps it to a colour and never re-decides it. `position`/`rotation` are
 * the client's snapped candidate or the server's `resolvedTransform`, and
 * `footprintX`/`footprintZ`/`height` are catalogue geometry. `occupiedCells` is
 * the server's occupancy report and is used only for a highlight. `pivot`
 * chooses whether `position` is the footprint's base (default) or its centre: a
 * block node root is the cell centre, so a block ghost sets `'center'`.
 */
export interface PlacementGhost {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  footprintX: number;
  footprintZ: number;
  height: number;
  /** The server's verdict, or `null` while neutral/pending. */
  valid: boolean | null;
  /** Cells the server reported as occupied; presentation-only highlight. */
  occupiedCells?: readonly { x: number; y: number; z: number }[];
  /** Where `position` anchors the box height: base (default) or centre. */
  pivot?: 'base' | 'center';
}

/**
 * Colours the pending placement ghost's `valid` verdict maps to. Purely
 * presentational: the server decides validity, the renderer only tints. Exported
 * so a test can pin that the colour is a pure function of the server verdict and
 * that no client rule participates.
 */
export const RENDER_GHOST_COLOURS = {
  /** Server said valid. */
  valid: 0x39d353,
  /** Server said invalid. */
  invalid: 0xe5484d,
  /** No verdict yet (pending/neutral). */
  neutral: 0x58a6ff,
  /** Highlight for server-reported occupied cells. */
  occupied: 0xf0a020,
} as const;

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
   * Set the rig's yaw. This is deliberately yaw-only so a drag can NEVER tilt the
   * view; the pitch has its own explicit setter ({@link setCameraPitch}) and is
   * never inferred from an orientation field. Yaw is normalised to `[0, 360)`.
   * Rotating the rig never changes world coordinates.
   */
  setCameraOrientation(orientation: { yawDegrees?: number }): void;
  /**
   * Set the rig's downward pitch in degrees, clamped to
   * `[RENDER_CAMERA.minPitchDegrees, RENDER_CAMERA.maxPitchDegrees]`. The value is
   * a presentation/camera-rig parameter (never a Protocol field), and the setter
   * re-runs the same reframe path as yaw/zoom so every derived quantity
   * (orbit distance, backdrop, near/far, the camera transform) follows. A
   * non-finite input is ignored.
   */
  setCameraPitch(degrees: number): void;
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
   * Show, update, or clear (`null`) the pending placement ghost: pure catalogue
   * geometry at a candidate transform. `valid` is the server's verdict and is the
   * ONLY input to the ghost's colour; the runtime makes no placement decision.
   */
  setPlacementGhost(ghost: PlacementGhost | null): void;
  /**
   * Resolve a normalized device coordinate (`[-1, 1]`, origin centre, `+y` up)
   * to plain pick data:
   *
   * 1. a registered `object`-layer node visual under the ray ->
   *    `{ kind: 'node', nodeId, point, normal }`. Blocks are object-layer and
   *    ARE the visible ground, so a block hit reports a node AND its ray point;
   *    the caller turns an entity node into an interact intent and any other
   *    node (a block) into a move intent toward the point;
   * 2. otherwise the mathematical ground plane (`y = bounds.min.y`) ->
   *    `{ kind: 'ground', point }` for cells with no block under the ray;
   * 3. otherwise `null`.
   *
   * A node hit always reports the ray intersection `point` and the face's
   * world-space `normal` alongside the opaque `nodeId`. The runtime cannot tell
   * an entity node from a block node, so the caller decides what to do with it:
   * an entity node becomes an interact intent, any other node (a block) becomes
   * a move intent toward the clicked point, exactly like the ground.
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
  /**
   * Per-node `AnimationMixer` for a loaded GLB, or `null` for the procedural
   * placeholder. Built only when the parsed template actually shipped clips; the
   * placeholder has no clips and keeps its `motion`.
   */
  mixer: AnimationMixer | null;
  /** Named clip slots the catalogue declared for this appearance. */
  clipNames: AssetClips;
  /** Playable actions keyed by the named slot (`idle`/`walk`/`interact`). */
  mixerActions: Partial<Record<'idle' | 'walk' | 'interact', AnimationAction>> | null;
  /** The action currently fading in, or `null` at rest. */
  activeAction: AnimationAction | null;
}

/** Camera stance. Exported so projection tests and the HUD share one source. */
export const RENDER_CAMERA = {
  /**
   * The camera's INITIAL/default downward pitch from the horizontal, in degrees.
   *
   * It is also the value a reload resets to (there is deliberately no
   * persistence). The live pitch is settable through the explicit rig API
   * {@link RenderRuntime.setCameraPitch} (and reported in `inspect().camera`)
   * because the in-world settings panel exposes it; a drag on the canvas still
   * only yaws, so the `setCameraOrientation` guarantee is unchanged.
   */
  pitchDegrees: 35,
  /**
   * Lower clamp for the settable pitch, in degrees.
   *
   * An unbounded low pitch is unsafe: the visible ground distance grows like
   * `1 / tan(pitch - fov/2)`, so as the top viewport ray approaches the horizon
   * the single backdrop and the far plane blow up without bound. 25 keeps a
   * strict, generous margin: `25 - fov/2 = 11` degrees below the horizon at the
   * top of the frame (with `fov = 28`), so the footprint stays finite and the
   * composition stays a framed world rather than an edge toward infinity.
   */
  minPitchDegrees: 25,
  /**
   * Upper clamp for the settable pitch, in degrees. 75 is a steep, near
   * top-down view; 90 would be straight down and is deliberately excluded.
   */
  maxPitchDegrees: 75,
  /**
   * The fixed vertical field of view, in degrees. Deliberately narrow (phase 11)
   * so the projected near/far size difference stays gentle.
   *
   * Wave D: this is a CONSTANT. Wave C derived it per yaw to keep the world's
   * projected bounding box inside the frame, but a per-yaw FOV is a per-yaw
   * zoom: a fixed-size object appeared ~38% larger at axis-aligned yaws than at
   * the diagonals (the reported "map pulls farther away then closer" defect).
   * The fit now uses this fixed FOV and instead places the camera at the
   * WORST-CASE yaw distance, so the projection is completely constant while
   * rotating (see {@link perspectiveFrustum}).
   */
  fovDegrees: 28,
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
function applyAssetFixes(visual: Group, asset: AssetDescriptor): void {
  if (asset.scale !== undefined) {
    visual.scale.set(asset.scale.x, asset.scale.y, asset.scale.z);
  }
  if (asset.yawOffsetRadians !== undefined) {
    visual.rotation.y = asset.yawOffsetRadians;
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
export async function loadGlbTemplate(url: string): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
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
 * The largest symmetric half-height the rig must show to frame `bounds` over
 * EVERY yaw, computed in closed form (the Wave-C closed form, retained).
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

/**
 * The fixed orbit distance for an aspect/zoom: the WORST-case yaw fit at the
 * fixed FOV. It is the same at every yaw (and therefore at every `yawDegrees` the
 * rig can take), so rotating is a pure orbit and the projection never changes.
 */
function orbitDistance(
  bounds: RuntimeWorldBounds,
  aspect: number,
  pitchDegrees: number,
  zoom: number,
): number {
  const tanHalfFov = Math.tan((RENDER_CAMERA.fovDegrees * DEGREES_TO_RADIANS) / 2);
  return worstCaseFittedHalfHeight(bounds, aspect, pitchDegrees, zoom) / tanHalfFov;
}

/**
 * Perspective frustum plus the visible ground footprint that frame the world's
 * ground rectangle for the rig's current pitch/yaw/zoom and a canvas aspect.
 *
 * Phase 11 Wave D: the rig is a **pure orbit with a completely constant
 * projection**.
 *
 * - The camera basis (right/up/forward) and the symmetric bounds fit are the
 *   phase-10 orthographic fit: the world bounds' XZ footprint (at ground level)
 *   is projected onto the camera's right/up axes, `verticalHeadroom` keeps tall
 *   props off the clip edge, and `framingMargin` pushes both axes past the tight
 *   fit.
 * - The FOV is a FIXED constant (`RENDER_CAMERA.fovDegrees`). The camera
 *   DISTANCE is fixed from the WORST-case yaw fit at that FOV
 *   (`distance = worstCaseFittedHalfHeight(bounds, aspect, pitch, zoom) /
 *   tan(fov / 2)`), so it does NOT depend on yaw. Rotating is therefore a pure
 *   orbit with an unchanging projection: FOV, distance, the camera's rig-local
 *   offset (orbit radius/height), near and far are all yaw-invariant, and no
 *   object changes apparent size.
 * - `zoom` is a DOLLY: `distance` is inversely proportional to zoom while the
 *   FOV is zoom-invariant. A dolly does change perspective strength (a farther
 *   camera foreshortens less), which is expected for an explicit zoom action; at
 *   any single zoom the pure-orbit property is exact.
 * - `near` is derived from the geometry, not a close constant. The camera may
 *   follow anywhere inside the world, so a conservative world radius (the bounds
 *   diagonal) is subtracted from the distance, leaving `nearClearance` as
 *   margin. It is additionally clamped below the nearest VISIBLE ground depth so
 *   the backdrop can never be clipped on-screen. `far` is derived from the
 *   visible ground footprint (1.2x the farthest viewport ground corner plus 1),
 *   so blocks and backdrop stay inside the frustum.
 *
 * Honest consequence of the fixed FOV: the world's projected OUTLINE still
 * varies with yaw, because a square world seen edge-on subtends a narrower width
 * than the same square seen corner-on. That is inherent to rotating a square and
 * is NOT zoom pumping: object scale at the focus plane is constant (a fixed-size
 * segment projects to a yaw-invariant NDC length). The fit uses the WORST-case
 * yaw (the box diagonal), so the axis-aligned yaws simply carry more margin. The
 * only levers that would flatten the outline are a wider FOV / farther camera or
 * a 90-degree-stepped yaw; never a per-yaw FOV.
 */
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

  const distance = orbitDistance(options.bounds, aspect, options.pitchDegrees, zoom);
  // The FOV is a fixed constant: it does NOT depend on `yawDegrees`. Together
  // with the yaw-independent distance, this is what makes the whole projection
  // constant during a rotation.
  const fovDegrees = RENDER_CAMERA.fovDegrees;
  const tanHalfFov = Math.tan((fovDegrees * DEGREES_TO_RADIANS) / 2);
  // Visible half-height at the focus plane. Constant across yaw.
  const halfHeight = distance * tanHalfFov;
  const halfWidth = halfHeight * aspect;

  // Camera position relative to the focus. The focus lies on the ground plane,
  // so the camera height above it is `distance * sin(pitch)`. The distance is
  // yaw-independent, so rotating the rig orbits without dollying.
  const camX = distance * cosPitch * sinYaw;
  const camY = distance * sinPitch;
  const camZ = distance * cosPitch * cosYaw;

  // Project the four viewport corners onto the ground plane. For the rig's
  // clamped pitch and fixed FOV every ray points below the horizon
  // (minPitchDegrees 25 > fov/2 = 14), so the footprint is a finite trapezoid;
  // `footprintHalfX/Z` are measured from the focus, `maxDepth` is the farthest
  // camera-to-corner distance used for `far`, and `minDepth` is the nearest
  // VISIBLE ground distance used to keep the near plane from clipping the
  // backdrop on-screen.
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
        // unbounded. Cannot happen for the clamped rig
        // (minPitchDegrees 25 > fov/2 = 14), but keep the guard so a future
        // FOV/pitch change cannot produce NaN.
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

/** Rock placeholder: a low facetted boulder anchored at its base. */
function createRockVisual(): Group {
  const group = new Group();
  const rock = new Mesh(new OctahedronGeometry(0.42, 0), material(0x8a8a8a, { roughness: 0.95 }));
  rock.position.y = 0.32;
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);
  return group;
}

/** Chest placeholder: a small boxed container with a lid. */
function createChestVisual(): Group {
  const group = new Group();
  const base = new Mesh(new BoxGeometry(0.5, 0.32, 0.36), material(0x8a5a2b));
  base.position.y = 0.16;
  base.castShadow = true;
  base.receiveShadow = true;
  const lid = new Mesh(new BoxGeometry(0.54, 0.12, 0.4), material(0xb07b3f));
  lid.position.y = 0.38;
  lid.castShadow = true;
  group.add(base, lid);
  return group;
}

/** Building placeholder: a tall roofed volume, readable from any yaw. */
function createBuildingVisual(): Group {
  const group = new Group();
  const walls = new Mesh(new BoxGeometry(0.9, 1.2, 0.9), material(0xcaa06a));
  walls.position.y = 0.6;
  walls.castShadow = true;
  walls.receiveShadow = true;
  const roof = new Mesh(new ConeGeometry(0.72, 0.5, 4), material(0x9c4a3a));
  roof.position.y = 1.45;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  group.add(walls, roof);
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
function buildGridOverlay(
  grid: RuntimeGridSpec,
  bounds: RuntimeWorldBounds,
): {
  group: Group;
  line: LineSegments;
  marker: Mesh;
} {
  const group = new Group();
  group.name = 'GridOverlay';

  // The block grid has no fixed extent, so the overlay spans the world bounds
  // snapped outward to whole cells. An explicit `width`/`depth` (legacy/debug)
  // still wins when supplied.
  const cellSize = grid.cellSize;
  const startX =
    grid.width !== undefined
      ? grid.origin.x
      : grid.origin.x + Math.floor((bounds.min.x - grid.origin.x) / cellSize) * cellSize;
  const endX =
    grid.width !== undefined
      ? grid.origin.x + grid.width * cellSize
      : grid.origin.x + Math.ceil((bounds.max.x - grid.origin.x) / cellSize) * cellSize;
  const startZ =
    grid.depth !== undefined
      ? grid.origin.z
      : grid.origin.z + Math.floor((bounds.min.z - grid.origin.z) / cellSize) * cellSize;
  const endZ =
    grid.depth !== undefined
      ? grid.origin.z + grid.depth * cellSize
      : grid.origin.z + Math.ceil((bounds.max.z - grid.origin.z) / cellSize) * cellSize;
  const columns = Math.max(0, Math.round((endX - startX) / cellSize));
  const rows = Math.max(0, Math.round((endZ - startZ) / cellSize));
  const positions: number[] = [];
  for (let i = 0; i <= columns; i += 1) {
    const x = startX + i * cellSize;
    positions.push(x, 0, startZ, x, 0, endZ);
  }
  for (let i = 0; i <= rows; i += 1) {
    const z = startZ + i * cellSize;
    positions.push(startX, 0, z, endX, 0, z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const line = new LineSegments(geometry, new LineBasicMaterial({ color: 0xffe08a }));
  group.add(line);

  const marker = new Mesh(
    new BoxGeometry(cellSize * 0.96, 0.04, cellSize * 0.96),
    new MeshBasicMaterial({ color: 0xffd23f }),
  );
  marker.visible = false;
  group.add(marker);

  return { group, line, marker };
}

/**
 * The pending placement preview: a single reusable translucent box plus a pool
 * of occupied-cell highlight markers.
 *
 * Both are authored as ONE shared unit box geometry and scaled/positioned per
 * call, so a pointer-move stream never allocates geometry. The box draws on top
 * (`depthTest: false`) because it is UI, not world geometry, and must not be
 * occluded by the blocks a placement would replace.
 */
function buildPlacementGhost(): {
  group: Group;
  box: Mesh;
  boxMaterial: MeshBasicMaterial;
  geometry: BufferGeometry;
  occupiedGroup: Group;
  occupiedMaterial: MeshBasicMaterial;
  occupiedMarkers: Mesh[];
} {
  const group = new Group();
  group.name = 'PlacementGhost';
  const geometry = new BoxGeometry(1, 1, 1);
  const boxMaterial = new MeshBasicMaterial({
    color: RENDER_GHOST_COLOURS.neutral,
    transparent: true,
    opacity: 0.42,
    depthTest: false,
    depthWrite: false,
  });
  const box = new Mesh(geometry, boxMaterial);
  box.renderOrder = 1000;
  group.add(box);

  const occupiedGroup = new Group();
  occupiedGroup.name = 'PlacementGhostOccupied';
  occupiedGroup.visible = false;
  const occupiedMaterial = new MeshBasicMaterial({
    color: RENDER_GHOST_COLOURS.occupied,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
  });

  return { group, box, boxMaterial, geometry, occupiedGroup, occupiedMaterial, occupiedMarkers: [] };
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
 * This is the seamlessness proof: a full-cell block measures exactly the grid
 * `cellSize` on both axes, so any inset shows up here as a measured shrink
 * rather than passing inspection unnoticed.
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
  'appearance.rock': {
    group: 'WorldObjects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createRockVisual,
  },
  'appearance.chest': {
    group: 'WorldObjects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createChestVisual,
  },
  'appearance.building': {
    group: 'WorldObjects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createBuildingVisual,
  },
  'appearance.fallback': {
    group: 'Effects',
    defaultAnimation: IDLE_ANIMATION,
    createVisual: createFallbackVisual,
  },
};

/**
 * Block prefabs derived from the render-side {@link BLOCK_RENDER_REGISTRY}.
 *
 * The registry owns every block's geometry/material/colour (never the wire); the
 * runtime only maps an appearance id to a group and a default animation. A block
 * node's root is at the cell centre, so `createVisual(cellSize)` builds relative
 * to that centre (see `blocks.ts` for the top-face / footprint contract).
 */
const BLOCK_PREFABS: Readonly<Record<string, Prefab>> = Object.fromEntries(
  BLOCK_RENDER_REGISTRY.map((entry) => [
    entry.appearance,
    {
      group: 'Terrain',
      defaultAnimation: IDLE_ANIMATION,
      createVisual: entry.createVisual,
    } satisfies Prefab,
  ]),
);

/** Every prefab the runtime can realise: hand-authored plus the block registry. */
const ALL_PREFABS: Readonly<Record<string, Prefab>> = {
  ...PREFABS,
  ...BLOCK_PREFABS,
};

/** The prefab used for an appearance id the catalogue does not know. */
const FALLBACK_PREFAB: Prefab = PREFABS['appearance.fallback'];

/**
 * Appearance ids the runtime has a prefab for. Exported so tests can assert the
 * bridge's emitted catalogue is fully covered; an unknown id still renders with
 * {@link FALLBACK_PREFAB} rather than crashing.
 */
export const KNOWN_APPEARANCES: readonly AppearanceId[] = Object.keys(ALL_PREFABS).map(
  (id) => id as AppearanceId,
);

function prefabFor(appearance: AppearanceId): Prefab {
  return ALL_PREFABS[appearance] ?? FALLBACK_PREFAB;
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
   * Grid spec the `GridOverlay` is built from. When omitted the runtime derives
   * the default grid from `bounds` with {@link DEFAULT_CELL_SIZE}; the real
   * client passes its view-model grid through so a non-default
   * `cellSize`/origin is honoured.
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
  const templateCache = new Map<string, Promise<ParsedTemplate>>();
  // Templates whose geometry/material/texture this runtime owns and releases in
  // `dispose()`. A node's clone borrows from these.
  const ownedTemplates = new Set<Object3D>();
  const released: ReleaseCounts = emptyReleaseCounts();
  // A late load resolve after dispose must not touch the scene; this flag plus a
  // per-node token is the guard.
  let disposed = false;

  const scene = new Scene();
  // Fill the whole viewport, including the area outside the finite block ground,
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
  let gridOverlay: ReturnType<typeof buildGridOverlay> | null = buildGridOverlay(grid, bounds);
  gridOverlay.group.position.y = groundY + GRID_OVERLAY_LIFT;
  gridOverlay.group.visible = false;
  worldRoot.add(gridOverlay.group);
  let gridOverlayVisible = false;
  let highlightedCell: { x: number; z: number } | null = null;

  // Pending placement ghost and its occupied-cell highlight pool. Both groups
  // are built once and only made visible while a preview is active.
  const ghost = buildPlacementGhost();
  ghost.group.visible = false;
  worldRoot.add(ghost.group);
  worldRoot.add(ghost.occupiedGroup);
  let placementGhostState: PlacementGhost | null = null;

  const cameraRig = new Group();
  cameraRig.name = 'CameraRig';

  // Rig state. `cameraFocus` is the world point the rig is centred on (also the
  // smooth-follow target); the camera itself is a fixed local child. The pitch is
  // a mutable, clamped rig parameter (see {@link RENDER_CAMERA}); it starts at the
  // default and only `setCameraPitch` changes it — `setCameraOrientation` remains
  // yaw-only so a canvas drag can never tilt the view.
  let pitchDegrees: number = RENDER_CAMERA.pitchDegrees;
  let yawDegrees = 0;
  let zoom = 1;
  const cameraFocus = new Vector3(worldCenterX, groundY, worldCenterZ);
  cameraRig.position.copy(cameraFocus);
  scene.add(cameraRig);

  const camera = new PerspectiveCamera(
    RENDER_CAMERA.fovDegrees,
    1,
    RENDER_CAMERA.minNear,
    100,
  );
  // Fixed child of the rig: offset up/back along the (rig-local) view axis and
  // pitched down. The rig's yaw rotates the whole assembly. The offset distance
  // is yaw-independent (`reframe` derives it from the worst-case yaw fit and it
  // only changes with aspect/zoom), and the FOV is a fixed constant, so rotating
  // is a pure orbit with an unchanging projection.
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
  // lies in the XZ plane just below the block layer.
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
  // below (the false "trapezoid"). The BLOCKS keep receiving shadows: they are
  // the visible lit ground and lie inside the +-10 frustum, as do all
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
  // Wall-clock baseline for mixer deltas. Separate from follow smoothing so a
  // clip is not affected by a follow-target change.
  let lastUpdateMs: number | null = null;

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
   * Resolve `url` to a parsed template (scene graph + clips), caching **one
   * parse per URL**. Concurrent callers share the in-flight promise; a rejected
   * load is dropped so a later node can retry. A parse that lands after `dispose()`
   * is released immediately and never enters the scene.
   */
  function templateFor(url: string): Promise<ParsedTemplate> {
    const cached = templateCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const promise = loadModel(url).then((loaded) => {
      const scene = isLoadedModel(loaded) ? loaded.scene : loaded;
      const animations = isLoadedModel(loaded) ? (loaded.animations ?? []) : [];
      if (disposed) {
        accumulateRelease(releaseObject(scene));
        return { scene, animations };
      }
      ownedTemplates.add(scene);
      // Material policy once per template, so every clone shares the coerced
      // material (see `applyOpaqueMaterialPolicy`).
      applyOpaqueMaterialPolicy(scene, url);
      return { scene, animations };
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
  function resolveModel(node: RuntimeNode, nodeId: NodeId, asset: AssetDescriptor): void {
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

  /**
   * Build a BASIC `AnimationMixer` for a freshly swapped model visual, mapping
   * the catalogue's named slots to the clips the template shipped. Absent names
   * (or a template with no clips) leave the node mixer-less, so the procedural
   * placeholder motion is the only fallback. Playback is deliberately simple:
   * one active action at a time, cross-faded on a switch.
   */
  function buildMixer(node: RuntimeNode, wrapper: Group, clips: readonly AnimationClip[]): void {
    node.mixer?.stopAllAction();
    node.mixer = null;
    node.mixerActions = null;
    node.activeAction = null;
    if (clips.length === 0) {
      return;
    }
    const byName = new Map(clips.map((clip) => [clip.name, clip]));
    const mixer = new AnimationMixer(wrapper);
    const actions: Partial<Record<'idle' | 'walk' | 'interact', AnimationAction>> = {};
    for (const slot of ['idle', 'walk', 'interact'] as const) {
      const name = node.clipNames[slot];
      const clip = name === undefined ? undefined : byName.get(name);
      if (clip !== undefined) {
        actions[slot] = mixer.clipAction(clip);
      }
    }
    node.mixer = mixer;
    node.mixerActions = actions;
    // Rest at the idle clip when the asset provides one.
    const idle = actions.idle;
    if (idle !== undefined) {
      idle.reset().play();
      node.activeAction = idle;
    }
  }

  /**
   * Switch a loaded node to the action for an animation id, or back to its rest
   * clip. A no-op for a placeholder node.
   */
  function playAnimation(node: RuntimeNode, animation: AnimationId): void {
    const actions = node.mixerActions;
    if (actions === null) {
      return;
    }
    const slot: 'idle' | 'walk' | 'interact' =
      animation === 'walk' ? 'walk' : animation === 'interact' ? 'interact' : 'idle';
    const next = actions[slot] ?? actions.idle;
    if (next === undefined || next === node.activeAction) {
      return;
    }
    next.reset().fadeIn(0.2).play();
    node.activeAction?.fadeOut(0.2);
    node.activeAction = next;
  }

  /** Replace a node's placeholder with a clone of the resolved template. */
  function swapInModel(node: RuntimeNode, asset: AssetDescriptor, template: ParsedTemplate): void {
    // Wrap the clone so the node's visual stays a `Group` and the catalogue's
    // scale/orientation/anchor fixes have a single object to write to.
    const wrapper = new Group();
    wrapper.add(cloneTemplate(template.scene));
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
    node.clipNames = asset.clips ?? {};
    buildMixer(node, wrapper, template.animations);
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
      mixer: null,
      clipNames: {},
      mixerActions: null,
      activeAction: null,
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
    // Release the mixer before the root leaves the graph; the loaded clone's
    // resources are shared with the cached template and are not disposed here.
    node.mixer?.stopAllAction();
    node.mixer = null;
    node.mixerActions = null;
    node.activeAction = null;
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
    // Invalidate any in-flight load for the retired appearance, and drop the
    // previous model's mixer: the new visual has its own clips (or none).
    node.visualToken += 1;
    node.mixer?.stopAllAction();
    node.mixer = null;
    node.mixerActions = null;
    node.activeAction = null;
    node.clipNames = {};
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
            playAnimation(node, node.defaultAnimation);
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
            // Recorded (observable through `inspect()`), and — when the node has
            // a loaded GLB with a matching clip — actually played by its mixer.
            node.animation = command.animation;
            playAnimation(node, command.animation);
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
      // A loaded model carries its own clips and its catalogue `yOffset` anchor;
      // the procedural bob would fight both. Its `AnimationMixer` is advanced in
      // `update` instead.
      return;
    }
    node.motion?.(node.animation, nowMs, node.visual);
  }

  function update(nowMs: number): void {
    // One wall-clock delta for every mixer this frame, clamped so a long pause
    // cannot jump a clip forward.
    const mixerDeltaSeconds =
      lastUpdateMs === null
        ? 0
        : Math.max(0, Math.min(nowMs - lastUpdateMs, MAX_FRAME_DELTA_MS)) / 1000;
    lastUpdateMs = nowMs;

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
          playAnimation(node, node.defaultAnimation);
        }
        positionNode(node);
      }
      node.mixer?.update(mixerDeltaSeconds);
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
        hasMixer: node.mixer !== null,
        mixerClip: node.activeAction?.getClip().name ?? null,
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
              // scale, read back off the mesh that lives below the blocks.
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
              extent: sun.shadow.camera.right,
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
      placementGhost:
        placementGhostState === null
          ? null
          : {
              present: ghost.group.visible,
              position: { ...placementGhostState.position },
              rotation: { ...placementGhostState.rotation },
              footprintX: placementGhostState.footprintX,
              footprintZ: placementGhostState.footprintZ,
              height: placementGhostState.height,
              valid: placementGhostState.valid,
              colour: ghostColourFor(placementGhostState.valid),
              occupiedCellCount: placementGhostState.occupiedCells?.length ?? 0,
              pivot: placementGhostState.pivot ?? 'base',
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

  /**
   * Set the rig's yaw. This is deliberately yaw-only: the pitch has its own
   * explicit setter ({@link setCameraPitch}) and is never read from this shape,
   * so a drag can never tilt the view. Yaw is normalised to `[0, 360)`. Rotating
   * the rig never changes world coordinates.
   */
  function setCameraOrientation(orientation: { yawDegrees?: number }): void {
    if (orientation.yawDegrees !== undefined) {
      yawDegrees = normalizeYawDegrees(orientation.yawDegrees);
    }
    applyCameraTransform();
  }

  /**
   * Set the rig's downward pitch (degrees), clamped to the documented range and
   * re-run through the SAME reframe path as yaw/zoom so the orbit distance, the
   * camera transform/height, the backdrop and near/far all follow. A
   * non-finite input is ignored rather than poisoning the projection.
   */
  function setCameraPitch(degrees: number): void {
    if (!Number.isFinite(degrees)) {
      return;
    }
    pitchDegrees = clamp(degrees, RENDER_CAMERA.minPitchDegrees, RENDER_CAMERA.maxPitchDegrees);
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

  /** Pure mapping from the server's verdict to a ghost colour; no client rule. */
  function ghostColourFor(valid: boolean | null): number {
    if (valid === null) {
      return RENDER_GHOST_COLOURS.neutral;
    }
    return valid ? RENDER_GHOST_COLOURS.valid : RENDER_GHOST_COLOURS.invalid;
  }

  /** Position the pooled occupied-cell markers for the server's occupied cells. */
  function syncGhostOccupied(cells: readonly { x: number; y: number; z: number }[]): void {
    while (ghost.occupiedMarkers.length < cells.length) {
      const marker = new Mesh(ghost.geometry, ghost.occupiedMaterial);
      marker.renderOrder = 1001;
      ghost.occupiedGroup.add(marker);
      ghost.occupiedMarkers.push(marker);
    }
    for (const [index, marker] of ghost.occupiedMarkers.entries()) {
      const cell = cells[index];
      if (cell === undefined) {
        marker.visible = false;
        continue;
      }
      marker.visible = true;
      marker.scale.set(grid.cellSize * 0.9, 0.06, grid.cellSize * 0.9);
      marker.position.set(
        grid.origin.x + (cell.x + 0.5) * grid.cellSize,
        grid.origin.y + (cell.y + 0.5) * grid.cellSize,
        grid.origin.z + (cell.z + 0.5) * grid.cellSize,
      );
    }
    ghost.occupiedGroup.visible = cells.length > 0;
  }

  /**
   * Show/update/clear the pending placement ghost. `valid` is copied verbatim
   * from the server verdict and is the ONLY input to the colour: the runtime
   * applies no support/occupancy/permission rule of its own.
   */
  function setPlacementGhost(spec: PlacementGhost | null): void {
    placementGhostState =
      spec === null
        ? null
        : {
            position: { ...spec.position },
            rotation: { ...spec.rotation },
            footprintX: spec.footprintX,
            footprintZ: spec.footprintZ,
            height: spec.height,
            valid: spec.valid,
            pivot: spec.pivot ?? 'base',
            occupiedCells: (spec.occupiedCells ?? []).map((cell) => ({
              x: cell.x,
              y: cell.y,
              z: cell.z,
            })),
          };

    if (spec === null) {
      ghost.group.visible = false;
      ghost.occupiedGroup.visible = false;
      return;
    }

    ghost.group.visible = true;
    ghost.group.position.set(spec.position.x, spec.position.y, spec.position.z);
    ghost.group.quaternion.set(
      spec.rotation.x,
      spec.rotation.y,
      spec.rotation.z,
      spec.rotation.w,
    );
    // Unit box scaled to the footprint/height. `pivot` decides whether the
    // transform is the footprint's geometric centre with the height rising from
    // it (base, the default) or the box's centre (centre, used by a block ghost
    // whose node root is the cell centre).
    const pivot = spec.pivot ?? 'base';
    ghost.box.scale.set(spec.footprintX, spec.height, spec.footprintZ);
    ghost.box.position.set(0, pivot === 'center' ? 0 : spec.height / 2, 0);
    ghost.boxMaterial.color.setHex(ghostColourFor(spec.valid));

    syncGhostOccupied(spec.occupiedCells ?? []);
  }

  // Reused across picks so a drag/click loop does not allocate per query.
  const raycaster = new Raycaster();
  const pickNdc = new Vector2();
  const normalMatrix = new Matrix3();
  const worldNormal = new Vector3();
  // The mathematical ground plane at the world's floor. Blocks are object-layer
  // node visuals and ARE the visible ground, so this plane is only reached where
  // the ray finds no block (an air cell) or outside the block world.
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
    //    `object` layer is pickable. Blocks are object-layer and ARE the pickable
    //    ground, so a click on a block yields a node hit whose `point` the UI
    //    turns into a move intent; the mathematical-plane fallback below only
    //    fires where there is no block under the ray.
    const roots: Object3D[] = [];
    for (const node of nodes.values()) {
      if (node.layer === 'object' && node.root.visible) {
        roots.push(node.root);
      }
    }
    const nodeHits = raycaster.intersectObjects(roots, true);
    if (nodeHits.length > 0) {
      const firstHit = nodeHits[0];
      const hitNodeId = nodeIdForObject(firstHit.object);
      if (hitNodeId !== null) {
        // Transform the face normal into world space so the caller can classify
        // a face without knowing the node's rotation or scale.
        const faceNormal = firstHit.face?.normal;
        let normal = { x: 0, y: 1, z: 0 };
        if (faceNormal !== undefined) {
          normalMatrix.getNormalMatrix(firstHit.object.matrixWorld);
          worldNormal.copy(faceNormal).applyMatrix3(normalMatrix).normalize();
          normal = { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z };
        }
        return {
          kind: 'node',
          nodeId: hitNodeId,
          point: { x: firstHit.point.x, y: firstHit.point.y, z: firstHit.point.z },
          normal,
        };
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

    // The ghost is presentation-only but owns a shared box geometry and two
    // materials; release them rather than only detaching the groups.
    worldRoot.remove(ghost.group);
    worldRoot.remove(ghost.occupiedGroup);
    placementGhostState = null;
    ghost.geometry.dispose();
    released.geometries += 1;
    accumulateRelease(releaseMaterial(ghost.boxMaterial));
    accumulateRelease(releaseMaterial(ghost.occupiedMaterial));
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
    setCameraPitch,
    setZoom,
    setGridOverlayVisible,
    setHighlightedCell,
    setPlacementGhost,
    pick,
    inspect,
    dispose,
  };
}
