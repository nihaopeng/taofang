import type {
  ActorId,
  EntityId,
  EntityState,
  GameCommand,
  MoveDirection,
  Transform,
  WorldSize,
  WorldSnapshot,
  SubmitCommandResponse,
} from '@starvalley/protocol';
import { parseActorId, parseEntityId } from '@starvalley/protocol';

/**
 * Default authoritative world dimensions for this slice.
 *
 * Frozen by the Phase-4 contract; a world with these dimensions has its centre
 * at `{ x: 6, y: 4 }`.
 */
export const DEFAULT_WORLD_SIZE: WorldSize = { width: 12, height: 8 };

const DEFAULT_ACTOR_ID: ActorId = parseActorId('actor-1');
const DEFAULT_ENTITY_ID: EntityId = parseEntityId('entity-1');

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
   * A command that the world rules refuse produces no events (an empty array)
   * and leaves authoritative state untouched; it is not an error. Unknown actors
   * throw {@link UnknownActorError}.
   */
  submitCommand(input: { actorId: ActorId; command: GameCommand }): SubmitCommandResult;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  /** World dimensions. Defaults to {@link DEFAULT_WORLD_SIZE}. */
  worldSize?: WorldSize;
  /** Identifier of the single known actor. Defaults to `parseActorId('actor-1')`. */
  actorId?: ActorId;
  /** Identifier of the single world entity. Defaults to `parseEntityId('entity-1')`. */
  entityId?: EntityId;
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
 * size, actor/entity identity, and clock are captured at creation; the single
 * character entity starts at the world centre. Every returned DTO (including
 * nested `transform` objects, the `entities` array, and event payloads) is a
 * defensive copy so callers cannot mutate authoritative state.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const requested = deps.worldSize ?? DEFAULT_WORLD_SIZE;
  assertPositiveInteger(requested.width, 'width');
  assertPositiveInteger(requested.height, 'height');
  const size: WorldSize = { width: requested.width, height: requested.height };

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const entityId = deps.entityId ?? DEFAULT_ENTITY_ID;
  const clock = deps.clock ?? ((): Date => new Date());

  // Single authoritative transform. Never handed out directly.
  const transform: Transform = {
    x: Math.floor(size.width / 2),
    y: Math.floor(size.height / 2),
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
        size: { width: size.width, height: size.height },
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
          const inBounds =
            targetX >= 0 && targetX < size.width && targetY >= 0 && targetY < size.height;

          if (!inBounds) {
            // A refused step changes nothing observable: empty event list.
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
