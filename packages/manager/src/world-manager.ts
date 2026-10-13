import type {
  ActorId,
  CellCoord,
  ColliderKind,
  ColliderState,
  EntityId,
  EntityKind,
  EntityState,
  GameCommand,
  GameEvent,
  GameEventBatch,
  GridSpec,
  SurfaceKind,
  SurfaceState,
  TerrainKind,
  TileState,
  Transform,
  WorldBounds,
  WorldId,
  WorldSnapshot,
} from '@starvalley/protocol';
import {
  isColliderState,
  isSurfaceState,
  parseActorId,
  parseColliderId,
  parseEntityId,
  parseSurfaceId,
  parseWorldId,
} from '@starvalley/protocol';
import type { Quat, Vec3 } from '@starvalley/math';
import { QUAT_IDENTITY, clampXZToUnit, quatFromYaw } from '@starvalley/math';

/**
 * Default authoritative world layout for this slice.
 *
 * A fixed ASCII map (deterministic — no procedural generation), using the
 * frozen legend:
 *
 * - `g` -> `'grass'`
 * - `p` -> `'path'`  (walkable, visually different)
 * - `w` -> `'water'` (unwalkable ground kind, distinct from generic `'blocked'`)
 * - `#` -> `'blocked'`
 * - `T` -> a **tree standing on grass**: the cell's terrain is `'grass'` and a
 *   static `'tree'` entity occupies it.
 *
 * ## Convenience authoring only — the grid is NOT the movement truth
 *
 * This map is a **convenience authoring** source consumed ONCE, at construction
 * time, to *emit* the world-geometry layers (`surfaces`/`colliders`). Movement
 * never consults it again: {@link createWorldManager}'s `step` queries
 * `surfaces`/`colliders` ONLY and never derives geometry from the grid or a
 * `tiles` lookup. The grid (`tiles`) remains gameplay metadata (farming,
 * placement, terrain metadata, selection) and holds no position and no level.
 *
 * The map defines the **grid** (`width = rows[0].length`, `depth = rows.length`),
 * not the world bounds: the world is a continuous 3D box (`WorldBounds`) and the
 * grid is a discrete interaction layer inside it. The centre cell is walkable
 * and unoccupied by a blocking prop, so a default actor can spawn there.
 */
export const DEFAULT_WORLD_MAP: readonly string[] = [
  'gggggggggg',
  'gppppppppg',
  'gpggggggpg',
  'gpgwwgggpg',
  'gpgwwgTgpg',
  'gpggggggpg',
  'gppppppppg',
  'ggggTggggg',
  'gg##gggggg',
  'gggggggggg',
];

const DEFAULT_WORLD_ID: WorldId = parseWorldId('world-1');
const DEFAULT_ACTOR_ID: ActorId = parseActorId('actor-1');
const DEFAULT_ENTITY_ID: EntityId = parseEntityId('entity-1');

/** Default grid cell edge length, in world units. */
const DEFAULT_CELL_SIZE = 1;

/** Default vertical extent of the world box (ground `y` to `ground y + 8`). */
const DEFAULT_BOUNDS_HEIGHT = 8;

/** Fixed-step simulation rate. `step(dtMs)` is authoritative; timers live outside. */
export const TICK_RATE_HZ = 20;

/** Default actor speed in world units per second (at movement magnitude 1). */
export const DEFAULT_ACTOR_SPEED = 3;

/** Default actor collision radius (an XZ circle), in world units. */
export const DEFAULT_ACTOR_RADIUS = 0.35;

/**
 * Actor body height in world units, measured up from the feet.
 *
 * Reason: the actor's **vertical extent** must exist for the collider test. A
 * collider only blocks when its `y` range overlaps `[feetY, feetY +
 * DEFAULT_ACTOR_HEIGHT]`. `1.7` is a human-ish body (roughly a person's height
 * in the world's units), which is what makes "a low wall blocks a ground actor
 * but not a deck actor above it" and "an actor passes UNDER a deck slab whose
 * slab is above its head" both true. This is a Manager rule and is deliberately
 * NOT on the wire.
 */
export const DEFAULT_ACTOR_HEIGHT = 1.7;

/**
 * Maximum upward step, in world units, the actor can be lifted in one tick.
 *
 * Reason: the support query accepts a surface only when its plane `y` at the
 * actor's `(x, z)` is at most `feetY + MAX_STEP_UP`. A curb/small stair riser
 * (`0.3`) is climbable; anything taller is a wall or a platform edge the actor
 * must reach another way. It also bounds the per-tick upward snap, which is why
 * the ramp test can assert per-step `y` continuity. Manager rule, not on the
 * wire.
 */
export const MAX_STEP_UP = 0.3;

/**
 * Maximum downward step, in world units, the actor follows while grounded.
 *
 * Reason: symmetric with {@link MAX_STEP_UP}. A drop at most this deep snaps the
 * actor onto the lower surface (walking down a step, or the next segment of a
 * ramp); a deeper drop starts a fall instead. Manager rule, not on the wire.
 */
export const MAX_STEP_DOWN = 0.3;

/**
 * Maximum walkable slope, in degrees from horizontal.
 *
 * Reason: `45°` is a conventional walkability limit — steeper faces are walls or
 * cliffs, not traversable ground. It is compared against the surface normal via
 * its cosine (see {@link MAX_WALKABLE_SLOPE_COS}); the contract deliberately
 * carries no slope limit (`cross(axisU, axisV).y > 0` is geometric only), so
 * this rule lives here. Manager rule, not on the wire.
 */
export const MAX_WALKABLE_SLOPE_DEGREES = 45;

/** Cosine of {@link MAX_WALKABLE_SLOPE_DEGREES}; compared against `normal.y`. */
const MAX_WALKABLE_SLOPE_COS = Math.cos((MAX_WALKABLE_SLOPE_DEGREES * Math.PI) / 180);

/**
 * Floating-point slack on the slope comparison, so a patch authored at exactly
 * the limit (`45°`) is not rejected by a rounding error in the normal.
 */
const SLOPE_EPSILON = 1e-6;

/**
 * Gravitational acceleration for falls, in world units per second squared.
 *
 * Reason: a game-feel value (about 2g) rather than a realistic `9.81`, so a fall
 * settles in a few ticks at the 20 Hz tick rate instead of floating. Used only
 * while airborne (`v += GRAVITY * dt` then `feetY -= v * dt`); grounded motion
 * is a support snap and does not integrate. Manager rule, not on the wire.
 */
export const GRAVITY = 20;

/**
 * Landing snap tolerance, in world units.
 *
 * Reason: a fall integrates in discrete ticks and can overshoot the support
 * plane within one tick. When the integrated foot position is within this
 * tolerance of (or below) the support, the actor is placed EXACTLY on the
 * support (never partially sunk, never hovering). Manager rule, not on the wire.
 */
export const LANDING_SNAP_TOLERANCE = 0.05;

/*
 * World-floor fallback when no walkable surface exists under the actor: "no
 * support at all" must still terminate — the actor keeps falling to
 * `bounds.min.y` and treats it as ground. This is not on the wire; it is just
 * the world box's lower face.
 */

/**
 * Trunk collider height, in world units, for a blocking tree prop.
 *
 * Reason: a tree blocks at trunk height, NOT ground-to-sky. A real `y` range is
 * what lets a future deck pass above it.
 */
export const TREE_TRUNK_HEIGHT = 2.5;

/**
 * Blocked-terrain collider height, in world units.
 *
 * Reason: `'blocked'` is modelled as a low impassable wall/rock, taller than
 * {@link MAX_STEP_UP} (so it cannot be climbed) but finite (so a surface above
 * it can pass over). No ground-to-sky columns.
 */
export const BLOCKED_COLLIDER_HEIGHT = 1;

/**
 * Water collider height, in world units, measured up from the ground.
 *
 * Reason: water is a shallow ground-level blocker with a real top, so a bridge
 * deck above it is possible. It is below the actor's body top so a ground actor
 * is blocked by it.
 */
export const WATER_COLLIDER_HEIGHT = 0.3;

/** Raised demo platform height above the ground plane, in world units. */
export const DEMO_PLATFORM_HEIGHT = 2;

/**
 * Inclination of the demo ramp, in degrees from horizontal.
 *
 * Reason: deliberately well below {@link MAX_WALKABLE_SLOPE_DEGREES} (`30°` vs
 * `45°`) so the demo ramp is walkable by a comfortable margin rather than
 * sitting exactly on the traversal limit, where an epsilon adjustment or a
 * floating-point difference could silently make the demo unwalkable. The demo
 * every acceptance run exercises must not be a knife-edge case.
 */
export const DEMO_RAMP_ANGLE_DEGREES = 30;

/** Half XZ footprint of a tree prop's collider, in world units. */
const TREE_FOOTPRINT_HALF = 0.4;

/**
 * Interaction reach, in world units, measured on the ground plane (XZ).
 *
 * A target farther than this from the actor in XZ is rejected with
 * `InteractionRejectedError` reason `'out-of-range'`. Height is deliberately
 * ignored: interaction is a ground-plane reach, so an entity directly overhead
 * is still "in range".
 */
export const INTERACTION_RANGE = 1.5;

/** Map legend character -> static terrain kind (the tree character is handled separately). */
const TERRAIN_BY_CHARACTER: ReadonlyMap<string, TerrainKind> = new Map([
  ['g', 'grass'],
  ['p', 'path'],
  ['w', 'water'],
  ['#', 'blocked'],
]);

/** Legend character for a tree: grass terrain plus a static `'tree'` entity. */
const TREE_CHARACTER = 'T';

/** Terrain a tree stands on (`'T'` is an object on walkable ground, not a ground kind). */
const TREE_TERRAIN: TerrainKind = 'grass';

/**
 * The terrain collision rule. Whether a terrain kind can be stepped onto is a
 * Manager runtime rule and is deliberately **not** on the wire (Phase-5
 * decision 2): shipping `walkable` would invite client-side collision rules.
 *
 * It is also the **collider generator**: every cell whose terrain is unwalkable
 * becomes a static world-space AABB with a REAL `y` range, so this table (not a
 * per-move cell lookup) is what decides movement legality. The annotation is
 * total over `TerrainKind`, so adding a terrain is a compile error here until
 * its walkability is decided. `water` is unwalkable.
 */
export const WALKABILITY_BY_TERRAIN: Record<TerrainKind, boolean> = {
  grass: true,
  path: true,
  blocked: false,
  water: false,
};

/**
 * Per-unwalkable-terrain collider height above the ground plane. It is the
 * second half of the collider generator (the first is
 * {@link WALKABILITY_BY_TERRAIN}); keeping it a total record means a new
 * terrain cannot silently become a ground-to-sky column. Only unwalkable kinds
 * are read today.
 */
const COLLIDER_HEIGHT_BY_TERRAIN: Record<TerrainKind, number> = {
  grass: 0,
  path: 0,
  blocked: BLOCKED_COLLIDER_HEIGHT,
  water: WATER_COLLIDER_HEIGHT,
};

/**
 * Gameplay collider vocabulary per unwalkable terrain. It is a separate axis
 * from the geometry primitive (`shape.kind`), so this mapping is explicit and
 * total; only unwalkable entries are read today.
 */
const COLLIDER_KIND_BY_TERRAIN: Record<TerrainKind, ColliderKind> = {
  grass: 'structure',
  path: 'structure',
  blocked: 'rock',
  water: 'water',
};

/**
 * The second authoritative collision rule: whether an entity occupying a cell
 * blocks movement. Like terrain walkability, it is a Manager runtime rule and
 * stays off the wire.
 *
 * It is the **prop collider generator**: every blocking entity gets a static
 * world-space AABB with a real `y` range from {@link FOOTPRINT_BY_ENTITY_KIND}
 * and the per-kind height. `character: false` is deliberate: a single actor
 * cannot block itself, and multi-actor blocking is a later decision. The
 * annotation is total over `EntityKind`, so adding an entity kind is a compile
 * error here until its blocking behaviour is decided.
 */
export const BLOCKING_BY_ENTITY_KIND: Record<EntityKind, boolean> = {
  character: false,
  tree: true,
};

/**
 * Placeholder interaction rules: whether the actor can interact with an entity
 * kind. Revisit when real interactions land (farming, NPC dialogue, containers,
 * ...); making a kind interactable flips its entry here.
 *
 * `tree: true` and `character: false` are deliberately chosen so BOTH the accept
 * path (a tree) and the not-interactable reject path (the actor's own character
 * entity) are real and testable. The annotation is total over `EntityKind`, so
 * adding a kind is a compile error here until its interactability is decided.
 */
export const INTERACTABLE_BY_ENTITY_KIND: Record<EntityKind, boolean> = {
  character: false,
  tree: true,
};

/** Half-extents (XZ) of an entity kind's static collider footprint. */
interface Footprint {
  readonly halfX: number;
  readonly halfZ: number;
}

/** Per-entity-kind collider height, in world units, above the ground plane. */
interface ColliderHeight {
  readonly y: number;
}

/**
 * Per-kind prop collider footprint, in world units around the entity's world
 * position. Only blocking kinds actually produce a collider, but the table is
 * total over `EntityKind` so adding a kind is a compile error until its
 * footprint is chosen. A tree is a little narrower than a full cell so adjacent
 * trees still read as separate objects.
 */
const FOOTPRINT_BY_ENTITY_KIND: Record<EntityKind, Footprint> = {
  character: { halfX: DEFAULT_ACTOR_RADIUS, halfZ: DEFAULT_ACTOR_RADIUS },
  tree: { halfX: TREE_FOOTPRINT_HALF, halfZ: TREE_FOOTPRINT_HALF },
};

/**
 * Per-kind prop collider height above the ground plane. `character` is never a
 * collider ({@link BLOCKING_BY_ENTITY_KIND}); the entry exists to keep the
 * record total.
 */
const COLLIDER_HEIGHT_BY_ENTITY_KIND: Record<EntityKind, ColliderHeight> = {
  character: { y: DEFAULT_ACTOR_HEIGHT },
  tree: { y: TREE_TRUNK_HEIGHT },
};

/**
 * Gameplay collider vocabulary per blocking entity kind. `character` is never a
 * collider; the entry keeps the record total.
 */
const COLLIDER_KIND_BY_ENTITY_KIND: Record<EntityKind, ColliderKind> = {
  character: 'structure',
  tree: 'structure',
};

/** A static world-space axis-aligned box, in world units. */
interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Thrown when an operation names an actor the manager does not know about.
 *
 * Transport maps this to `NOT_FOUND`; the manager itself stays transport-free.
 */
export class UnknownActorError extends Error {
  readonly actorId: ActorId;

  constructor(actorId: ActorId) {
    super(`Unknown actor: ${actorId}`);
    this.name = 'UnknownActorError';
    this.actorId = actorId;
  }
}

/**
 * Thrown when an operation names an entity the manager does not know about.
 *
 * Transport maps this to `NOT_FOUND`; the manager itself stays transport-free.
 */
export class UnknownEntityError extends Error {
  readonly entityId: EntityId;

  constructor(entityId: EntityId) {
    super(`Unknown entity: ${entityId}`);
    this.name = 'UnknownEntityError';
    this.entityId = entityId;
  }
}

/** Why an interaction was refused even though the request itself was valid. */
export type InteractionRejectionReason = 'out-of-range' | 'not-interactable';

/**
 * Thrown when an interaction request is well-formed and names a real entity but
 * is illegal against the CURRENT world state: the target is out of reach or is
 * not interactable for its kind.
 *
 * Transport maps this to `CONFLICT` (409). That is the whole point of the code:
 * it distinguishes a refused-but-valid intent from an accepted command that
 * produced no change (an empty event batch). The discriminated `reason` lets the
 * client render a precise message.
 */
export class InteractionRejectedError extends Error {
  readonly entityId: EntityId;
  readonly reason: InteractionRejectionReason;

  constructor(entityId: EntityId, reason: InteractionRejectionReason) {
    super(`Interaction with ${entityId} rejected: ${reason}`);
    this.name = 'InteractionRejectedError';
    this.entityId = entityId;
    this.reason = reason;
  }
}

/**
 * The actor's current movement mode: exactly one at a time, or `null` (stopped).
 *
 * - `direction`: a held, level-triggered direction intent (`actor.moveIntent`).
 * - `moveTo`: a world-space steering goal (`actor.moveTo`).
 *
 * A new movement command REPLACES the mode, so the latest input wins: a WASD
 * intent interrupts a click-to-move and vice versa. A `{ x: 0, z: 0 }`
 * direction clears the mode (stop).
 */
type MovementMode =
  | { readonly kind: 'direction'; readonly movement: { readonly x: number; readonly z: number } }
  | { readonly kind: 'moveTo'; readonly target: Vec3 };

/**
 * Read-only, transport-neutral access to the authoritative continuous world.
 *
 * Identity is supplied as typed input on every operation; there is no implicit
 * "current actor", and a command deliberately carries no actor field (identity
 * comes from the transport context, never the client payload).
 */
export interface WorldManager {
  /** Point-in-time authoritative world view for `input.actorId`. Always a fresh object graph. */
  getSnapshot(input: { actorId: ActorId }): WorldSnapshot;
  /**
   * Apply `input.command` to the actor's current intent/state.
   *
   * The actor is taken from `input.actorId`, never from the command. Movement
   * commands (`actor.moveIntent`, `actor.moveTo`) set the actor's single
   * movement mode and persist across {@link step} ticks until replaced; a zero
   * direction means "stop". Changing a movement intent is not itself world
   * state, so those batches are intentionally empty. `actor.interact` is
   * resolved immediately: it stops and faces the target and returns one
   * `transform.changed`, or throws a typed error (`UnknownEntityError`,
   * `InteractionRejectedError`). Unknown actors throw {@link UnknownActorError}.
   */
  submitIntent(input: { actorId: ActorId; command: GameCommand }): GameEventBatch;
  /**
   * Advance the authoritative simulation by `dtMs` and return the world delta.
   *
   * Pure and deterministic for a given `dtMs`: no timers, no wall clock beyond
   * the injected `serverTime` stamp. Horizontal motion keeps the existing
   * intent/steering resolution (a direction intent, or straight-line steering
   * toward a moveTo goal) and the per-axis sliding resolution against static
   * world-space colliders. A collider blocks ONLY when its `y` range overlaps
   * the actor's CURRENT body span `[feetY, feetY + DEFAULT_ACTOR_HEIGHT]`, so an
   * actor walks under a deck whose slab is above its head while a low wall still
   * blocks a ground actor.
   *
   * Vertical motion is the support query plus gravity: the highest traversable
   * walkable surface under `(x, z)` within `MAX_STEP_UP` of the feet is the
   * support; within `MAX_STEP_DOWN` the feet snap to it (continuous `y` along a
   * ramp), a deeper drop falls under {@link GRAVITY}, landing within
   * {@link LANDING_SNAP_TOLERANCE} of the support. `position.y` is authoritative.
   * When no surface exists under the actor it keeps falling to `bounds.min.y`
   * (the world floor, treated as ground) — never `NaN`, never hovering.
   *
   * The world `bounds` are projected in the same horizontal resolution pass, so
   * a candidate is clamped into the box *before* it is collision-tested and
   * clamping can never land the actor inside a collider. A moveTo goal is
   * consumed on arrival or when a tick produces no movement at all. A step that
   * moves nothing emits **no** event.
   */
  step(dtMs: number): GameEventBatch;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  /** Identifier of the world this manager serves. Defaults to `parseWorldId('world-1')`. */
  worldId?: WorldId;
  /** ASCII layout. Defaults to {@link DEFAULT_WORLD_MAP}. Defines the grid's width/depth. */
  map?: readonly string[];
  /** Grid overrides: an explicit `origin` (never implicitly the world origin) and/or `cellSize`. */
  grid?: Partial<Pick<GridSpec, 'origin' | 'cellSize'>>;
  /** The world box. Defaults to a box comfortably containing the grid, `y` spanning 0..8. */
  bounds?: WorldBounds;
  /** Identifier of the single known actor. Defaults to `parseActorId('actor-1')`. */
  actorId?: ActorId;
  /** Identifier of the single controlled actor entity. Defaults to `parseEntityId('entity-1')`. */
  entityId?: EntityId;
  /** Actor speed in world units per second. Defaults to {@link DEFAULT_ACTOR_SPEED}. */
  actorSpeed?: number;
  /** Actor XZ collision radius. Defaults to {@link DEFAULT_ACTOR_RADIUS}. */
  actorRadius?: number;
  /**
   * Extra static support surfaces APPENDED to the map-derived ones. This is a
   * Manager authoring/test seam (world geometry lives in the Manager); it is NOT
   * a wire field and no Protocol shape changes. Each entry is validated with the
   * Protocol surface guard.
   */
  surfaces?: readonly SurfaceState[];
  /**
   * Extra static blocking volumes APPENDED to the map-derived ones. Same
   * Manager-owned authoring/test seam as {@link surfaces}; validated with the
   * Protocol collider guard.
   */
  colliders?: readonly ColliderState[];
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

/**
 * The frozen cell-centre rule, shared by both sides of the wire:
 *
 * ```text
 * cellCentre.x = origin.x + (cell.x + 0.5) * cellSize
 * cellCentre.z = origin.z + (cell.z + 0.5) * cellSize
 * cellCentre.y = origin.y
 * ```
 *
 * `cell(0, 0)`'s centre is therefore `origin + 0.5 * cellSize` — **never** the
 * world origin, because the grid's `origin` is deliberately decoupled from it.
 */
export function cellCentre(grid: GridSpec, cell: CellCoord): Vec3 {
  return {
    x: grid.origin.x + (cell.x + 0.5) * grid.cellSize,
    y: grid.origin.y,
    z: grid.origin.z + (cell.z + 0.5) * grid.cellSize,
  };
}

/**
 * The inverse of {@link cellCentre}: the grid cell that contains a continuous
 * world position. This is the WORLD rule used for farming/placement/interaction
 * lookups later; it must **never** be used as the Actor's stored position.
 */
export function cellOf(grid: GridSpec, position: Vec3): CellCoord {
  return {
    x: Math.floor((position.x - grid.origin.x) / grid.cellSize),
    z: Math.floor((position.z - grid.origin.z) / grid.cellSize),
  };
}

function isFiniteVec3(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function copyVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function copyQuat(value: Quat): Quat {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function copyTransform(value: Transform): Transform {
  return { position: copyVec3(value.position), rotation: copyQuat(value.rotation) };
}

function copySurface(value: SurfaceState): SurfaceState {
  return {
    surfaceId: value.surfaceId,
    kind: value.kind,
    center: copyVec3(value.center),
    axisU: copyVec3(value.axisU),
    axisV: copyVec3(value.axisV),
    walkable: value.walkable,
  };
}

function copyCollider(value: ColliderState): ColliderState {
  const shape = value.shape;
  return {
    colliderId: value.colliderId,
    kind: value.kind,
    shape: { kind: 'aabb', min: copyVec3(shape.min), max: copyVec3(shape.max) },
  };
}

/**
 * Ground-plane (XZ) distance between two world positions; `y` is ignored.
 *
 * Interaction reach is measured on the ground plane, so a target at the same
 * XZ but a very different height is still in range.
 */
export function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function copyEntity(entity: EntityState): EntityState {
  return {
    entityId: entity.entityId,
    actorId: entity.actorId,
    kind: entity.kind,
    transform: copyTransform(entity.transform),
    visible: entity.visible,
  };
}

/** The `y` component of `cross(axisU, axisV)`. */
function crossY(axisU: Vec3, axisV: Vec3): number {
  return axisU.z * axisV.x - axisU.x * axisV.z;
}

/** The `y` component of the unit plane normal of a surface patch. */
function surfaceNormalY(surface: SurfaceState): number {
  const { axisU, axisV } = surface;
  const normalX = axisU.y * axisV.z - axisU.z * axisV.y;
  const normalY = crossY(axisU, axisV);
  const normalZ = axisU.x * axisV.y - axisU.y * axisV.x;
  const length = Math.hypot(normalX, normalY, normalZ);
  return length === 0 ? 0 : normalY / length;
}

/**
 * Is this surface patch traversable? `walkable` first, then the Manager's own
 * slope limit. `walkable === false` is an explicit "real geometry, do not
 * traverse" flag and is never used as support, even when up-facing.
 */
export function isSurfaceTraversable(surface: SurfaceState): boolean {
  if (!surface.walkable) {
    return false;
  }
  return surfaceNormalY(surface) + SLOPE_EPSILON >= MAX_WALKABLE_SLOPE_COS;
}

/**
 * The plane `y` of `surface` at world `(x, z)`, or `null` when `(x, z)` is
 * outside the patch. The patch is
 * `{ center + u*axisU + v*axisV : -1 <= u,v <= 1 }`, so `(x, z)` is solved for
 * `(u, v)` and then `y = center.y + u*axisU.y + v*axisV.y` is returned.
 */
export function surfacePlaneY(surface: SurfaceState, x: number, z: number): number | null {
  const dx = x - surface.center.x;
  const dz = z - surface.center.z;
  const { axisU, axisV } = surface;
  const det = axisU.x * axisV.z - axisV.x * axisU.z;
  if (det === 0) {
    return null;
  }
  const u = (dx * axisV.z - axisV.x * dz) / det;
  const v = (axisU.x * dz - dx * axisU.z) / det;
  if (u < -1 || u > 1 || v < -1 || v > 1) {
    return null;
  }
  return surface.center.y + u * axisU.y + v * axisV.y;
}

/**
 * The authoritative support query: the HIGHEST traversable (`walkable === true`
 * and within the slope limit) surface whose patch contains `(x, z)` and whose
 * plane `y` there is at most `feetY + MAX_STEP_UP`. Returns `null` when no such
 * surface exists (the actor is over a hole / outside all geometry).
 *
 * Filtering `walkable` first is deliberate: a `walkable: false` up-facing slope
 * is real geometry but never standable.
 */
export function findSupportY(
  surfaces: readonly SurfaceState[],
  x: number,
  z: number,
  feetY: number,
): number | null {
  let best: number | null = null;
  for (const surface of surfaces) {
    if (!isSurfaceTraversable(surface)) {
      continue;
    }
    const y = surfacePlaneY(surface, x, z);
    if (y === null || y > feetY + MAX_STEP_UP) {
      continue;
    }
    if (best === null || y > best) {
      best = y;
    }
  }
  return best;
}

/** The AABB of a collider (today the only `ColliderShape` variant). */
function aabbOf(collider: ColliderState): Aabb {
  const shape = collider.shape;
  switch (shape.kind) {
    case 'aabb':
      return { min: shape.min, max: shape.max };
    default: {
      const exhaustive: never = shape.kind;
      throw new Error(`Unhandled collider shape: ${String(exhaustive)}`);
    }
  }
}

/**
 * Does a collider's `y` range overlap the actor body span
 * `[feetY, feetY + DEFAULT_ACTOR_HEIGHT]`?
 *
 * This is the vertical half of the collision test. Touching (a collider top
 * exactly at the feet, or a slab bottom exactly at the body top) does NOT count
 * as overlap, which is what makes standing on a deck above a wall legal and
 * walking under a slab legal.
 */
export function actorBodyOverlapsCollider(feetY: number, collider: ColliderState): boolean {
  const { min, max } = aabbOf(collider);
  const bodyMin = feetY;
  const bodyMax = feetY + DEFAULT_ACTOR_HEIGHT;
  return min.y < bodyMax && max.y > bodyMin;
}

/** Does the vertical (XZ) circle at `(cx, cz)` overlap the box `box`? */
function circleIntersectsAabb(cx: number, cz: number, radius: number, box: Aabb): boolean {
  const nearestX = Math.min(Math.max(cx, box.min.x), box.max.x);
  const nearestZ = Math.min(Math.max(cz, box.min.z), box.max.z);
  const dx = cx - nearestX;
  const dz = cz - nearestZ;
  return dx * dx + dz * dz < radius * radius;
}

/**
 * Relative dot-product tolerance for the render-bridge's rectangle assumption.
 *
 * The bridge maps a `SurfaceState` to a single standard 3D transform, which is
 * exact only for a RECTANGLE (`axisU` perpendicular to `axisV`). A general
 * non-perpendicular parallelogram would need a shear the standard transform
 * cannot express and would be silently mis-rendered, so a non-perpendicular
 * authored patch is rejected at the seam. The tolerance is RELATIVE to the
 * axis lengths: the Manager's own patches (`flatSurface`, the demo ramp) are
 * perpendicular to machine precision and pass with room to spare, while any
 * visible skew is rejected.
 */
const PERPENDICULAR_DOT_TOLERANCE = 1e-9;

/** Is the patch a rectangle, i.e. `axisU` perpendicular to `axisV`? */
function isPerpendicularPatch(surface: SurfaceState): boolean {
  const { axisU, axisV } = surface;
  const dot = axisU.x * axisV.x + axisU.y * axisV.y + axisU.z * axisV.z;
  const scale = Math.hypot(axisU.x, axisU.y, axisU.z) * Math.hypot(axisV.x, axisV.y, axisV.z);
  return scale > 0 && Math.abs(dot) <= PERPENDICULAR_DOT_TOLERANCE * scale;
}

/** Project `(x, z)` into the world box, keeping the actor circle fully inside. */
function clampXZToBounds(
  x: number,
  z: number,
  radius: number,
  bounds: WorldBounds,
): { x: number; z: number } {
  return {
    x: Math.min(Math.max(x, bounds.min.x + radius), bounds.max.x - radius),
    z: Math.min(Math.max(z, bounds.min.z + radius), bounds.max.z - radius),
  };
}

/**
 * Extra clearance, in world units, added to the depenetration push distance.
 *
 * {@link pushCircleOutOfAabb} places the circle centre so its SURFACE sits
 * `radius` from the box, but {@link circleIntersectsAabb} then re-tests that
 * position with a STRICT `<`. Recomputing the distance re-subtracts two nearly
 * equal large coordinates (`(box.max.x + radius) - box.max.x`), and the
 * rounding can leave the result a few ULPs SHORT of `radius`. The re-test then
 * still reports an intersection, the relaxation loop pushes to the same place,
 * exhausts its passes and returns `null` — a false "wedged" verdict that only
 * appeared in the directions whose rounding happened to land inward (e.g. the
 * `+X` and `-Z` faces); the opposite faces round outward and passed by luck.
 *
 * Pushing to `radius + DEPENETRATION_EPSILON` keeps the recomputed distance
 * strictly greater than `radius` in EVERY direction, so the escape is robust at
 * the floating-point boundary instead of direction-dependent. The margin is far
 * larger than the observed ~1e-16 rounding error at the game's coordinate
 * magnitudes and far smaller than any gameplay-relevant distance (about 3e-9 of
 * the actor radius), so it cannot punch the circle through a real collider.
 */
const DEPENETRATION_EPSILON = 1e-9;

/**
 * Push an XZ circle out of one AABB to the nearest position whose SURFACE is
 * `radius + DEPENETRATION_EPSILON` from the box. The centre-outside case pushes
 * away from the nearest point (face/corner); the centre-inside case escapes
 * through the nearest face. This is the primitive behind
 * {@link resolveColliderPenetration}.
 */
function pushCircleOutOfAabb(
  cx: number,
  cz: number,
  radius: number,
  box: Aabb,
): { x: number; z: number } {
  const clearance = radius + DEPENETRATION_EPSILON;
  const nearestX = Math.min(Math.max(cx, box.min.x), box.max.x);
  const nearestZ = Math.min(Math.max(cz, box.min.z), box.max.z);
  const dx = cx - nearestX;
  const dz = cz - nearestZ;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq > 1e-18) {
    // Outside the box (or on a face/corner): push straight away from the
    // nearest point on the box.
    const distance = Math.sqrt(distanceSq);
    if (distance >= clearance) {
      return { x: cx, z: cz };
    }
    const scale = clearance / distance;
    return { x: nearestX + dx * scale, z: nearestZ + dz * scale };
  }
  // Centre inside (or exactly on) the box: escape through the nearest face.
  const toMinX = cx - box.min.x;
  const toMaxX = box.max.x - cx;
  const toMinZ = cz - box.min.z;
  const toMaxZ = box.max.z - cz;
  const nearest = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
  if (nearest === toMinX) return { x: box.min.x - clearance, z: cz };
  if (nearest === toMaxX) return { x: box.max.x + clearance, z: cz };
  if (nearest === toMinZ) return { x: cx, z: box.min.z - clearance };
  return { x: cx, z: box.max.z + clearance };
}

/** Input for {@link resolveColliderPenetration}. */
export interface PenetrationResolutionInput {
  /** Desired (possibly penetrating) XZ position. */
  readonly x: number;
  readonly z: number;
  /** Feet height used for the collider `y`-overlap test. */
  readonly feetY: number;
  /** Actor XZ collision radius. */
  readonly radius: number;
  /** World box the actor must stay inside. */
  readonly bounds: WorldBounds;
  /** Static colliders to resolve against (order is the deterministic tie-break). */
  readonly colliders: readonly ColliderState[];
}

/**
 * Depenetrate an XZ circle from every collider whose real `y` range overlaps
 * the actor body at `feetY`, returning the nearest non-colliding, in-bounds XZ
 * position, or `null` when a pathological pocket has no escape.
 *
 * This is the horizontal half of the LANDING rule. The vertical support/gravity
 * pass never tests colliders, so it can drop the feet INTO a shallow collider
 * volume — a bridge deck edge over water is the designed case (the docs
 * advertise exactly that scene). There the ordinary per-move resolution cannot
 * help: every candidate within the footprint overlaps, and the per-tick step
 * (`0.15`) is smaller than the escape margin (the radius, `0.35`), so no
 * direction resolves and the actor is permanently wedged. Pushing it to the
 * nearest collider boundary restores the invariant that the actor is never
 * inside a collider, so the next tick moves normally.
 *
 * Resolution is a bounded relaxation in collider order (deterministic): each
 * pass pushes out of the first blocking collider, so overlapping/adjacent
 * volumes settle in at most one pass per collider plus the initial projection.
 */
export function resolveColliderPenetration(
  input: PenetrationResolutionInput,
): { x: number; z: number } | null {
  const { feetY, radius, bounds, colliders } = input;
  let { x, z } = clampXZToBounds(input.x, input.z, radius, bounds);

  const maxPasses = colliders.length + 1;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const blocker = colliders.find(
      (collider) =>
        actorBodyOverlapsCollider(feetY, collider) &&
        circleIntersectsAabb(x, z, radius, aabbOf(collider)),
    );
    if (blocker === undefined) {
      return { x, z };
    }
    const pushed = pushCircleOutOfAabb(x, z, radius, aabbOf(blocker));
    const clamped = clampXZToBounds(pushed.x, pushed.z, radius, bounds);
    x = clamped.x;
    z = clamped.z;
  }

  const stillBlocked = colliders.some(
    (collider) =>
      actorBodyOverlapsCollider(feetY, collider) &&
      circleIntersectsAabb(x, z, radius, aabbOf(collider)),
  );
  return stillBlocked ? null : { x, z };
}

interface ParsedMap {
  width: number;
  depth: number;
  terrain: TerrainKind[][];
  treeCells: CellCoord[];
}

/**
 * Validate and decode an ASCII map into a row-major terrain grid plus the
 * row-major cells of its `T` (tree) markers.
 *
 * An empty map, a row of length zero, a ragged map, or any character outside the
 * legend is a configuration error: those are caller mistakes, not runtime
 * gameplay outcomes, so they throw `RangeError` at construction time.
 */
function parseMap(rows: readonly string[]): ParsedMap {
  if (rows.length === 0) {
    throw new RangeError('World map must contain at least one row');
  }

  const width = rows[0].length;
  if (width === 0) {
    throw new RangeError('World map rows must not be empty');
  }

  const terrain: TerrainKind[][] = [];
  const treeCells: CellCoord[] = [];

  rows.forEach((row, z): void => {
    if (row.length !== width) {
      throw new RangeError(`World map row ${z} has ${row.length} columns, expected ${width}`);
    }

    const terrainRow: TerrainKind[] = [];
    Array.from(row).forEach((character, x): void => {
      if (character === TREE_CHARACTER) {
        terrainRow.push(TREE_TERRAIN);
        treeCells.push({ x, z });
        return;
      }

      const kind = TERRAIN_BY_CHARACTER.get(character);
      if (kind === undefined) {
        throw new RangeError(
          `Unknown world map character ${JSON.stringify(character)} at (${x}, ${z})`,
        );
      }
      terrainRow.push(kind);
    });
    terrain.push(terrainRow);
  });

  return { width, depth: rows.length, terrain, treeCells };
}

/** Author a flat, up-facing `ground`-style patch from XZ extents. */
function flatSurface(input: {
  surfaceId: string;
  kind: SurfaceKind;
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  y: number;
  walkable: boolean;
}): SurfaceState {
  return {
    surfaceId: parseSurfaceId(input.surfaceId),
    kind: input.kind,
    center: { x: input.centerX, y: input.y, z: input.centerZ },
    // Winding: axisU = +X, axisV = -Z gives cross(U, V).y = +X * +... > 0.
    // The natural-looking axisV = +Z is REJECTED by the Protocol guard.
    axisU: { x: input.halfX, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: -input.halfZ },
    walkable: input.walkable,
  };
}

/**
 * Create an authoritative `WorldManager` over a continuous 3D world.
 *
 * Pure, synchronous, in-memory: no I/O, no transport, no persistence, no
 * physics engine. The grid is derived from the ASCII map and the world `bounds`
 * are a **separate** AABB. The world geometry is **emitted once at construction**
 * from the map (one walkable ground surface per walkable cell, one real-`y`
 * collider per unwalkable cell and per blocking prop) plus an authored 3D demo
 * (a raised platform reached by a 30° ramp). At runtime `step` queries
 * `surfaces`/`colliders` only — never the grid.
 *
 * The actor spawns at the centre cell's world centre, which must be walkable
 * **and** free of blocking props at the spawn body height.
 *
 * Every returned DTO (grid, bounds, tiles, surfaces, colliders, entities and
 * their nested transforms, and event payloads) is a defensive copy so callers
 * cannot mutate authority.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const worldId = deps.worldId ?? DEFAULT_WORLD_ID;
  const { width, depth, terrain, treeCells } = parseMap(deps.map ?? DEFAULT_WORLD_MAP);

  const cellSize = deps.grid?.cellSize ?? DEFAULT_CELL_SIZE;
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new RangeError(`Grid cellSize must be a positive finite number, received ${cellSize}`);
  }

  // The grid origin is EXPLICIT and deliberately not bound to the world origin:
  // the default centres the grid on `(0, 0, 0)`, so cell (0, 0)'s centre sits at
  // `origin + 0.5 * cellSize`, never at the origin itself.
  const origin: Vec3 = deps.grid?.origin ?? {
    x: -(width * cellSize) / 2,
    y: 0,
    z: -(depth * cellSize) / 2,
  };
  if (!isFiniteVec3(origin)) {
    throw new RangeError('Grid origin must be a finite Vec3');
  }

  const grid: GridSpec = { origin, width, depth, cellSize };

  // The world box is a separate concept from the grid. The default comfortably
  // contains the grid in XZ (one cell of margin) and spans a plausible height.
  const groundY = origin.y;
  const yMin = Math.min(groundY, 0);
  const bounds: WorldBounds = deps.bounds ?? {
    min: { x: origin.x - cellSize, y: yMin, z: origin.z - cellSize },
    max: {
      x: origin.x + width * cellSize + cellSize,
      y: yMin + DEFAULT_BOUNDS_HEIGHT,
      z: origin.z + depth * cellSize + cellSize,
    },
  };
  if (!isFiniteVec3(bounds.min) || !isFiniteVec3(bounds.max)) {
    throw new RangeError('World bounds must be finite Vec3 corners');
  }
  if (!(bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y && bounds.min.z < bounds.max.z)) {
    throw new RangeError('World bounds must satisfy min < max on every axis');
  }

  const actorSpeed = deps.actorSpeed ?? DEFAULT_ACTOR_SPEED;
  if (!Number.isFinite(actorSpeed) || actorSpeed <= 0) {
    throw new RangeError(`Actor speed must be a positive finite number, received ${actorSpeed}`);
  }

  const actorRadius = deps.actorRadius ?? DEFAULT_ACTOR_RADIUS;
  if (!Number.isFinite(actorRadius) || actorRadius <= 0) {
    throw new RangeError(`Actor radius must be a positive finite number, received ${actorRadius}`);
  }

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const entityId = deps.entityId ?? DEFAULT_ENTITY_ID;
  const clock = deps.clock ?? ((): Date => new Date());

  // Static props decoded from the map. Tree ids are deterministic and assigned
  // in row-major order — the first `T` is `tree-1`, the second `tree-2`, ... —
  // and always built through `parseEntityId`, never a cast. Props are immutable
  // for this slice; snapshot reads copy them.
  const props: readonly EntityState[] = treeCells.map(
    (cell, index): EntityState => ({
      entityId: parseEntityId(`tree-${index + 1}`),
      actorId: null,
      kind: 'tree',
      transform: { position: cellCentre(grid, cell), rotation: copyQuat(QUAT_IDENTITY) },
      visible: true,
    }),
  );

  // ---------------------------------------------------------------------------
  // WORLD GEOMETRY (movement truth) — emitted once, queried by `step`.
  // ---------------------------------------------------------------------------
  const surfaces: SurfaceState[] = [];
  const colliders: ColliderState[] = [];
  const halfCell = cellSize / 2;

  // One flat, walkable ground surface per walkable cell. Winding is
  // axisU = +X, axisV = -Z so cross(axisU, axisV).y > 0 (the Protocol guard).
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!WALKABILITY_BY_TERRAIN[terrain[z][x]]) {
        continue;
      }
      const centre = cellCentre(grid, { x, z });
      surfaces.push(
        flatSurface({
          surfaceId: `surface-ground-${x}-${z}`,
          kind: 'ground',
          centerX: centre.x,
          centerZ: centre.z,
          halfX: halfCell,
          halfZ: halfCell,
          y: groundY,
          walkable: true,
        }),
      );
    }
  }

  // One real-`y` collider per unwalkable cell (water/blocked). The `y` range is
  // finite and starts at the ground plane, NOT at `bounds.min.y`/`bounds.max.y`
  // — the old ground-to-sky column is gone, so a deck above can pass over.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const kind = terrain[z][x];
      if (WALKABILITY_BY_TERRAIN[kind]) {
        continue;
      }
      const centre = cellCentre(grid, { x, z });
      colliders.push({
        colliderId: parseColliderId(`collider-${kind}-${x}-${z}`),
        kind: COLLIDER_KIND_BY_TERRAIN[kind],
        shape: {
          kind: 'aabb',
          min: { x: centre.x - halfCell, y: groundY, z: centre.z - halfCell },
          max: {
            x: centre.x + halfCell,
            y: groundY + COLLIDER_HEIGHT_BY_TERRAIN[kind],
            z: centre.z + halfCell,
          },
        },
      });
    }
  }

  // One real-`y` collider per blocking prop (tree trunks). Trunk height, not
  // ground-to-sky; the footprint is narrower than a cell.
  for (const prop of props) {
    if (!BLOCKING_BY_ENTITY_KIND[prop.kind]) {
      continue;
    }
    const footprint = FOOTPRINT_BY_ENTITY_KIND[prop.kind];
    const { position } = prop.transform;
    colliders.push({
      colliderId: parseColliderId(`collider-${prop.entityId}`),
      kind: COLLIDER_KIND_BY_ENTITY_KIND[prop.kind],
      shape: {
        kind: 'aabb',
        min: {
          x: position.x - footprint.halfX,
          y: groundY,
          z: position.z - footprint.halfZ,
        },
        max: {
          x: position.x + footprint.halfX,
          y: groundY + COLLIDER_HEIGHT_BY_ENTITY_KIND[prop.kind].y,
          z: position.z + footprint.halfZ,
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // DEMO AREA (author 3D): a raised platform + a 30-degree ramp that reaches it.
  //
  // Anchored to grid CELLS (x = 7..9, z = 0 platform; ramp running south from
  // the platform's south edge), so it only exists when the map is large enough
  // and a custom small map is untouched. For the default 10x10 map the platform
  // top sits at y = 2 over x in [2, 5], z in [-5, -4], with the ramp extending
  // south to z ~= -0.54 — clear of the spawn cell (5, 5), every water cell
  // (x 3..4, z 3..4) and both tree cells.
  //
  // The ramp run is derived from DEMO_PLATFORM_HEIGHT and
  // DEMO_RAMP_ANGLE_DEGREES (never cellSize), so its slope is exactly 30 degrees
  // — comfortably inside MAX_WALKABLE_SLOPE_DEGREES (45), not merely at it —
  // and stays walkable regardless of cellSize.
  // ---------------------------------------------------------------------------
  const DEMO_MIN_CELL_X = 7;
  const DEMO_MAX_CELL_X_EXCLUSIVE = 10;
  const DEMO_PLATFORM_CELL_Z = 0;
  const DEMO_MIN_DEPTH = 3;
  const demoRampRun =
    DEMO_PLATFORM_HEIGHT / Math.tan((DEMO_RAMP_ANGLE_DEGREES * Math.PI) / 180);
  const hasDemoArea = width >= DEMO_MAX_CELL_X_EXCLUSIVE && depth >= DEMO_MIN_DEPTH;
  if (hasDemoArea) {
    const demoMinX = grid.origin.x + DEMO_MIN_CELL_X * cellSize;
    const demoMaxX = grid.origin.x + DEMO_MAX_CELL_X_EXCLUSIVE * cellSize;
    const demoHalfX = (demoMaxX - demoMinX) / 2;
    const platformNorthZ = grid.origin.z + DEMO_PLATFORM_CELL_Z * cellSize;
    const platformSouthZ = platformNorthZ + cellSize;
    const platformTopY = groundY + DEMO_PLATFORM_HEIGHT;
    const demoCenterX = (demoMinX + demoMaxX) / 2;

    surfaces.push(
      flatSurface({
        surfaceId: 'surface-platform',
        kind: 'platform',
        centerX: demoCenterX,
        centerZ: (platformNorthZ + platformSouthZ) / 2,
        halfX: demoHalfX,
        halfZ: cellSize / 2,
        y: platformTopY,
        walkable: true,
      }),
    );

    const rampSouthZ = platformSouthZ + demoRampRun;
    surfaces.push({
      surfaceId: parseSurfaceId('surface-ramp'),
      kind: 'ramp',
      center: {
        x: demoCenterX,
        y: groundY + DEMO_PLATFORM_HEIGHT / 2,
        z: (platformSouthZ + rampSouthZ) / 2,
      },
      axisU: { x: demoHalfX, y: 0, z: 0 },
      // axisV points north AND up: center + axisV is the high (platform) end.
      axisV: { x: 0, y: DEMO_PLATFORM_HEIGHT / 2, z: -demoRampRun / 2 },
      walkable: true,
    });
  }

  // Append optional Manager-owned overrides (test/authoring seam). Validated and
  // defensively copied so authority cannot be mutated through the caller's array.
  for (const extra of deps.surfaces ?? []) {
    if (!isSurfaceState(extra)) {
      throw new RangeError('Invalid surface override');
    }
    // The render bridge maps a surface to ONE standard 3D transform, which is
    // exact only for a rectangle. Make the invalid (non-perpendicular) patch
    // unrepresentable at the seam rather than let it be silently mis-rendered.
    if (!isPerpendicularPatch(extra)) {
      throw new RangeError(
        `Surface override ${extra.surfaceId} must be a rectangle (axisU perpendicular to axisV)`,
      );
    }
    surfaces.push(copySurface(extra));
  }
  for (const extra of deps.colliders ?? []) {
    if (!isColliderState(extra)) {
      throw new RangeError('Invalid collider override');
    }
    colliders.push(copyCollider(extra));
  }

  // Deterministic emission order: sorted by id in every snapshot path.
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  surfaces.sort((a, b) => byId(a.surfaceId, b.surfaceId));
  colliders.sort((a, b) => byId(a.colliderId, b.colliderId));

  // ---------------------------------------------------------------------------
  // Spawn + actor state.
  // ---------------------------------------------------------------------------
  // The spawn invariant must cover BOTH authoritative collision rules: a custom
  // map may put a blocking prop on the centre cell whose grass terrain is
  // walkable. Spawning inside a collider (at body height) would strand the actor,
  // so a config that fails either rule is a construction error, never silent
  // degradation.
  const centreCell: CellCoord = { x: Math.floor(width / 2), z: Math.floor(depth / 2) };
  const spawnTerrain = terrain[centreCell.z][centreCell.x];
  if (!WALKABILITY_BY_TERRAIN[spawnTerrain]) {
    throw new RangeError(
      `World map centre (${centreCell.x}, ${centreCell.z}) must be walkable, found '${spawnTerrain}'`,
    );
  }
  const spawnPosition = cellCentre(grid, centreCell);
  const spawnFeetY = groundY;
  const spawnBlocked = colliders.some(
    (collider) =>
      actorBodyOverlapsCollider(spawnFeetY, collider) &&
      circleIntersectsAabb(spawnPosition.x, spawnPosition.z, actorRadius, aabbOf(collider)),
  );
  if (spawnBlocked) {
    throw new RangeError(
      `World map centre (${centreCell.x}, ${centreCell.z}) must not be occupied by a blocking entity`,
    );
  }

  // Single authoritative actor transform. Never handed out directly.
  // `position.y` is REAL state, resolved by support/gravity in `step`.
  const transform: Transform = {
    position: { x: spawnPosition.x, y: spawnFeetY, z: spawnPosition.z },
    rotation: copyQuat(QUAT_IDENTITY),
  };

  // Downward speed while airborne, in world units per second. Zero while
  // grounded. Kept private to the Manager; not part of the wire contract.
  let verticalVelocity = 0;

  // The actor has exactly ONE movement mode at a time: a held direction or a
  // steering goal. A new movement command REPLACES it (the latest input wins),
  // so WASD interrupts a click-to-move and vice versa; `null` means stopped.
  let movementMode: MovementMode | null = null;

  /** Find an entity by id, including the controlled actor's own entity. */
  const findEntity = (id: EntityId): EntityState | undefined => {
    if (id === entityId) {
      return {
        entityId,
        actorId,
        kind: 'character',
        transform: copyTransform(transform),
        visible: true,
      };
    }
    return props.find((prop) => prop.entityId === id);
  };

  /** The one event a moved/rotated actor emits, built from current authority. */
  const transformChangedEvent = (): GameEvent => ({
    type: 'transform.changed',
    entityId,
    transform: {
      position: copyVec3(transform.position),
      rotation: copyQuat(transform.rotation),
    },
  });

  /** Would the actor body at `(x, z, feetY)` overlap any collider? */
  const wouldCollide = (x: number, z: number, feetY: number): boolean =>
    colliders.some(
      (collider) =>
        actorBodyOverlapsCollider(feetY, collider) &&
        circleIntersectsAabb(x, z, actorRadius, aabbOf(collider)),
    );

  /** Project `(x, z)` into the world box (XZ only; `y` is resolved separately). */
  const clampXZ = (x: number, z: number): { x: number; z: number } =>
    clampXZToBounds(x, z, actorRadius, bounds);

  /**
   * Resolve a desired XZ position against BOTH authoritative constraints in a
   * single pass: project it into the world box first, then test the projected
   * position against the static colliders at the actor's CURRENT body height.
   * Returning `null` (instead of the projected position) means the projection
   * would overlap a collider, so the caller must keep a previously-valid
   * position. This is what stops a hand-written `bounds` that cuts into an
   * unwalkable cell from clamping the actor into that cell.
   */
  const resolvePosition = (
    x: number,
    z: number,
    feetY: number,
  ): { x: number; z: number } | null => {
    const projected = clampXZ(x, z);
    return wouldCollide(projected.x, projected.z, feetY) ? null : projected;
  };

  const tileSnapshot = (): TileState[] => {
    const tiles: TileState[] = [];
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        tiles.push({ cell: { x, z }, terrain: terrain[z][x] });
      }
    }
    return tiles;
  };

  // The controlled actor entity always comes first, then props in row-major
  // order. Built fresh (with fresh nested transforms) on every read.
  const entitiesSnapshot = (): EntityState[] => [
    {
      entityId,
      actorId,
      kind: 'character',
      transform: copyTransform(transform),
      visible: true,
    },
    ...props.map(copyEntity),
  ];

  /**
   * Authoritative interaction: validate the target, then stop and face it.
   *
   * Placeholder effect: today the whole observable result is the heading change
   * plus halting movement, carried by `transform.changed`. Real interactions
   * (harvesting, dialogue, containers) build on this accepted path. A refusal is
   * a typed error, never a negative event.
   */
  const performInteract = (targetEntityId: EntityId, serverTime: string): GameEventBatch => {
    const target = findEntity(targetEntityId);
    if (target === undefined) {
      throw new UnknownEntityError(targetEntityId);
    }
    if (!INTERACTABLE_BY_ENTITY_KIND[target.kind]) {
      throw new InteractionRejectedError(targetEntityId, 'not-interactable');
    }
    // Range is measured on the ground plane (XZ): height is ignored.
    if (distanceXZ(transform.position, target.transform.position) > INTERACTION_RANGE) {
      throw new InteractionRejectedError(targetEntityId, 'out-of-range');
    }

    // Accepted: stop and turn to face the target, using the SAME heading
    // convention as movement (`yaw = atan2(dx, dz)`).
    movementMode = null;
    const deltaX = target.transform.position.x - transform.position.x;
    const deltaZ = target.transform.position.z - transform.position.z;
    transform.rotation = quatFromYaw(Math.atan2(deltaX, deltaZ));

    return { events: [transformChangedEvent()], serverTime };
  };

  return {
    getSnapshot(input: { actorId: ActorId }): WorldSnapshot {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      return {
        worldId,
        bounds: { min: copyVec3(bounds.min), max: copyVec3(bounds.max) },
        grid: { origin: copyVec3(grid.origin), width, depth, cellSize },
        tiles: tileSnapshot(),
        surfaces: surfaces.map(copySurface),
        colliders: colliders.map(copyCollider),
        entities: entitiesSnapshot(),
        controlledActorId: actorId,
        serverTime: clock().toISOString(),
      };
    },

    submitIntent(input: { actorId: ActorId; command: GameCommand }): GameEventBatch {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      const serverTime = clock().toISOString();

      // Exhaustive dispatch on the command discriminant so adding a command
      // primitive is a compile error here until it is handled.
      switch (input.command.type) {
        case 'actor.moveIntent': {
          // The command carries no actor: identity came from the typed input.
          // Clamp defensively; the wire guard already rejects |v| > 1, but the
          // Manager is authoritative and does not trust the client.
          const movement = clampXZToUnit({
            x: input.command.movement.x,
            y: 0,
            z: input.command.movement.z,
          });
          // Replaces any pending mode; `{ x: 0, z: 0 }` means stop.
          movementMode =
            movement.x === 0 && movement.z === 0
              ? null
              : { kind: 'direction', movement: { x: movement.x, z: movement.z } };
          return { events: [], serverTime };
        }
        case 'actor.moveTo': {
          // A steering goal REPLACES the current movement mode (a click
          // interrupts WASD and vice versa). The target is copied so the caller
          // cannot mutate authority through the command object.
          movementMode = { kind: 'moveTo', target: copyVec3(input.command.target) };
          return { events: [], serverTime };
        }
        case 'actor.interact': {
          return performInteract(input.command.targetEntityId, serverTime);
        }
        default: {
          const exhaustive: never = input.command;
          throw new Error(`Unhandled game command: ${String(exhaustive)}`);
        }
      }
    },

    step(dtMs: number): GameEventBatch {
      const serverTime = clock().toISOString();
      const mode = movementMode;

      // `step(0)` (and any non-positive delta) is a strict no-op.
      if (!(dtMs > 0)) {
        return { events: [], serverTime };
      }

      const dtSeconds = dtMs / 1000;
      const stepDistance = actorSpeed * dtSeconds;

      const startX = transform.position.x;
      const startY = transform.position.y;
      const startZ = transform.position.z;

      // Desired horizontal displacement for this tick. With no mode the actor
      // is stationary horizontally, but gravity may still be moving it down.
      let displacementX = 0;
      let displacementZ = 0;
      // `arrived` is only set by the moveTo snap branch (the arrival rule).
      let arrived = false;

      if (mode !== null) {
        if (mode.kind === 'direction') {
          // Exactly the phase-7 behaviour: magnitude scales speed; level-triggered.
          displacementX = mode.movement.x * stepDistance;
          displacementZ = mode.movement.z * stepDistance;
        } else {
          const deltaX = mode.target.x - startX;
          const deltaZ = mode.target.z - startZ;
          const distance = Math.hypot(deltaX, deltaZ);
          if (distance <= stepDistance) {
            // Arrival radius: `|target - position| <= speed * dt`. Move EXACTLY
            // onto the target (snap) so arrival is exact and the actor does not
            // oscillate around the goal.
            displacementX = deltaX;
            displacementZ = deltaZ;
            arrived = true;
          } else {
            // Straight-line steering: no pathfinding, so the actor walks toward
            // the goal and stops against an obstacle rather than routing around it.
            displacementX = (deltaX / distance) * stepDistance;
            displacementZ = (deltaZ / distance) * stepDistance;
          }
        }
      }

      // Base position: the current one, projected into the world box when that
      // projection is itself legal. The actor is always at a legal position, so a
      // fully-blocked step leaves it there (or moves it only by the projection)
      // rather than clamping it into a collider. Collision uses the CURRENT body
      // span: a collider whose `y` range is clear of the actor's head/torso does
      // not block it.
      const startProjection = resolvePosition(startX, startZ, startY);
      let nextX = startProjection?.x ?? startX;
      let nextZ = startProjection?.z ?? startZ;

      if (displacementX !== 0 || displacementZ !== 0) {
        // Axis-separated resolution: try the full displacement first (so a clear
        // diagonal is not quantised), then fall back to X-only and Z-only so the
        // actor slides along a wall instead of sticking to it. Every candidate is
        // projected into the world box BEFORE the collider test, so the bounds
        // are part of the same resolution pass and a clamp can never land inside
        // a collider. The Z attempt is made from the position reached after the X
        // attempt.
        const full = resolvePosition(startX + displacementX, startZ + displacementZ, startY);
        if (full !== null) {
          nextX = full.x;
          nextZ = full.z;
        } else {
          const xOnly = resolvePosition(startX + displacementX, startZ, startY);
          if (xOnly !== null) {
            nextX = xOnly.x;
            nextZ = xOnly.z;
          }
          const zOnly = resolvePosition(nextX, startZ + displacementZ, startY);
          if (zOnly !== null) {
            nextX = zOnly.x;
            nextZ = zOnly.z;
          }
        }
      }

      // Vertical support / gravity. The support is the highest traversable
      // walkable surface under `(x, z)` reachable within MAX_STEP_UP; with none,
      // the world floor `bounds.min.y` is treated as ground. `drop` is positive
      // when the support is below the feet.
      const supportY = findSupportY(surfaces, nextX, nextZ, startY);
      const targetY = supportY ?? bounds.min.y;
      const drop = startY - targetY;

      let nextY: number;
      let nextVerticalVelocity: number;
      if (drop <= MAX_STEP_DOWN) {
        // Within the step-down tolerance (including a step UP, negative drop):
        // follow the surface exactly. This is what makes `y` continuous along a
        // ramp or a flight of steps.
        nextY = targetY;
        nextVerticalVelocity = 0;
      } else {
        // A drop deeper than MAX_STEP_DOWN is a fall: integrate gravity, then
        // land exactly on the support when the tick reaches/crosses it within the
        // snap tolerance. Never hovers, never overshoots below the support.
        nextVerticalVelocity = verticalVelocity + GRAVITY * dtSeconds;
        const candidateY = startY - nextVerticalVelocity * dtSeconds;
        if (candidateY <= targetY + LANDING_SNAP_TOLERANCE) {
          nextY = targetY;
          nextVerticalVelocity = 0;
        } else {
          nextY = candidateY;
        }
      }

      if (wouldCollide(nextX, nextZ, nextY)) {
        // The vertical pass never tests colliders, so a fall can land the feet
        // INSIDE a shallow collider volume (a bridge deck edge over water is
        // the designed case). Depenetrate horizontally so the actor is never
        // left inside a collider, where every per-tick candidate within the
        // footprint would overlap and the step is smaller than the actor
        // radius, so no direction could resolve. If no escape exists, refuse
        // the vertical move and keep the previously-valid horizontal position
        // (which was tested at `startY`), so the actor stays above the volume
        // and can still move away on the next tick.
        const escaped = resolveColliderPenetration({
          x: nextX,
          z: nextZ,
          feetY: nextY,
          radius: actorRadius,
          bounds,
          colliders,
        });
        if (escaped !== null) {
          nextX = escaped.x;
          nextZ = escaped.z;
        } else {
          nextY = startY;
          nextVerticalVelocity = verticalVelocity;
        }
      }

      const deltaX = nextX - startX;
      const deltaY = nextY - startY;
      const deltaZ = nextZ - startZ;

      if (deltaX === 0 && deltaY === 0 && deltaZ === 0) {
        // Fully blocked / at rest / clamped: no state change, no event, no error.
        // A moveTo goal that cannot progress is abandoned rather than staying
        // pending forever; a direction intent persists because the input may
        // still be held.
        if (mode !== null && mode.kind === 'moveTo') {
          movementMode = null;
        }
        return { events: [], serverTime };
      }

      // Authoritative heading: `yaw = atan2(dx, dz)` (`yaw 0` faces `+Z`/south),
      // a rotation about `+Y`, taken from the EFFECTIVE horizontal displacement.
      // A pure vertical fall/land keeps the last heading.
      if (deltaX !== 0 || deltaZ !== 0) {
        transform.rotation = quatFromYaw(Math.atan2(deltaX, deltaZ));
      }
      transform.position = { x: nextX, y: nextY, z: nextZ };
      verticalVelocity = nextVerticalVelocity;

      // Arrived exactly on a moveTo goal: consume the mode.
      if (arrived) {
        movementMode = null;
      }

      return { events: [transformChangedEvent()], serverTime };
    },
  };
}
