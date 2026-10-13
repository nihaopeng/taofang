import { ProtocolParseError } from './errors.ts';
import { isActorId, isEntityId } from './identity.ts';
import type { ActorId, EntityId } from './identity.ts';
import { hasExactKeys, isRecord } from './internal.ts';
import { isQuat, isVec3 } from './math.ts';
import type { Quat, Vec3 } from './math.ts';

/**
 * Canonical 3D transform: a continuous world-space `position` and a `rotation`.
 *
 * `Transform` belongs to the **continuous Entity World**. Its `position` is
 * NEVER a cell/tile/block coordinate and is never snapped in storage: the
 * canonical position is a continuous `Vec3`. Even for a grid-snapped placeable,
 * the committed transform is the resolved continuous centre of its footprint;
 * the integer occupancy is DERIVED from the transform + placement definition,
 * never stored back into it.
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
 * Closed union of entity kinds: `'character' | 'tree' | 'rock' | 'chest' |
 * 'building'`. It grows only as features land, and because the payload guards
 * match keys exactly, adding a kind is a breaking wire change.
 *
 * A kind is a *game* label; what it looks like and its declarative placement
 * geometry are carried by the static `entityKinds` catalogue in GameInfo, never
 * here.
 */
export type EntityKind = 'character' | 'tree' | 'rock' | 'chest' | 'building';

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

/** Structural guard for `EntityKind` (the closed union above). */
export function isEntityKind(value: unknown): value is EntityKind {
  return (
    value === 'character' ||
    value === 'tree' ||
    value === 'rock' ||
    value === 'chest' ||
    value === 'building'
  );
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
