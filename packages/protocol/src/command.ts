import { isBlockKind, isBlockOrientation } from './block.ts';
import type { BlockKind, BlockOrientation } from './block.ts';
import { isEntityKind, isTransform } from './entity.ts';
import type { EntityKind, Transform } from './entity.ts';
import { ProtocolParseError } from './errors.ts';
import { isGameEvent } from './event.ts';
import type { GameEvent } from './event.ts';
import { isCellCoord } from './grid.ts';
import type { CellCoord } from './grid.ts';
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
 * Request body for `COMMAND_PATH`: "jump".
 *
 * Carries **no payload**: the jump's height, velocity and gravity are Manager
 * rules, and the actor is resolved from transport context. The Manager applies
 * the rule that the actor must be grounded; a jump in mid-air is ignored or
 * refused, never a wire concern.
 */
export interface ActorJumpCommand {
  type: 'actor.jump';
}

/**
 * Request body for `COMMAND_PATH`: "set the block at this absolute cell".
 *
 * `coord` is an absolute integer `CellCoord` (never chunk-local). `kind` may be
 * `'air'` to mean "remove the block here"; `block.remove` is the explicit
 * spelling. `orientation` is always present (yaw `0` for non-directional
 * blocks).
 */
export interface BlockSetCommand {
  type: 'block.set';
  coord: CellCoord;
  kind: BlockKind;
  orientation: BlockOrientation;
}

/** Request body for `COMMAND_PATH`: "remove the block at this absolute cell". */
export interface BlockRemoveCommand {
  type: 'block.remove';
  coord: CellCoord;
}

/**
 * Request body for `COMMAND_PATH`: "place an entity near this requested
 * anchor".
 *
 * `position` is a REQUESTED continuous anchor, **not** the committed transform:
 * the Manager's Placement Resolver snaps it onto the valid lattice for `kind`'s
 * footprint and then commits the authoritative transform. `yawDegrees` is a
 * requested facing, not a guarantee.
 */
export interface EntityPlaceCommand {
  type: 'entity.place';
  kind: EntityKind;
  position: Vec3;
  yawDegrees: number;
}

/** Request body for `COMMAND_PATH`: "rotate this entity to this requested yaw". */
export interface EntityRotateCommand {
  type: 'entity.rotate';
  entityId: EntityId;
  yawDegrees: number;
}

/** Request body for `COMMAND_PATH`: "remove this entity". */
export interface EntityRemoveCommand {
  type: 'entity.remove';
  entityId: EntityId;
}

/**
 * Request body for `COMMAND_PATH`: "would this placement be legal, and where
 * would it land?".
 *
 * A pure query: it mutates nothing. The response is a
 * {@link ValidatePlacementResponse} rather than an event batch, so the client's
 * pending ghost can align to the same resolved transform the server would
 * commit and can see the occupancy it would collide with.
 */
export interface EntityValidatePlacementCommand {
  type: 'entity.validatePlacement';
  kind: EntityKind;
  position: Vec3;
  yawDegrees: number;
}

/**
 * Discriminated union of client -> server commands, dispatched on `type`.
 *
 * There is deliberately no `action: string` + `args: unknown` catch-all: every
 * command is its own strongly-typed interface, so callers (and executors) narrow
 * on `type` and never need a cast.
 *
 * Every command obeys the identity invariant: the acting identity comes from
 * transport context, never from a command field. No member carries
 * `actorId`/`playerId`.
 */
export type GameCommand =
  | MoveIntentCommand
  | MoveToCommand
  | InteractCommand
  | ActorJumpCommand
  | BlockSetCommand
  | BlockRemoveCommand
  | EntityPlaceCommand
  | EntityRotateCommand
  | EntityRemoveCommand
  | EntityValidatePlacementCommand;

/**
 * Success body of `entity.validatePlacement`.
 *
 * `reason` and `resolvedTransform` are **present and nullable** rather than
 * optional keys. This deviates deliberately from an `{ reason?, resolvedTransform? }`
 * sketch: the contract keeps exact-key guards with no optional-key special
 * case, matching the existing `EntityState.actorId` precedent. `valid: false`
 * carries a non-null `reason`; `valid: true` carries a non-null
 * `resolvedTransform`. `occupiedCells` is always an array (possibly empty).
 */
export interface ValidatePlacementResponse {
  valid: boolean;
  reason: string | null;
  occupiedCells: CellCoord[];
  /** The transform the server would commit; `null` when `valid` is `false`. */
  resolvedTransform: Transform | null;
}

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

/**
 * Success body of `COMMAND_PATH`: either an authoritative event delta (every
 * mutating command) or a placement-validation result
 * (`entity.validatePlacement`, a pure query). The two are structurally
 * disjoint, so a consumer can narrow without a discriminant field.
 */
export type CommandResponse = GameEventBatch | ValidatePlacementResponse;

const MOVE_INTENT_COMMAND_KEYS = ['type', 'movement'] as const;
const MOVE_MOVEMENT_KEYS = ['x', 'z'] as const;
const MOVE_TO_COMMAND_KEYS = ['type', 'target'] as const;
const INTERACT_COMMAND_KEYS = ['type', 'targetEntityId'] as const;
const ACTOR_JUMP_COMMAND_KEYS = ['type'] as const;
const BLOCK_SET_COMMAND_KEYS = ['type', 'coord', 'kind', 'orientation'] as const;
const BLOCK_REMOVE_COMMAND_KEYS = ['type', 'coord'] as const;
const ENTITY_PLACE_COMMAND_KEYS = ['type', 'kind', 'position', 'yawDegrees'] as const;
const ENTITY_ROTATE_COMMAND_KEYS = ['type', 'entityId', 'yawDegrees'] as const;
const ENTITY_REMOVE_COMMAND_KEYS = ['type', 'entityId'] as const;
const ENTITY_VALIDATE_PLACEMENT_COMMAND_KEYS = [
  'type',
  'kind',
  'position',
  'yawDegrees',
] as const;
const VALIDATE_PLACEMENT_RESPONSE_KEYS = [
  'valid',
  'reason',
  'occupiedCells',
  'resolvedTransform',
] as const;
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

/** Structural guard for `ActorJumpCommand` (exactly `{ type: 'actor.jump' }`, no payload). */
export function isActorJumpCommand(value: unknown): value is ActorJumpCommand {
  return (
    isRecord(value) && hasExactKeys(value, ACTOR_JUMP_COMMAND_KEYS) && value.type === 'actor.jump'
  );
}

/** Parse and validate `ActorJumpCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseActorJumpCommand(value: unknown): ActorJumpCommand {
  if (!isActorJumpCommand(value)) {
    throw new ProtocolParseError('Invalid ActorJumpCommand payload');
  }
  return value;
}

/**
 * Structural guard for `BlockSetCommand`
 * (exactly `{ type: 'block.set', coord, kind, orientation }`). `kind` may be
 * `'air'` to mean removal.
 */
export function isBlockSetCommand(value: unknown): value is BlockSetCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, BLOCK_SET_COMMAND_KEYS) &&
    value.type === 'block.set' &&
    isCellCoord(value.coord) &&
    isBlockKind(value.kind) &&
    isBlockOrientation(value.orientation)
  );
}

/** Parse and validate `BlockSetCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockSetCommand(value: unknown): BlockSetCommand {
  if (!isBlockSetCommand(value)) {
    throw new ProtocolParseError('Invalid BlockSetCommand payload');
  }
  return value;
}

/** Structural guard for `BlockRemoveCommand` (exactly `{ type: 'block.remove', coord }`). */
export function isBlockRemoveCommand(value: unknown): value is BlockRemoveCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, BLOCK_REMOVE_COMMAND_KEYS) &&
    value.type === 'block.remove' &&
    isCellCoord(value.coord)
  );
}

/** Parse and validate `BlockRemoveCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockRemoveCommand(value: unknown): BlockRemoveCommand {
  if (!isBlockRemoveCommand(value)) {
    throw new ProtocolParseError('Invalid BlockRemoveCommand payload');
  }
  return value;
}

/** Shared guard for the placement-request triple `{ kind, position, yawDegrees }`. */
function isPlacementRequest(value: Record<string, unknown>): boolean {
  return (
    isEntityKind(value.kind) && isVec3(value.position) && isFiniteNumber(value.yawDegrees)
  );
}

/**
 * Structural guard for `EntityPlaceCommand`
 * (exactly `{ type: 'entity.place', kind, position, yawDegrees }`).
 */
export function isEntityPlaceCommand(value: unknown): value is EntityPlaceCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_PLACE_COMMAND_KEYS) &&
    value.type === 'entity.place' &&
    isPlacementRequest(value)
  );
}

/** Parse and validate `EntityPlaceCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityPlaceCommand(value: unknown): EntityPlaceCommand {
  if (!isEntityPlaceCommand(value)) {
    throw new ProtocolParseError('Invalid EntityPlaceCommand payload');
  }
  return value;
}

/**
 * Structural guard for `EntityRotateCommand`
 * (exactly `{ type: 'entity.rotate', entityId, yawDegrees }`).
 */
export function isEntityRotateCommand(value: unknown): value is EntityRotateCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_ROTATE_COMMAND_KEYS) &&
    value.type === 'entity.rotate' &&
    isEntityId(value.entityId) &&
    isFiniteNumber(value.yawDegrees)
  );
}

/** Parse and validate `EntityRotateCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityRotateCommand(value: unknown): EntityRotateCommand {
  if (!isEntityRotateCommand(value)) {
    throw new ProtocolParseError('Invalid EntityRotateCommand payload');
  }
  return value;
}

/**
 * Structural guard for `EntityRemoveCommand`
 * (exactly `{ type: 'entity.remove', entityId }`).
 */
export function isEntityRemoveCommand(value: unknown): value is EntityRemoveCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_REMOVE_COMMAND_KEYS) &&
    value.type === 'entity.remove' &&
    isEntityId(value.entityId)
  );
}

/** Parse and validate `EntityRemoveCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityRemoveCommand(value: unknown): EntityRemoveCommand {
  if (!isEntityRemoveCommand(value)) {
    throw new ProtocolParseError('Invalid EntityRemoveCommand payload');
  }
  return value;
}

/**
 * Structural guard for `EntityValidatePlacementCommand`
 * (exactly `{ type: 'entity.validatePlacement', kind, position, yawDegrees }`).
 */
export function isEntityValidatePlacementCommand(
  value: unknown,
): value is EntityValidatePlacementCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_VALIDATE_PLACEMENT_COMMAND_KEYS) &&
    value.type === 'entity.validatePlacement' &&
    isPlacementRequest(value)
  );
}

/** Parse and validate `EntityValidatePlacementCommand`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityValidatePlacementCommand(
  value: unknown,
): EntityValidatePlacementCommand {
  if (!isEntityValidatePlacementCommand(value)) {
    throw new ProtocolParseError('Invalid EntityValidatePlacementCommand payload');
  }
  return value;
}

/**
 * Structural guard for `ValidatePlacementResponse`
 * (exactly `{ valid, reason, occupiedCells, resolvedTransform }`). `reason` and
 * `resolvedTransform` are present-and-nullable, never missing. `valid: false`
 * requires a non-null reason and a null transform; `valid: true` requires a
 * non-null transform and a null reason.
 */
export function isValidatePlacementResponse(value: unknown): value is ValidatePlacementResponse {
  if (!isRecord(value) || !hasExactKeys(value, VALIDATE_PLACEMENT_RESPONSE_KEYS)) {
    return false;
  }
  if (
    typeof value.valid !== 'boolean' ||
    !Array.isArray(value.occupiedCells) ||
    !value.occupiedCells.every((cell) => isCellCoord(cell))
  ) {
    return false;
  }
  const reason = value.reason;
  const resolvedTransform = value.resolvedTransform;
  if (value.valid) {
    return reason === null && isTransform(resolvedTransform);
  }
  return typeof reason === 'string' && reason.length > 0 && resolvedTransform === null;
}

/** Parse and validate `ValidatePlacementResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseValidatePlacementResponse(value: unknown): ValidatePlacementResponse {
  if (!isValidatePlacementResponse(value)) {
    throw new ProtocolParseError('Invalid ValidatePlacementResponse payload');
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
    case 'actor.jump':
      return isActorJumpCommand(value);
    case 'block.set':
      return isBlockSetCommand(value);
    case 'block.remove':
      return isBlockRemoveCommand(value);
    case 'entity.place':
      return isEntityPlaceCommand(value);
    case 'entity.rotate':
      return isEntityRotateCommand(value);
    case 'entity.remove':
      return isEntityRemoveCommand(value);
    case 'entity.validatePlacement':
      return isEntityValidatePlacementCommand(value);
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
      case 'actor.jump':
        return parseActorJumpCommand(value);
      case 'block.set':
        return parseBlockSetCommand(value);
      case 'block.remove':
        return parseBlockRemoveCommand(value);
      case 'entity.place':
        return parseEntityPlaceCommand(value);
      case 'entity.rotate':
        return parseEntityRotateCommand(value);
      case 'entity.remove':
        return parseEntityRemoveCommand(value);
      case 'entity.validatePlacement':
        return parseEntityValidatePlacementCommand(value);
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

/**
 * Structural guard for `CommandResponse`: an event batch or a placement
 * validation result. The two shapes have disjoint exact-key sets.
 */
export function isCommandResponse(value: unknown): value is CommandResponse {
  return isGameEventBatch(value) || isValidatePlacementResponse(value);
}

/** Parse and validate `CommandResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseCommandResponse(value: unknown): CommandResponse {
  if (!isCommandResponse(value)) {
    throw new ProtocolParseError('Invalid CommandResponse payload');
  }
  return value;
}
