import { ProtocolParseError } from './errors.ts';
import { isGameEvent } from './event.ts';
import type { GameEvent } from './event.ts';
import { isEntityId } from './identity.ts';
import type { EntityId } from './identity.ts';
import { hasExactKeys, isFiniteNumber, isIsoUtcString, isRecord } from './internal.ts';
import { isVec3 } from './math.ts';
import type { Vec3 } from './math.ts';

/** Allowed slack on the movement-intent magnitude (reject `|v| > 1`). */
const MOVEMENT_MAGNITUDE_EPSILON = 1e-6;

/**
 * Request body for `COMMAND_PATH`: "move the actor I control".
 *
 * `movement` is the desired horizontal direction with magnitude `<= 1`;
 * `{ x: 0, z: 0 }` means stop. A magnitude below 1 is analog speed; the Manager
 * multiplies it by the actor's speed. The client is never trusted with a
 * position, only with an intent.
 *
 * Deliberately carries **no actor field**. The actor is resolved from transport
 * context by Router and passed to Manager out of band (the phase-3 invariant,
 * verified by three reviews); accepting a client-named actor would reopen the
 * unauthenticated-actor hole. An extra `actorId`/`playerId` field is rejected.
 *
 * The command is **level-triggered, not one-shot**: the Manager stores the
 * latest intent for the (single) controlled actor today and applies it every
 * tick until superseded. A real per-actor intent store is required before a
 * second actor can exist. The client therefore posts only on input change.
 */
export interface MoveIntentCommand {
  type: 'actor.moveIntent';
  movement: { x: number; z: number };
}

/**
 * Request body for `COMMAND_PATH`: "steer toward this world-space goal".
 *
 * `moveTo` is a **steering goal, not a teleport**: the Manager stores it as the
 * current movement mode, integrates toward `target` each tick with the same
 * world-space collision resolution, and clears it on arrival (within an arrival
 * radius) or when blocked. The client is never trusted with an applied position,
 * so the phase-7 anti-cheat property is preserved.
 *
 * `target` is a continuous world-space `Vec3`. Its magnitude is deliberately
 * **not bounded**: the world is the server's business, and whether a goal is
 * legal (in bounds / reachable) is a Manager runtime decision, not a wire
 * invariant. `moveTo` and `moveIntent` supersede each other — exactly one
 * current movement mode — so a direction intent interrupts a click-to-move.
 *
 * Carries no actor field, for the same reason as `MoveIntentCommand`: the actor
 * is resolved from transport context.
 */
export interface MoveToCommand {
  type: 'actor.moveTo';
  target: Vec3;
}

/**
 * Request body for `COMMAND_PATH`: "interact with this world entity".
 *
 * `targetEntityId` names a world object through its `EntityId`. The Manager
 * validates that the target exists, is within interaction range, and is
 * interactable for its kind; the observed effect today is the authoritative
 * heading change plus stopping, carried by the existing `transform.changed`
 * event. A refusal is a transport error (`NOT_FOUND` for an unknown target,
 * `CONFLICT` for an illegal-against-current-state request), never a negative
 * event.
 *
 * Carries no actor field, for the same reason as `MoveIntentCommand`: the actor
 * is resolved from transport context.
 */
export interface InteractCommand {
  type: 'actor.interact';
  targetEntityId: EntityId;
}

/**
 * Discriminated union of client -> server commands, dispatched on `type`.
 *
 * There is deliberately no `action: string` + `args: unknown` catch-all: every
 * command is its own strongly-typed interface, so callers (and executors) narrow
 * on `type` and never need a cast. The union is exactly three members today:
 * a level-triggered direction intent, a world-space steering goal, and an
 * entity interaction request.
 */
export type GameCommand = MoveIntentCommand | MoveToCommand | InteractCommand;

/**
 * Authoritative delta produced by a command or a simulation step.
 *
 * `events` is the delta; a refused command is expressed as an **empty** array —
 * there is no `moved` boolean. This replaced the phase-6 `SubmitCommandResponse`
 * (no alias) so the same envelope carries both the command ack and the tick
 * output pushed over the stream.
 */
export interface GameEventBatch {
  events: GameEvent[];
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

const MOVE_INTENT_COMMAND_KEYS = ['type', 'movement'] as const;
const MOVE_MOVEMENT_KEYS = ['x', 'z'] as const;
const MOVE_TO_COMMAND_KEYS = ['type', 'target'] as const;
const INTERACT_COMMAND_KEYS = ['type', 'targetEntityId'] as const;
const GAME_EVENT_BATCH_KEYS = ['events', 'serverTime'] as const;

/**
 * Structural guard for the movement intent (exactly `{ x, z }`, both finite,
 * magnitude `<= 1` up to a small epsilon). Not exported: callers validate the
 * command, and the movement type is inline on `MoveIntentCommand`.
 */
function isMovement(value: unknown): value is MoveIntentCommand['movement'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, MOVE_MOVEMENT_KEYS) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.z) &&
    value.x * value.x + value.z * value.z <= 1 + MOVEMENT_MAGNITUDE_EPSILON
  );
}

/** Structural guard for `MoveIntentCommand` (exactly `{ type: 'actor.moveIntent', movement }`). */
export function isMoveIntentCommand(value: unknown): value is MoveIntentCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, MOVE_INTENT_COMMAND_KEYS) &&
    value.type === 'actor.moveIntent' &&
    isMovement(value.movement)
  );
}

/** Parse and validate `MoveIntentCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveIntentCommand(value: unknown): MoveIntentCommand {
  if (!isMoveIntentCommand(value)) {
    throw new ProtocolParseError('Invalid MoveIntentCommand payload');
  }
  return value;
}

/**
 * Structural guard for `MoveToCommand` (exactly `{ type: 'actor.moveTo', target }`).
 * `target` must be a finite `Vec3`; its magnitude is intentionally unbounded.
 */
export function isMoveToCommand(value: unknown): value is MoveToCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, MOVE_TO_COMMAND_KEYS) &&
    value.type === 'actor.moveTo' &&
    isVec3(value.target)
  );
}

/** Parse and validate `MoveToCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveToCommand(value: unknown): MoveToCommand {
  if (!isMoveToCommand(value)) {
    throw new ProtocolParseError('Invalid MoveToCommand payload');
  }
  return value;
}

/**
 * Structural guard for `InteractCommand`
 * (exactly `{ type: 'actor.interact', targetEntityId }`). `targetEntityId` must
 * satisfy the non-empty `EntityId` guard.
 */
export function isInteractCommand(value: unknown): value is InteractCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, INTERACT_COMMAND_KEYS) &&
    value.type === 'actor.interact' &&
    isEntityId(value.targetEntityId)
  );
}

/** Parse and validate `InteractCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseInteractCommand(value: unknown): InteractCommand {
  if (!isInteractCommand(value)) {
    throw new ProtocolParseError('Invalid InteractCommand payload');
  }
  return value;
}

/**
 * Structural guard for `GameCommand`.
 *
 * Dispatches on the `type` discriminant. An unknown `type` (or any malformed
 * payload) is rejected; there is no catch-all command shape.
 */
export function isGameCommand(value: unknown): value is GameCommand {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'actor.moveIntent':
      return isMoveIntentCommand(value);
    case 'actor.moveTo':
      return isMoveToCommand(value);
    case 'actor.interact':
      return isInteractCommand(value);
    default:
      return false;
  }
}

/**
 * Parse and validate `GameCommand`, throwing `ProtocolParseError` on mismatch.
 *
 * Dispatches on the `type` discriminant so callers receive the narrowed union
 * member without a cast. An unknown `type` throws.
 */
export function parseGameCommand(value: unknown): GameCommand {
  if (isRecord(value)) {
    switch (value.type) {
      case 'actor.moveIntent':
        return parseMoveIntentCommand(value);
      case 'actor.moveTo':
        return parseMoveToCommand(value);
      case 'actor.interact':
        return parseInteractCommand(value);
      default:
        break;
    }
  }
  throw new ProtocolParseError('Invalid GameCommand payload');
}

/** Structural guard for `GameEventBatch` (exactly `{ events, serverTime }`). */
export function isGameEventBatch(value: unknown): value is GameEventBatch {
  if (!isRecord(value) || !hasExactKeys(value, GAME_EVENT_BATCH_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.events)) {
    return false;
  }
  return value.events.every((event) => isGameEvent(event)) && isIsoUtcString(value.serverTime);
}

/** Parse and validate `GameEventBatch`, throwing `ProtocolParseError` on mismatch. */
export function parseGameEventBatch(value: unknown): GameEventBatch {
  if (!isGameEventBatch(value)) {
    throw new ProtocolParseError('Invalid GameEventBatch payload');
  }
  return value;
}
