import { ProtocolParseError, parseActorId, parseEntityId, parseWorldId } from '../src/index.ts';
import type {
  CellCoord,
  EntityRemovedEvent,
  EntitySpawnedEvent,
  EntityState,
  GameEventBatch,
  GridSpec,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  Quat,
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
  protocolVersion: 7,
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
  entities: [validEntityState],
  controlledActorId: parseActorId('actor-1'),
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
