import type {
  Actor,
  ActorId,
  MoveActorCommand,
  MoveActorResult,
  MoveDirection,
  Position,
  WorldSize,
  WorldSnapshot,
} from '@starvalley/protocol';
import { parseActorId } from '@starvalley/protocol';

/**
 * Default authoritative world dimensions for this slice.
 *
 * Frozen by the Phase-2 contract; a world with these dimensions has its centre
 * at `{ x: 6, y: 4 }`.
 */
export const DEFAULT_WORLD_SIZE: WorldSize = { width: 12, height: 8 };

const DEFAULT_ACTOR_ID: ActorId = parseActorId('actor-1');
const DEFAULT_ACTOR_NAME = 'Player';

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
 * Typed input for {@link WorldManager.moveActor}: the actor identity comes only
 * from this out-of-band input, never from `command` (which has no actor field).
 */
export interface MoveActorInput {
  actorId: ActorId;
  command: MoveActorCommand;
}

/**
 * Read-only, transport-neutral access to the authoritative world state.
 *
 * Every operation is scoped to an actor supplied as typed input; there is no
 * implicit "current actor".
 */
export interface WorldManager {
  /** Point-in-time authoritative world + actor view for `input.actorId`. Always a fresh object. */
  getSnapshot(input: { actorId: ActorId }): WorldSnapshot;
  /**
   * Attempt to step `input.actorId` one tile in `input.command.direction`.
   *
   * A step that would leave the world is refused (`moved: false`) with the
   * unchanged position; it is not an error. Unknown actors throw.
   */
  moveActor(input: MoveActorInput): MoveActorResult;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  /** World dimensions. Defaults to {@link DEFAULT_WORLD_SIZE}. */
  worldSize?: WorldSize;
  /** Identifier of the single known actor. Defaults to `parseActorId('actor-1')`. */
  actorId?: ActorId;
  /** Display name of the single known actor. Defaults to `'Player'`. */
  actorName?: string;
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
 * size, actor identity, and clock are captured at creation; the actor starts at
 * the world centre. All returned DTOs are defensive copies so callers cannot
 * mutate authoritative state.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const requested = deps.worldSize ?? DEFAULT_WORLD_SIZE;
  assertPositiveInteger(requested.width, 'width');
  assertPositiveInteger(requested.height, 'height');
  const size: WorldSize = { width: requested.width, height: requested.height };

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const actorName = deps.actorName ?? DEFAULT_ACTOR_NAME;
  const clock = deps.clock ?? ((): Date => new Date());

  // Single authoritative position. Never handed out directly.
  const position: Position = {
    x: Math.floor(size.width / 2),
    y: Math.floor(size.height / 2),
  };

  const actorSnapshot = (): Actor => ({
    actorId,
    name: actorName,
    position: { x: position.x, y: position.y },
  });

  return {
    getSnapshot(input: { actorId: ActorId }): WorldSnapshot {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      return {
        size: { width: size.width, height: size.height },
        actor: actorSnapshot(),
        serverTime: clock().toISOString(),
      };
    },

    moveActor(input: MoveActorInput): MoveActorResult {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }

      const delta = DIRECTION_DELTAS[input.command.direction];
      const targetX = position.x + delta.x;
      const targetY = position.y + delta.y;
      const serverTime = clock().toISOString();

      const outOfBounds =
        targetX < 0 || targetX >= size.width || targetY < 0 || targetY >= size.height;

      if (outOfBounds) {
        return { actor: actorSnapshot(), moved: false, serverTime };
      }

      position.x = targetX;
      position.y = targetY;
      return { actor: actorSnapshot(), moved: true, serverTime };
    },
  };
}
