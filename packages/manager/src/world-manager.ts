import type {
  ActorId,
  CellCoord,
  EntityId,
  EntityKind,
  EntityState,
  GameCommand,
  GameEvent,
  GameEventBatch,
  GridSpec,
  TerrainKind,
  TileState,
  Transform,
  WorldBounds,
  WorldId,
  WorldSnapshot,
} from '@starvalley/protocol';
import { parseActorId, parseEntityId, parseWorldId } from '@starvalley/protocol';
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
 * becomes a static world-space AABB, so this table (not a per-move cell lookup)
 * is what decides movement legality. The annotation is total over `TerrainKind`,
 * so adding a terrain is a compile error here until its walkability is decided.
 * `water` is unwalkable.
 */
export const WALKABILITY_BY_TERRAIN: Record<TerrainKind, boolean> = {
  grass: true,
  path: true,
  blocked: false,
  water: false,
};

/**
 * The second authoritative collision rule: whether an entity occupying a cell
 * blocks movement. Like terrain walkability, it is a Manager runtime rule and
 * stays off the wire.
 *
 * It is the **prop collider generator**: every blocking entity gets a static
 * world-space AABB from {@link FOOTPRINT_BY_ENTITY_KIND}. `character: false` is
 * deliberate: a single actor cannot block itself, and multi-actor blocking is a
 * later decision. The annotation is total over `EntityKind`, so adding an entity
 * kind is a compile error here until its blocking behaviour is decided.
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

/**
 * Per-kind prop collider footprint, in world units around the entity's world
 * position. Only blocking kinds actually produce a collider, but the table is
 * total over `EntityKind` so adding a kind is a compile error until its
 * footprint is chosen. A tree is a little narrower than a full cell so adjacent
 * trees still read as separate objects.
 */
const FOOTPRINT_BY_ENTITY_KIND: Record<EntityKind, Footprint> = {
  character: { halfX: DEFAULT_ACTOR_RADIUS, halfZ: DEFAULT_ACTOR_RADIUS },
  tree: { halfX: 0.4, halfZ: 0.4 },
};

/** A static world-space axis-aligned box collider (XZ footprint, Y span). */
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
   * the injected `serverTime` stamp. The actor's current movement mode is applied
   * (a direction intent, or straight-line steering toward a moveTo goal),
   * displacement is resolved against static world-space colliders
   * (axis-separated, so the actor slides along walls), and the world `bounds` are
   * part of that same resolution pass: a candidate is projected into the box
   * *before* it is collision-tested, so clamping can never land the actor inside
   * a collider. A moveTo goal is consumed on arrival or when a tick produces no
   * movement at all. A step that moves nothing emits **no** event.
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

/** Does the vertical (XZ) circle at `(cx, cz)` overlap the box `box`? */
function circleIntersectsAabb(cx: number, cz: number, radius: number, box: Aabb): boolean {
  const nearestX = Math.min(Math.max(cx, box.min.x), box.max.x);
  const nearestZ = Math.min(Math.max(cz, box.min.z), box.max.z);
  const dx = cx - nearestX;
  const dz = cz - nearestZ;
  return dx * dx + dz * dz < radius * radius;
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

/**
 * Create an authoritative `WorldManager` over a continuous 3D world.
 *
 * Pure, synchronous, in-memory: no I/O, no transport, no persistence, no
 * physics engine. The grid is derived from the ASCII map (origin explicit,
 * defaulted to a box centred on the world origin) and the world `bounds` are a
 * **separate** AABB. Static colliders are generated once from the grid (one AABB
 * per unwalkable cell) and from blocking props (one AABB per prop, from its
 * world position and per-kind footprint); the `bounds` box is the containment
 * constraint. The actor spawns at the centre cell's world centre, which must be
 * walkable **and** free of blocking props.
 *
 * Every returned DTO (grid, bounds, tiles, entities and their nested transforms,
 * and event payloads) is a defensive copy so callers cannot mutate authority.
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

  // Static colliders, generated once. Cells only GENERATE colliders; movement
  // legality is decided by world-space queries against these AABBs, never by a
  // per-move "is the target cell walkable" lookup.
  const staticColliders: Aabb[] = [];
  const halfCell = cellSize / 2;
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (WALKABILITY_BY_TERRAIN[terrain[z][x]]) {
        continue;
      }
      const centre = cellCentre(grid, { x, z });
      staticColliders.push({
        min: { x: centre.x - halfCell, y: bounds.min.y, z: centre.z - halfCell },
        max: { x: centre.x + halfCell, y: bounds.max.y, z: centre.z + halfCell },
      });
    }
  }
  for (const prop of props) {
    if (!BLOCKING_BY_ENTITY_KIND[prop.kind]) {
      continue;
    }
    const footprint = FOOTPRINT_BY_ENTITY_KIND[prop.kind];
    const { position } = prop.transform;
    staticColliders.push({
      min: { x: position.x - footprint.halfX, y: bounds.min.y, z: position.z - footprint.halfZ },
      max: { x: position.x + footprint.halfX, y: bounds.max.y, z: position.z + footprint.halfZ },
    });
  }

  // The spawn invariant must cover BOTH authoritative collision rules: a custom
  // map may put a blocking prop on the centre cell whose grass terrain is
  // walkable. Spawning inside a collider would strand the actor, so a config
  // that fails either rule is a construction error, never silent degradation.
  const centreCell: CellCoord = { x: Math.floor(width / 2), z: Math.floor(depth / 2) };
  const spawnTerrain = terrain[centreCell.z][centreCell.x];
  if (!WALKABILITY_BY_TERRAIN[spawnTerrain]) {
    throw new RangeError(
      `World map centre (${centreCell.x}, ${centreCell.z}) must be walkable, found '${spawnTerrain}'`,
    );
  }
  const spawnPosition = cellCentre(grid, centreCell);
  const spawnBlocked = staticColliders.some((box) =>
    circleIntersectsAabb(spawnPosition.x, spawnPosition.z, actorRadius, box),
  );
  if (spawnBlocked) {
    throw new RangeError(
      `World map centre (${centreCell.x}, ${centreCell.z}) must not be occupied by a blocking entity`,
    );
  }

  // Single authoritative actor transform. Never handed out directly.
  const transform: Transform = {
    position: { x: spawnPosition.x, y: groundY, z: spawnPosition.z },
    rotation: copyQuat(QUAT_IDENTITY),
  };

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

  const wouldCollide = (x: number, z: number): boolean =>
    staticColliders.some((box) => circleIntersectsAabb(x, z, actorRadius, box));

  const clampToBounds = (position: Vec3): Vec3 => ({
    x: Math.min(Math.max(position.x, bounds.min.x + actorRadius), bounds.max.x - actorRadius),
    y: groundY,
    z: Math.min(Math.max(position.z, bounds.min.z + actorRadius), bounds.max.z - actorRadius),
  });

  /**
   * Resolve a desired XZ position against BOTH authoritative constraints in a
   * single pass: project it into the world box first, then test the projected
   * position against the static colliders. Returning `null` (instead of the
   * projected position) means the projection would overlap a collider, so the
   * caller must keep a previously-valid position. This is what stops a
   * hand-written `bounds` that cuts into an unwalkable cell from clamping the
   * actor into that cell: the clamp is no longer applied to a candidate that was
   * only tested before clamping.
   */
  const resolvePosition = (x: number, z: number): { x: number; z: number } | null => {
    const projected = clampToBounds({ x, y: groundY, z });
    return wouldCollide(projected.x, projected.z) ? null : { x: projected.x, z: projected.z };
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

      // `step(0)` (and any non-positive delta) is a strict no-op; no movement
      // mode at all also moves nothing and emits nothing.
      if (!(dtMs > 0) || mode === null) {
        return { events: [], serverTime };
      }

      const dtSeconds = dtMs / 1000;
      const stepDistance = actorSpeed * dtSeconds;

      const startX = transform.position.x;
      const startZ = transform.position.z;

      // Desired horizontal displacement for this tick.
      let displacementX: number;
      let displacementZ: number;
      // `arrived` is only set by the moveTo snap branch (the arrival rule).
      let arrived = false;

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

      // Base position: the current one, projected into the world box when that
      // projection is itself legal. The actor is always at a legal position, so a
      // fully-blocked step leaves it there (or moves it only by the projection)
      // rather than clamping it into a collider.
      const startProjection = resolvePosition(startX, startZ);
      let nextX = startProjection?.x ?? startX;
      let nextZ = startProjection?.z ?? startZ;

      // Axis-separated resolution: try the full displacement first (so a clear
      // diagonal is not quantised), then fall back to X-only and Z-only so the
      // actor slides along a wall instead of sticking to it. Every candidate is
      // projected into the world box BEFORE the collider test, so the bounds are
      // part of the same resolution pass and a clamp can never land inside a
      // collider. The Z attempt is made from the position reached after the X
      // attempt.
      const full = resolvePosition(startX + displacementX, startZ + displacementZ);
      if (full !== null) {
        nextX = full.x;
        nextZ = full.z;
      } else {
        const xOnly = resolvePosition(startX + displacementX, startZ);
        if (xOnly !== null) {
          nextX = xOnly.x;
          nextZ = xOnly.z;
        }
        const zOnly = resolvePosition(nextX, startZ + displacementZ);
        if (zOnly !== null) {
          nextX = zOnly.x;
          nextZ = zOnly.z;
        }
      }

      // Y is fixed to the ground: no gravity, no jumping, no slopes.
      const deltaX = nextX - startX;
      const deltaZ = nextZ - startZ;
      if (deltaX === 0 && deltaZ === 0) {
        // Fully blocked (or clamped): no state change, no event, no error. A
        // moveTo goal that cannot progress is abandoned rather than staying
        // pending forever; a direction intent persists because the input may
        // still be held.
        if (mode.kind === 'moveTo') {
          movementMode = null;
        }
        return { events: [], serverTime };
      }

      // Authoritative heading: `yaw = atan2(dx, dz)` (`yaw 0` faces `+Z`/south),
      // a rotation about `+Y`, taken from the EFFECTIVE displacement. When the
      // intent is zero the last heading is kept.
      const yaw = Math.atan2(deltaX, deltaZ);

      transform.position = { x: nextX, y: groundY, z: nextZ };
      transform.rotation = quatFromYaw(yaw);

      // Arrived exactly on a moveTo goal: consume the mode.
      if (arrived) {
        movementMode = null;
      }

      return { events: [transformChangedEvent()], serverTime };
    },
  };
}
