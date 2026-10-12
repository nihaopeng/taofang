import { ProtocolParseError } from './errors.ts';
import { isActorId, isEntityId } from './identity.ts';
import type { ActorId, EntityId } from './identity.ts';
import { hasExactKeys, isRecord } from './internal.ts';
import { isQuat, isVec3 } from './math.ts';
import type { Quat, Vec3 } from './math.ts';

/**
 * Canonical 3D transform: a continuous world-space `position` and a `rotation`.
 *
 * `Transform` superseded the phase-3 `Position` and the 2D integer tile
 * coordinate that phases 4-6 mistakenly used. The world is a real continuous 3D
 * world; the gameplay grid is a separate interaction layer (`TileState` holds a
 * `CellCoord`, never a transform).
 *
 * There is deliberately **no visual `scale`**: scale has no gameplay semantics
 * yet, so it does not belong in the Game transform. Current gameplay may only
 * produce a yaw rotation, but the canonical type must not degenerate to
 * `rotationY`-only.
 *
 * In-bounds validation is a Manager runtime concern, so finite out-of-bounds
 * positions are accepted by the wire guard.
 */
export interface Transform {
  position: Vec3;
  rotation: Quat;
}

/**
 * Closed union of entity kinds: `'character' | 'tree'`. It grows only as
 * features land, and because the payload guards match keys exactly, adding a
 * kind is a breaking wire change.
 *
 * A kind is a *game* label; what it looks like is decided by the render bridge.
 */
export type EntityKind = 'character' | 'tree';

/**
 * A world object as exposed on the wire.
 *
 * `actorId` is **present and nullable**: it links the entity to the actor that
 * can act as it (`null` for entities that are not actor-controllable). It is not
 * optional — a missing key is a contract violation, not "no actor".
 */
export interface EntityState {
  entityId: EntityId;
  actorId: ActorId | null;
  kind: EntityKind;
  transform: Transform;
  visible: boolean;
}

const TRANSFORM_KEYS = ['position', 'rotation'] as const;
const ENTITY_STATE_KEYS = ['entityId', 'actorId', 'kind', 'transform', 'visible'] as const;

/**
 * Structural guard for `Transform` (exactly `{ position, rotation }`).
 * `position` is a finite `Vec3` and `rotation` is a non-zero finite `Quat`.
 */
export function isTransform(value: unknown): value is Transform {
  if (!isRecord(value) || !hasExactKeys(value, TRANSFORM_KEYS)) {
    return false;
  }
  return isVec3(value.position) && isQuat(value.rotation);
}

/** Parse and validate `Transform`, throwing `ProtocolParseError` on mismatch. */
export function parseTransform(value: unknown): Transform {
  if (!isTransform(value)) {
    throw new ProtocolParseError('Invalid Transform payload');
  }
  return value;
}

/** Structural guard for `EntityKind` (exactly `'character' | 'tree'` today). */
export function isEntityKind(value: unknown): value is EntityKind {
  return value === 'character' || value === 'tree';
}

/** Parse and validate `EntityKind`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityKind(value: unknown): EntityKind {
  if (!isEntityKind(value)) {
    throw new ProtocolParseError('Invalid EntityKind payload');
  }
  return value;
}

/** Structural guard for `EntityState` (exactly `{ entityId, actorId, kind, transform, visible }`). */
export function isEntityState(value: unknown): value is EntityState {
  if (!isRecord(value) || !hasExactKeys(value, ENTITY_STATE_KEYS)) {
    return false;
  }
  return (
    isEntityId(value.entityId) &&
    (value.actorId === null || isActorId(value.actorId)) &&
    isEntityKind(value.kind) &&
    isTransform(value.transform) &&
    typeof value.visible === 'boolean'
  );
}

/** Parse and validate `EntityState`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityState(value: unknown): EntityState {
  if (!isEntityState(value)) {
    throw new ProtocolParseError('Invalid EntityState payload');
  }
  return value;
}
