import { ProtocolParseError } from './errors.ts';
import { isActorId, isEntityId } from './identity.ts';
import type { ActorId, EntityId } from './identity.ts';
import { hasExactKeys, isFiniteInteger, isRecord } from './internal.ts';

/**
 * Integer tile coordinates. Origin is TOP-LEFT: `x` grows east, `y` grows south.
 *
 * No sign or bounds constraint: world-bounds validity is a Manager runtime rule,
 * not a wire invariant.
 *
 * `Transform` is the canonical position value object for the primitive-driven
 * contract; it supersedes the phase-3 `Position`.
 */
export interface Transform {
  x: number;
  y: number;
}

/**
 * Closed union of entity kinds. It grows only as features land, and because the
 * payload guards match keys exactly, adding a kind is a breaking wire change.
 *
 * A kind is a *game* label; what it looks like is decided by the render bridge.
 */
export type EntityKind = 'character';

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

const TRANSFORM_KEYS = ['x', 'y'] as const;
const ENTITY_STATE_KEYS = ['entityId', 'actorId', 'kind', 'transform', 'visible'] as const;

/**
 * Structural guard for `Transform`.
 *
 * `x`/`y` must be finite integers of any sign. In-bounds validation is Manager's
 * runtime concern, so negative coordinates are accepted here.
 */
export function isTransform(value: unknown): value is Transform {
  if (!isRecord(value) || !hasExactKeys(value, TRANSFORM_KEYS)) {
    return false;
  }
  return isFiniteInteger(value.x) && isFiniteInteger(value.y);
}

/** Parse and validate `Transform`, throwing `ProtocolParseError` on mismatch. */
export function parseTransform(value: unknown): Transform {
  if (!isTransform(value)) {
    throw new ProtocolParseError('Invalid Transform payload');
  }
  return value;
}

/** Structural guard for `EntityKind` (exactly `'character'` today). */
export function isEntityKind(value: unknown): value is EntityKind {
  return value === 'character';
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
