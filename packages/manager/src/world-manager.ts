import type {
  ActorId,
  EntityId,
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
 * A fixed ASCII map (deterministic — no procedural generation), reusing the
 * frozen legend:
 *
 * - `g` -> `'grass'`
 * - `p` -> `'path'`  (walkable, visually different)
 * - `#` -> `'blocked'`
 *
 * Mostly grass, with a path strip and a small blocked cluster. The map **defines**
 * the world size (`width = rows[0].length`, `height = rows.length`), so the two
 * can never disagree. The centre tile is walkable so a default actor can spawn.
 */
export const DEFAULT_WORLD_MAP: readonly string[] = [
  'gggggggggg',
  'gpppppppgg',
  'gggggggggg',
  'gg###ggggg',
  'gg#ggggggg',
  'gggggggggg',
  'gggggppggg',
  'gggggggggg',
  'gggggggggg',
  'gggggggggg',
];

const DEFAULT_WORLD_ID: WorldId = parseWorldId('world-1');
const DEFAULT_ACTOR_ID: ActorId = parseActorId('actor-1');
const DEFAULT_ENTITY_ID: EntityId = parseEntityId('entity-1');

/** Map legend character -> static terrain kind. */
const TERRAIN_BY_CHARACTER: ReadonlyMap<string, TerrainKind> = new Map([
  ['g', 'grass'],
  ['p', 'path'],
  ['#', 'blocked'],
]);

/**
 * The collision rule. Whether a terrain kind can be stepped onto is a Manager
 * runtime rule and is deliberately **not** on the wire (Phase-5 decision 2):
 * shipping `walkable` would invite client-side collision rules.
 *
 * The annotation is total over `TerrainKind`, so adding a terrain is a compile
 * error here until its walkability is decided.
 */
export const WALKABILITY_BY_TERRAIN: Record<TerrainKind, boolean> = {
  grass: true,
  path: true,
  blocked: false,
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
   * A command that the world rules refuse (out of bounds **or** an unwalkable
   * target tile) produces no events (an empty array) and leaves authoritative
   * state untouched; it is not an error. Unknown actors throw {@link UnknownActorError}.
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
  /** Identifier of the single world entity. Defaults to `parseEntityId('entity-1')`. */
  entityId?: EntityId;
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

interface ParsedMap {
  size: WorldSize;
  terrain: TerrainKind[][];
}

/**
 * Validate and decode an ASCII map into a row-major terrain grid.
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

  const terrain = rows.map((row, y): TerrainKind[] => {
    if (row.length !== width) {
      throw new RangeError(
        `World map row ${y} has ${row.length} columns, expected ${width}`,
      );
    }

    return Array.from(row, (character, x): TerrainKind => {
      const kind = TERRAIN_BY_CHARACTER.get(character);
      if (kind === undefined) {
        throw new RangeError(
          `Unknown world map character ${JSON.stringify(character)} at (${x}, ${y})`,
        );
      }
      return kind;
    });
  });

  return { size: { width, height: rows.length }, terrain };
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
 * at creation; the single character entity starts on the map's centre tile,
 * which must be walkable. Every returned DTO (including `tiles` and nested
 * `transform` objects, the `entities` array, and event payloads) is a defensive
 * copy so callers cannot mutate authoritative state.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const worldId = deps.worldId ?? DEFAULT_WORLD_ID;
  const { size, terrain } = parseMap(deps.map ?? DEFAULT_WORLD_MAP);

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const entityId = deps.entityId ?? DEFAULT_ENTITY_ID;
  const clock = deps.clock ?? ((): Date => new Date());

  const spawn = centreOf(size);
  const spawnTerrain = terrain[spawn.y][spawn.x];
  if (!WALKABILITY_BY_TERRAIN[spawnTerrain]) {
    throw new RangeError(
      `World map centre (${spawn.x}, ${spawn.y}) must be walkable, found '${spawnTerrain}'`,
    );
  }

  // Single authoritative transform. Never handed out directly.
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

  const entitySnapshot = (): EntityState => ({
    entityId,
    actorId,
    kind: 'character',
    transform: { x: transform.x, y: transform.y },
    visible: true,
  });

  return {
    getSnapshot(input: { actorId: ActorId }): WorldSnapshot {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      return {
        worldId,
        size: { width: size.width, height: size.height },
        tiles: tileSnapshot(),
        entities: [entitySnapshot()],
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

          // Two refusal causes, one spelling: out of bounds (undefined terrain)
          // or a target tile that is not walkable. Both leave state untouched.
          if (targetTerrain === undefined || !WALKABILITY_BY_TERRAIN[targetTerrain]) {
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
