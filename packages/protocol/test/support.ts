import {
  ProtocolParseError,
  parseActorId,
  parseColliderId,
  parseEntityId,
  parseSurfaceId,
  parseWorldId,
} from '../src/index.ts';
import type {
  CellCoord,
  ColliderState,
  EntityRemovedEvent,
  EntitySpawnedEvent,
  EntityState,
  GameEventBatch,
  GridSpec,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  Quat,
  SurfaceState,
  TileState,
  Transform,
  TransformChangedEvent,
  Vec3,
  WorldBounds,
  WorldSnapshot,
  WorldStreamMessage,
} from '../src/index.ts';

/** Run `fn`, asserting it throws `ProtocolParseError`, and return the error. */
export function captureParseError(fn: () => unknown): ProtocolParseError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof ProtocolParseError)) {
    throw new Error('expected fn to throw a ProtocolParseError');
  }
  return thrown;
}

export const validGameInfo = {
  gameName: 'Starvalley',
  serverVersion: '0.1.0',
  protocolVersion: 8,
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validVec3: Vec3 = { x: 3, y: 1.5, z: 4 };

/** The identity rotation. A valid `Quat` need not be normalised, but this one is. */
export const validQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const validTransform: Transform = { position: validVec3, rotation: validQuat };

export const validCellCoord: CellCoord = { x: 2, z: 3 };

export const validTileState: TileState = {
  cell: validCellCoord,
  terrain: 'grass',
};

/**
 * A flat 1x1 **walkable** ground patch centred at `(2.5, 0, 3.5)`. `axisU`/
 * `axisV` are half-edge vectors ordered so the plane normal
 * `cross(axisU, axisV)` points up (`+y`), which the geometric guard requires.
 */
export const validSurfaceState: SurfaceState = {
  surfaceId: parseSurfaceId('surface-1'),
  kind: 'ground',
  center: { x: 2.5, y: 0, z: 3.5 },
  axisU: { x: 0.5, y: 0, z: 0 },
  axisV: { x: 0, y: 0, z: -0.5 },
  walkable: true,
};

/**
 * A `2x2x2` water slab centred at `(2.5, 1, 3.5)` with a genuine finite `y`
 * range, expressed through the `'aabb'` `ColliderShape` variant.
 */
export const validColliderState: ColliderState = {
  colliderId: parseColliderId('collider-1'),
  kind: 'water',
  shape: {
    kind: 'aabb',
    min: { x: 1.5, y: 0, z: 2.5 },
    max: { x: 3.5, y: 2, z: 4.5 },
  },
};

export const validEntityState: EntityState = {
  entityId: parseEntityId('entity-1'),
  actorId: parseActorId('actor-1'),
  kind: 'character',
  transform: validTransform,
  visible: true,
};

export const validWorldBounds: WorldBounds = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 20, y: 1, z: 15 },
};

export const validGridSpec: GridSpec = {
  origin: { x: 0, y: 0, z: 0 },
  width: 20,
  depth: 15,
  cellSize: 1,
};

export const validWorldSnapshot: WorldSnapshot = {
  worldId: parseWorldId('world-1'),
  bounds: validWorldBounds,
  grid: validGridSpec,
  tiles: [validTileState],
  surfaces: [validSurfaceState],
  colliders: [validColliderState],
  entities: [validEntityState],
  controlledActorId: parseActorId('actor-1'),
  serverTime: '2025-01-02T03:04:05.000Z',
};

/**
 * The phase-7 snapshot shape: `WorldBounds`/`GridSpec`/position-free
 * `TileState`, but **no** `surfaces`/`colliders` world-geometry layer. Used to
 * prove the 7 -> 8 break (real 3D surfaces and `y`-ranged colliders) is enforced
 * by the exact-key guards.
 */
export const phase7WorldSnapshot = {
  worldId: 'world-1',
  bounds: validWorldBounds,
  grid: validGridSpec,
  tiles: [validTileState],
  entities: [validEntityState],
  controlledActorId: 'actor-1',
  serverTime: '2025-01-02T03:04:05.000Z',
};

/**
 * The phase-6 snapshot shape: a 2D integer `Transform`, `size: WorldSize`, and
 * `TileState.transform`. Used to prove the 6 -> 7 break (a real 3D transform, a
 * `WorldBounds`/`GridSpec`, and a position-free `TileState`) is enforced by the
 * exact-key guards.
 */
export const phase6WorldSnapshot = {
  worldId: 'world-1',
  size: { width: 20, height: 15 },
  tiles: [{ transform: { x: 2, y: 3 }, terrain: 'grass' }],
  entities: [validEntityState],
  controlledActorId: 'actor-1',
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validMoveIntentCommand: MoveIntentCommand = {
  type: 'actor.moveIntent',
  movement: { x: 1, z: 0 },
};

export const validMoveToCommand: MoveToCommand = {
  type: 'actor.moveTo',
  target: { x: 4.5, y: 0, z: -2.25 },
};

export const validInteractCommand: InteractCommand = {
  type: 'actor.interact',
  targetEntityId: parseEntityId('entity-1'),
};

export const validEntitySpawnedEvent: EntitySpawnedEvent = {
  type: 'entity.spawned',
  entity: validEntityState,
};

export const validEntityRemovedEvent: EntityRemovedEvent = {
  type: 'entity.removed',
  entityId: parseEntityId('entity-1'),
};

export const validTransformChangedEvent: TransformChangedEvent = {
  type: 'transform.changed',
  entityId: parseEntityId('entity-1'),
  transform: validTransform,
};

export const validGameEventBatch: GameEventBatch = {
  events: [validTransformChangedEvent],
  serverTime: validWorldSnapshot.serverTime,
};

/** The leading stream frame: the full snapshot, sent first on every connection. */
export const validSnapshotStreamMessage: Extract<WorldStreamMessage, { type: 'snapshot' }> = {
  type: 'snapshot',
  snapshot: validWorldSnapshot,
};

export const validEventsStreamMessage: Extract<WorldStreamMessage, { type: 'events' }> = {
  type: 'events',
  batch: validGameEventBatch,
};
