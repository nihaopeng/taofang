import { isBlockState } from './block.ts';
import type { BlockState } from './block.ts';
import { isEntityState } from './entity.ts';
import type { EntityState } from './entity.ts';
import { ProtocolParseError } from './errors.ts';
import { isBlockGrid } from './grid.ts';
import type { BlockGrid } from './grid.ts';
import { isActorId, isWorldId } from './identity.ts';
import type { ActorId, WorldId } from './identity.ts';
import { hasExactKeys, isIsoUtcString, isRecord } from './internal.ts';
import { isVec3 } from './math.ts';
import type { Vec3 } from './math.ts';

/**
 * The world's AABB-shaped extent, in continuous world units. This bounds BOTH
 * systems that share the real 3D coordinate system: the discrete block grid
 * (whose cells are addressed by integer `CellCoord`s) and the continuous entity
 * world.
 */
export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

/**
 * Point-in-time authoritative state of the world, version 9.
 *
 * The snapshot carries the two orthogonal systems that share one real 3D
 * coordinate system:
 *
 * 1. **Block World (discrete topology)** — `blockGrid` (the addressing
 *    configuration: `origin` + `cellSize`) and `blocks` (a **sparse** list of
 *    non-air `BlockState`s with absolute `CellCoord`s). `air` is never carried:
 *    an absent cell IS air.
 * 2. **Entity World (continuous)** — `entities`, each with a real 3D
 *    `Transform` (`Vec3` position + `Quat` rotation). A placeable entity's
 *    occupancy is DERIVED from its committed transform, never stored here.
 *
 * `controlledActorId` states which actor the caller controls (`null` when the
 * caller controls nothing). `worldId` scopes the snapshot to one world.
 *
 * Chunks are an addressing/storage boundary, NOT a wire encoding in v1: the
 * snapshot carries absolute cells and has no chunk field. Occupancy (which cells
 * an entity covers) is a SERVER-ONLY derived index and is deliberately absent;
 * the client learns it from `entity.validatePlacement`.
 */
export interface WorldSnapshot {
  worldId: WorldId;
  bounds: WorldBounds;
  /** The block grid's pure configuration (`origin` + `cellSize`). */
  blockGrid: BlockGrid;
  /** Sparse, non-air blocks with absolute integer cells. At most one per coord. */
  blocks: BlockState[];
  entities: EntityState[];
  controlledActorId: ActorId | null;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

/** Response body for `WORLD_PATH`. */
export interface GetWorldResponse {
  world: WorldSnapshot;
}

const WORLD_BOUNDS_KEYS = ['min', 'max'] as const;
const WORLD_SNAPSHOT_KEYS = [
  'worldId',
  'bounds',
  'blockGrid',
  'blocks',
  'entities',
  'controlledActorId',
  'serverTime',
] as const;
const GET_WORLD_RESPONSE_KEYS = ['world'] as const;

/** Structural guard for `WorldBounds` (exactly `{ min, max }`, both finite `Vec3`). */
export function isWorldBounds(value: unknown): value is WorldBounds {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_BOUNDS_KEYS)) {
    return false;
  }
  return isVec3(value.min) && isVec3(value.max);
}

/** Parse and validate `WorldBounds`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldBounds(value: unknown): WorldBounds {
  if (!isWorldBounds(value)) {
    throw new ProtocolParseError('Invalid WorldBounds payload');
  }
  return value;
}

/**
 * The snapshot's sparse-block invariant: every entry is a valid `BlockState`
 * whose `kind` is NOT `air`, and whose absolute `coord` appears at most once.
 *
 * `air` is absence, so a snapshot that explicitly carries an `air` entry is
 * malformed and is REJECTED here. A command may still send `kind: 'air'` to
 * mean "remove"; that asymmetry is intentional.
 */
function isSparseBlockList(value: unknown): value is BlockState[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isBlockState(entry) || entry.kind === 'air') {
      return false;
    }
    const key = `${entry.coord.x},${entry.coord.y},${entry.coord.z}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

/** Structural guard for `WorldSnapshot` (v9: `blockGrid` + sparse `blocks`). */
export function isWorldSnapshot(value: unknown): value is WorldSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_SNAPSHOT_KEYS)) {
    return false;
  }
  if (!Array.isArray(value.entities)) {
    return false;
  }
  return (
    isWorldId(value.worldId) &&
    isWorldBounds(value.bounds) &&
    isBlockGrid(value.blockGrid) &&
    isSparseBlockList(value.blocks) &&
    value.entities.every((entity) => isEntityState(entity)) &&
    (value.controlledActorId === null || isActorId(value.controlledActorId)) &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `WorldSnapshot`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldSnapshot(value: unknown): WorldSnapshot {
  if (!isWorldSnapshot(value)) {
    throw new ProtocolParseError('Invalid WorldSnapshot payload');
  }
  return value;
}

/** Structural guard for `GetWorldResponse` (exactly `{ world }`). */
export function isGetWorldResponse(value: unknown): value is GetWorldResponse {
  return (
    isRecord(value) && hasExactKeys(value, GET_WORLD_RESPONSE_KEYS) && isWorldSnapshot(value.world)
  );
}

/** Parse and validate `GetWorldResponse`, throwing `ProtocolParseError` on mismatch. */
export function parseGetWorldResponse(value: unknown): GetWorldResponse {
  if (!isGetWorldResponse(value)) {
    throw new ProtocolParseError('Invalid GetWorldResponse payload');
  }
  return value;
}
