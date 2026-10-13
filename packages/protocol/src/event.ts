import { isBlockKind, isBlockOrientation } from './block.ts';
import type { BlockKind, BlockOrientation } from './block.ts';
import { ProtocolParseError } from './errors.ts';
import { isEntityState, isTransform } from './entity.ts';
import type { EntityState, Transform } from './entity.ts';
import { isCellCoord } from './grid.ts';
import type { CellCoord } from './grid.ts';
import { isEntityId } from './identity.ts';
import type { EntityId } from './identity.ts';
import { hasExactKeys, isRecord } from './internal.ts';

/**
 * A new entity became visible in the world. The full `EntityState` is carried so
 * a consumer can materialise it without a follow-up read.
 */
export interface EntitySpawnedEvent {
  type: 'entity.spawned';
  entity: EntityState;
}

/** An entity left the world. Carries only the id; the consumer drops its state. */
export interface EntityRemovedEvent {
  type: 'entity.removed';
  entityId: EntityId;
}

/** The authoritative transform of an entity changed. */
export interface TransformChangedEvent {
  type: 'transform.changed';
  entityId: EntityId;
  transform: Transform;
}

/**
 * One block in the discrete Block World changed. `kind: 'air'` means the block
 * at `coord` was removed (air is absence in a snapshot, but a block-change event
 * spells removal explicitly). Absolute integer `coord`; never chunk-local.
 */
export interface BlockChangedEvent {
  type: 'block.changed';
  coord: CellCoord;
  kind: BlockKind;
  orientation: BlockOrientation;
}

/**
 * Discriminated union of authoritative world deltas, dispatched on `type`.
 *
 * Events are the *delta*; `WorldSnapshot` is the full state. A command that the
 * server refuses produces no events at all (an empty array), never a negative
 * event.
 *
 * There is deliberately **no occupancy event**: occupancy (which cells an entity
 * covers) is a SERVER-ONLY derived index, it is not carried in the snapshot in
 * v1, and the client learns it from `entity.validatePlacement` instead.
 */
export type GameEvent =
  | EntitySpawnedEvent
  | EntityRemovedEvent
  | TransformChangedEvent
  | BlockChangedEvent;

const ENTITY_SPAWNED_KEYS = ['type', 'entity'] as const;
const ENTITY_REMOVED_KEYS = ['type', 'entityId'] as const;
const TRANSFORM_CHANGED_KEYS = ['type', 'entityId', 'transform'] as const;
const BLOCK_CHANGED_KEYS = ['type', 'coord', 'kind', 'orientation'] as const;

/** Structural guard for `EntitySpawnedEvent`. */
export function isEntitySpawnedEvent(value: unknown): value is EntitySpawnedEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_SPAWNED_KEYS) &&
    value.type === 'entity.spawned' &&
    isEntityState(value.entity)
  );
}

/** Parse and validate `EntitySpawnedEvent`, throwing `ProtocolParseError` on mismatch. */
export function parseEntitySpawnedEvent(value: unknown): EntitySpawnedEvent {
  if (!isEntitySpawnedEvent(value)) {
    throw new ProtocolParseError('Invalid EntitySpawnedEvent payload');
  }
  return value;
}

/** Structural guard for `EntityRemovedEvent`. */
export function isEntityRemovedEvent(value: unknown): value is EntityRemovedEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ENTITY_REMOVED_KEYS) &&
    value.type === 'entity.removed' &&
    isEntityId(value.entityId)
  );
}

/** Parse and validate `EntityRemovedEvent`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityRemovedEvent(value: unknown): EntityRemovedEvent {
  if (!isEntityRemovedEvent(value)) {
    throw new ProtocolParseError('Invalid EntityRemovedEvent payload');
  }
  return value;
}

/** Structural guard for `TransformChangedEvent`. */
export function isTransformChangedEvent(value: unknown): value is TransformChangedEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, TRANSFORM_CHANGED_KEYS) &&
    value.type === 'transform.changed' &&
    isEntityId(value.entityId) &&
    isTransform(value.transform)
  );
}

/** Parse and validate `TransformChangedEvent`, throwing `ProtocolParseError` on mismatch. */
export function parseTransformChangedEvent(value: unknown): TransformChangedEvent {
  if (!isTransformChangedEvent(value)) {
    throw new ProtocolParseError('Invalid TransformChangedEvent payload');
  }
  return value;
}

/**
 * Structural guard for `BlockChangedEvent`
 * (exactly `{ type, coord, kind, orientation }`). `kind: 'air'` IS accepted here
 * to express removal.
 */
export function isBlockChangedEvent(value: unknown): value is BlockChangedEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, BLOCK_CHANGED_KEYS) &&
    value.type === 'block.changed' &&
    isCellCoord(value.coord) &&
    isBlockKind(value.kind) &&
    isBlockOrientation(value.orientation)
  );
}

/** Parse and validate `BlockChangedEvent`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockChangedEvent(value: unknown): BlockChangedEvent {
  if (!isBlockChangedEvent(value)) {
    throw new ProtocolParseError('Invalid BlockChangedEvent payload');
  }
  return value;
}

/**
 * Structural guard for `GameEvent`.
 *
 * Dispatches on the `type` discriminant. An unknown `type` (or any malformed
 * payload) is rejected; there is no catch-all event shape.
 */
export function isGameEvent(value: unknown): value is GameEvent {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'entity.spawned':
      return isEntitySpawnedEvent(value);
    case 'entity.removed':
      return isEntityRemovedEvent(value);
    case 'transform.changed':
      return isTransformChangedEvent(value);
    case 'block.changed':
      return isBlockChangedEvent(value);
    default:
      return false;
  }
}

/**
 * Parse and validate `GameEvent`, throwing `ProtocolParseError` on mismatch.
 *
 * Dispatches on the `type` discriminant so callers receive the narrowed union
 * member without a cast. An unknown `type` throws.
 */
export function parseGameEvent(value: unknown): GameEvent {
  if (isRecord(value)) {
    switch (value.type) {
      case 'entity.spawned':
        return parseEntitySpawnedEvent(value);
      case 'entity.removed':
        return parseEntityRemovedEvent(value);
      case 'transform.changed':
        return parseTransformChangedEvent(value);
      case 'block.changed':
        return parseBlockChangedEvent(value);
      default:
        break;
    }
  }
  throw new ProtocolParseError('Invalid GameEvent payload');
}
