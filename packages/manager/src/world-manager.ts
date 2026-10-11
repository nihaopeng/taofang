import type {
  MoveDirection,
  MovePlayerCommand,
  MovePlayerResult,
  Player,
  PlayerId,
  Position,
  WorldSize,
  WorldSnapshot,
} from '@starvalley/protocol';

/**
 * Default authoritative world dimensions for this slice.
 *
 * Frozen by the Phase-2 contract; a world with these dimensions has its centre
 * at `{ x: 6, y: 4 }`.
 */
export const DEFAULT_WORLD_SIZE: WorldSize = { width: 12, height: 8 };

const DEFAULT_PLAYER_ID: PlayerId = 'player-1';
const DEFAULT_PLAYER_NAME = 'Player';

/**
 * Cardinal direction deltas. Origin is top-left: `north` decreases `y`, `east`
 * increases `x`. Frozen alongside the Protocol `MoveDirection` contract.
 */
const DIRECTION_DELTAS: Record<MoveDirection, Position> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/**
 * Thrown when a move targets a player the manager does not know about.
 *
 * Transport maps this to `NOT_FOUND`; the manager itself stays transport-free.
 */
export class UnknownPlayerError extends Error {
  readonly playerId: PlayerId;

  constructor(playerId: PlayerId) {
    super(`Unknown player: ${playerId}`);
    this.name = 'UnknownPlayerError';
    this.playerId = playerId;
  }
}

/** Read-only, transport-neutral access to the authoritative world state. */
export interface WorldManager {
  /** Point-in-time authoritative world + player view. Always a fresh object. */
  getSnapshot(): WorldSnapshot;
  /**
   * Attempt to step the player one tile in `command.direction`.
   *
   * A step that would leave the world is refused (`moved: false`) with the
   * unchanged position; it is not an error. Unknown players throw.
   */
  movePlayer(command: MovePlayerCommand): MovePlayerResult;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  /** World dimensions. Defaults to {@link DEFAULT_WORLD_SIZE}. */
  worldSize?: WorldSize;
  /** Identifier of the single local player. Defaults to `'player-1'`. */
  playerId?: PlayerId;
  /** Display name of the single local player. Defaults to `'Player'`. */
  playerName?: string;
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`worldSize.${field} must be a positive integer, received ${value}`);
  }
}

/**
 * Create an authoritative `WorldManager`.
 *
 * Pure, synchronous, in-memory: no I/O, no transport, no persistence. The world
 * size, identity strings, and clock are captured at creation; the player starts
 * at the world centre. All returned DTOs are defensive copies so callers cannot
 * mutate authoritative state.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const requested = deps.worldSize ?? DEFAULT_WORLD_SIZE;
  assertPositiveInteger(requested.width, 'width');
  assertPositiveInteger(requested.height, 'height');
  const size: WorldSize = { width: requested.width, height: requested.height };

  const playerId = deps.playerId ?? DEFAULT_PLAYER_ID;
  const playerName = deps.playerName ?? DEFAULT_PLAYER_NAME;
  const clock = deps.clock ?? ((): Date => new Date());

  // Single authoritative position. Never handed out directly.
  const position: Position = {
    x: Math.floor(size.width / 2),
    y: Math.floor(size.height / 2),
  };

  const playerSnapshot = (): Player => ({
    id: playerId,
    name: playerName,
    position: { x: position.x, y: position.y },
  });

  return {
    getSnapshot(): WorldSnapshot {
      return {
        size: { width: size.width, height: size.height },
        player: playerSnapshot(),
        serverTime: clock().toISOString(),
      };
    },

    movePlayer(command: MovePlayerCommand): MovePlayerResult {
      if (command.playerId !== playerId) {
        throw new UnknownPlayerError(command.playerId);
      }

      const delta = DIRECTION_DELTAS[command.direction];
      const targetX = position.x + delta.x;
      const targetY = position.y + delta.y;
      const serverTime = clock().toISOString();

      const outOfBounds =
        targetX < 0 || targetX >= size.width || targetY < 0 || targetY >= size.height;

      if (outOfBounds) {
        return { player: playerSnapshot(), moved: false, serverTime };
      }

      position.x = targetX;
      position.y = targetY;
      return { player: playerSnapshot(), moved: true, serverTime };
    },
  };
}
