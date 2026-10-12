import type {
  ActorId,
  EntityId,
  EntityKind,
  EntityState,
  GameCommand,
  MoveDirection,
  SubmitCommandResponse,
  TerrainKind,
  TileState,
  Transform,
  WorldId,
  WorldSize,
  WorldSnapshot,
} from '@starvalley/protocol';
import { parseActorId, parseEntityId, parseWorldId } from '@starvalley/protocol';

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
 * The map **defines** the world size (`width = rows[0].length`,
 * `height = rows.length`), so the two can never disagree. The centre tile is
 * walkable and unoccupied by a blocking entity, so a default actor can spawn there.
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
 * The annotation is total over `TerrainKind`, so adding a terrain is a compile
 * error here until its walkability is decided. `water` is unwalkable.
 */
export const WALKABILITY_BY_TERRAIN: Record<TerrainKind, boolean> = {
  grass: true,
  path: true,
  blocked: false,
  water: false,
};

/**
 * The second authoritative collision rule: whether an entity occupying a tile
 * blocks movement into that tile. Like terrain walkability, it is a Manager
 * runtime rule and stays off the wire.
 *
 * `character: false` is deliberate: a single actor cannot block itself, and
 * multi-actor blocking is a later decision. The annotation is total over
 * `EntityKind`, so adding an entity kind is a compile error here until its
 * blocking behaviour is decided.
 */
export const BLOCKING_BY_ENTITY_KIND: Record<EntityKind, boolean> = {
  character: false,
  tree: true,
};

/**
 * Cardinal direction deltas. Origin is top-left: `north` decreases `y`, `east`
 * increases `x`. Frozen alongside the Protocol `MoveDirection` contract.
 */
const DIRECTION_DELTAS: Record<MoveDirection, Transform> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

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
 * Result of {@link WorldManager.submitCommand}.
 *
 * Aliased directly to the Protocol `SubmitCommandResponse` so the manager result
 * and the wire contract cannot drift apart. `events` is the authoritative delta
 * produced by the command; a **refused** command yields an empty array — that
 * emptiness *is* the refusal; there is no `moved`/`ok` boolean anywhere in the
 * contract. `serverTime` stamps the call.
 */
export type SubmitCommandResult = SubmitCommandResponse;

/**
 * Read-only, transport-neutral access to the authoritative world state.
 *
 * Every operation is scoped to an actor supplied as typed input; there is no
 * implicit "current actor", and identity is never read from the command (a
 * command has no actor field).
 */
export interface WorldManager {
  /** Point-in-time authoritative world view for `input.actorId`. Always a fresh object graph. */
  getSnapshot(input: { actorId: ActorId }): WorldSnapshot;
  /**
   * Apply `input.command` on behalf of `input.actorId` and return the resulting
   * authoritative events.
   *
   * A command that the world rules refuse (out of bounds, an unwalkable target
   * tile, **or** a blocking entity on the target tile) produces no events (an
   * empty array) and leaves authoritative state untouched; it is not an error.
   * Unknown actors throw {@link UnknownActorError}.
   */
  submitCommand(input: { actorId: ActorId; command: GameCommand }): SubmitCommandResult;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  /** Identifier of the world this manager serves. Defaults to `parseWorldId('world-1')`. */
  worldId?: WorldId;
  /** ASCII layout. Defaults to {@link DEFAULT_WORLD_MAP}. Defines the world size. */
  map?: readonly string[];
  /** Identifier of the single known actor. Defaults to `parseActorId('actor-1')`. */
  actorId?: ActorId;
  /** Identifier of the single controlled actor entity. Defaults to `parseEntityId('entity-1')`. */
  entityId?: EntityId;
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

interface ParsedMap {
  size: WorldSize;
  terrain: TerrainKind[][];
  treePositions: Transform[];
}

/**
 * Validate and decode an ASCII map into a row-major terrain grid plus the
 * row-major positions of its `T` (tree) cells.
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
  const treePositions: Transform[] = [];

  rows.forEach((row, y): void => {
    if (row.length !== width) {
      throw new RangeError(
        `World map row ${y} has ${row.length} columns, expected ${width}`,
      );
    }

    const terrainRow: TerrainKind[] = [];
    Array.from(row).forEach((character, x): void => {
      if (character === TREE_CHARACTER) {
        terrainRow.push(TREE_TERRAIN);
        treePositions.push({ x, y });
        return;
      }

      const kind = TERRAIN_BY_CHARACTER.get(character);
      if (kind === undefined) {
        throw new RangeError(
          `Unknown world map character ${JSON.stringify(character)} at (${x}, ${y})`,
        );
      }
      terrainRow.push(kind);
    });
    terrain.push(terrainRow);
  });

  return { size: { width, height: rows.length }, terrain, treePositions };
}

/** Centre tile of `size`, matching the phase-4 spawn convention. */
function centreOf(size: WorldSize): Transform {
  return { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) };
}

/**
 * Create an authoritative `WorldManager`.
 *
 * Pure, synchronous, in-memory: no I/O, no transport, no persistence. The map
 * (which defines the size), world/actor/entity identity, and clock are captured
 * at creation; the controlled character entity starts on the map's centre tile,
 * which must be walkable **and** unoccupied by a blocking entity.
 *
 * `entities` is a real collection: the controlled actor entity plus one static
 * entity per `T` cell, delivered whole in every snapshot (props are part of the
 * initial world, so no `entity.spawned` event is emitted). Every returned DTO
 * (including `tiles`, `entities` and each nested `transform`, and event
 * payloads) is a defensive copy so callers cannot mutate authoritative state.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const worldId = deps.worldId ?? DEFAULT_WORLD_ID;
  const { size, terrain, treePositions } = parseMap(deps.map ?? DEFAULT_WORLD_MAP);

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const entityId = deps.entityId ?? DEFAULT_ENTITY_ID;
  const clock = deps.clock ?? ((): Date => new Date());

  const spawn = centreOf(size);

  // Static props decoded from the map. Tree ids are deterministic and assigned
  // in row-major order — the first `T` is `tree-1`, the second `tree-2`, ... —
  // and always built through `parseEntityId`, never a cast. Props are immutable
  // for this slice; snapshot reads copy them.
  const props: readonly EntityState[] = treePositions.map(
    (position, index): EntityState => ({
      entityId: parseEntityId(`tree-${index + 1}`),
      actorId: null,
      kind: 'tree',
      transform: { x: position.x, y: position.y },
      visible: true,
    }),
  );

  // The spawn invariant must cover BOTH authoritative collision rules, not just
  // terrain walkability: a custom map may put a `T` on the centre, whose grass
  // terrain is walkable but which is occupied by a blocking tree. Spawning there
  // would strand the actor inside a tile it can never legally re-enter, so a
  // configuration that fails either rule is a construction error, never silent
  // degradation. The failure message names the coordinate and the broken rule.
  const spawnTerrain = terrain[spawn.y][spawn.x];
  if (!WALKABILITY_BY_TERRAIN[spawnTerrain]) {
    throw new RangeError(
      `World map centre (${spawn.x}, ${spawn.y}) must be walkable, found '${spawnTerrain}'`,
    );
  }
  const spawnBlocker = props.find(
    (entity) =>
      BLOCKING_BY_ENTITY_KIND[entity.kind] &&
      entity.transform.x === spawn.x &&
      entity.transform.y === spawn.y,
  );
  if (spawnBlocker !== undefined) {
    throw new RangeError(
      `World map centre (${spawn.x}, ${spawn.y}) must not be occupied by a blocking '${spawnBlocker.kind}' entity`,
    );
  }

  // Single authoritative actor transform. Never handed out directly.
  const transform: Transform = { x: spawn.x, y: spawn.y };

  const terrainAt = (x: number, y: number): TerrainKind | undefined => {
    if (x < 0 || x >= size.width || y < 0 || y >= size.height) {
      return undefined;
    }
    return terrain[y][x];
  };

  const tileSnapshot = (): TileState[] => {
    const tiles: TileState[] = [];
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        tiles.push({ transform: { x, y }, terrain: terrain[y][x] });
      }
    }
    return tiles;
  };

  const copyEntity = (entity: EntityState): EntityState => ({
    entityId: entity.entityId,
    actorId: entity.actorId,
    kind: entity.kind,
    transform: { x: entity.transform.x, y: entity.transform.y },
    visible: entity.visible,
  });

  // The controlled actor entity always comes first, then props in row-major
  // order. Built fresh (with fresh nested transforms) on every read.
  const entitiesSnapshot = (): EntityState[] => [
    {
      entityId,
      actorId,
      kind: 'character',
      transform: { x: transform.x, y: transform.y },
      visible: true,
    },
    ...props.map(copyEntity),
  ];

  // Second authoritative rule: a move is refused when any blocking entity
  // occupies the target tile. The actor is `character` (non-blocking), so only
  // props can block; reading the same composed collection keeps the rule
  // consistent with what a snapshot reports.
  const hasBlockingEntityAt = (x: number, y: number): boolean =>
    entitiesSnapshot().some(
      (entity) =>
        BLOCKING_BY_ENTITY_KIND[entity.kind] &&
        entity.transform.x === x &&
        entity.transform.y === y,
    );

  return {
    getSnapshot(input: { actorId: ActorId }): WorldSnapshot {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      return {
        worldId,
        size: { width: size.width, height: size.height },
        tiles: tileSnapshot(),
        entities: entitiesSnapshot(),
        controlledActorId: actorId,
        serverTime: clock().toISOString(),
      };
    },

    submitCommand(input: { actorId: ActorId; command: GameCommand }): SubmitCommandResult {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      const serverTime = clock().toISOString();
      const command = input.command;

      // Exhaustive dispatch on the command discriminant. `command.type` (rather
      // than the object) is narrowed to `never` when every `GameCommand` member
      // has a case, so adding a command primitive is a compile error here until
      // it is handled.
      switch (command.type) {
        case 'actor.move': {
          const delta = DIRECTION_DELTAS[command.direction];
          const targetX = transform.x + delta.x;
          const targetY = transform.y + delta.y;
          const targetTerrain = terrainAt(targetX, targetY);

          // Three refusal causes, one spelling: out of bounds (undefined
          // terrain), an unwalkable target terrain, or a blocking entity on the
          // target tile. All leave the authoritative transform untouched.
          if (
            targetTerrain === undefined ||
            !WALKABILITY_BY_TERRAIN[targetTerrain] ||
            hasBlockingEntityAt(targetX, targetY)
          ) {
            return { events: [], serverTime };
          }

          transform.x = targetX;
          transform.y = targetY;

          return {
            events: [
              {
                type: 'transform.changed',
                entityId,
                transform: { x: targetX, y: targetY },
              },
            ],
            serverTime,
          };
        }
        default: {
          const exhaustive: never = command.type;
          throw new Error(`Unhandled game command: ${String(exhaustive)}`);
        }
      }
    },
  };
}
