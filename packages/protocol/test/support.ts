import {
  ProtocolParseError,
  parseActorId,
  parseEntityId,
  parseWorldId,
} from '../src/index.ts';
import type {
  ActorJumpCommand,
  BlockChangedEvent,
  BlockGrid,
  BlockKindInfo,
  BlockRemoveCommand,
  BlockSetCommand,
  BlockState,
  CellCoord,
  CommandResponse,
  EntityKindInfo,
  EntityPlaceCommand,
  EntityRemoveCommand,
  EntityRemovedEvent,
  EntityRotateCommand,
  EntitySpawnedEvent,
  EntityState,
  EntityValidatePlacementCommand,
  GameEventBatch,
  GetGameInfoResponse,
  InteractCommand,
  MoveIntentCommand,
  MoveToCommand,
  Quat,
  Transform,
  TransformChangedEvent,
  ValidatePlacementResponse,
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
  protocolVersion: 9,
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validVec3: Vec3 = { x: 3, y: 1.5, z: 4 };

/** The identity rotation. A valid `Quat` need not be normalised, but this one is. */
export const validQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const validTransform: Transform = { position: validVec3, rotation: validQuat };

/** The block grid's pure configuration; a non-1 `cellSize` is exercised in tests. */
export const validBlockGrid: BlockGrid = {
  origin: { x: 0, y: 0, z: 0 },
  cellSize: 1,
};

/** A 3D integer cell: all three axes, not the old 2D `{ x, z }`. */
export const validCellCoord: CellCoord = { x: 2, y: 0, z: 3 };

export const validBlockState: BlockState = {
  coord: validCellCoord,
  kind: 'grass',
  orientation: 0,
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
  max: { x: 20, y: 16, z: 15 },
};

export const validWorldSnapshot: WorldSnapshot = {
  worldId: parseWorldId('world-1'),
  bounds: validWorldBounds,
  blockGrid: validBlockGrid,
  blocks: [validBlockState],
  entities: [validEntityState],
  controlledActorId: parseActorId('actor-1'),
  serverTime: '2025-01-02T03:04:05.000Z',
};

/**
 * The v8 (phase-14) snapshot shape: a `GridSpec`, position-free 2D `TileState`,
 * and the `surfaces`/`colliders` world-geometry layer. Used to prove the
 * 8 -> 9 break (block-spatial kernel) is enforced by the exact-key guards.
 */
export const v8WorldSnapshot = {
  worldId: 'world-1',
  bounds: validWorldBounds,
  grid: { origin: { x: 0, y: 0, z: 0 }, width: 20, depth: 15, cellSize: 1 },
  tiles: [{ cell: { x: 2, z: 3 }, terrain: 'grass' }],
  surfaces: [
    {
      surfaceId: 'surface-1',
      kind: 'ground',
      center: { x: 2.5, y: 0, z: 3.5 },
      axisU: { x: 0.5, y: 0, z: 0 },
      axisV: { x: 0, y: 0, z: -0.5 },
      walkable: true,
    },
  ],
  colliders: [
    {
      colliderId: 'collider-1',
      kind: 'water',
      shape: { kind: 'aabb', min: { x: 1.5, y: 0, z: 2.5 }, max: { x: 3.5, y: 2, z: 4.5 } },
    },
  ],
  entities: [validEntityState],
  controlledActorId: 'actor-1',
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validBlockKindInfo: BlockKindInfo = { kind: 'grass', orientable: false };

export const validEntityKindInfo: EntityKindInfo = {
  kind: 'character',
  footprintX: 1,
  footprintZ: 1,
  height: 1.8,
  allowedYawSteps: [0, 90, 180, 270],
  pivot: 'center',
};

export const validGetGameInfoResponse: GetGameInfoResponse = {
  gameInfo: validGameInfo,
  blockKinds: [validBlockKindInfo],
  entityKinds: [validEntityKindInfo],
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

export const validActorJumpCommand: ActorJumpCommand = { type: 'actor.jump' };

export const validBlockSetCommand: BlockSetCommand = {
  type: 'block.set',
  coord: { x: 2, y: 0, z: 3 },
  kind: 'stone',
  orientation: 90,
};

export const validBlockRemoveCommand: BlockRemoveCommand = {
  type: 'block.remove',
  coord: { x: 2, y: 0, z: 3 },
};

export const validEntityPlaceCommand: EntityPlaceCommand = {
  type: 'entity.place',
  kind: 'tree',
  position: { x: 2.5, y: 0, z: 3.5 },
  yawDegrees: 0,
};

export const validEntityRotateCommand: EntityRotateCommand = {
  type: 'entity.rotate',
  entityId: parseEntityId('entity-1'),
  yawDegrees: 180,
};

export const validEntityRemoveCommand: EntityRemoveCommand = {
  type: 'entity.remove',
  entityId: parseEntityId('entity-1'),
};

export const validEntityValidatePlacementCommand: EntityValidatePlacementCommand = {
  type: 'entity.validatePlacement',
  kind: 'chest',
  position: { x: 2.5, y: 0, z: 3.5 },
  yawDegrees: 90,
};

export const validValidatePlacementResponse: ValidatePlacementResponse = {
  valid: true,
  reason: null,
  occupiedCells: [{ x: 2, y: 0, z: 3 }],
  resolvedTransform: validTransform,
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

export const validBlockChangedEvent: BlockChangedEvent = {
  type: 'block.changed',
  coord: { x: 2, y: 0, z: 3 },
  kind: 'stone',
  orientation: 0,
};

export const validGameEventBatch: GameEventBatch = {
  events: [validTransformChangedEvent],
  serverTime: validWorldSnapshot.serverTime,
};

/** The command endpoint's non-mutating success shape, for the `CommandResponse` guard. */
export const validCommandResponse: CommandResponse = validValidatePlacementResponse;

/** The leading stream frame: the full snapshot, sent first on every connection. */
export const validSnapshotStreamMessage: Extract<WorldStreamMessage, { type: 'snapshot' }> = {
  type: 'snapshot',
  snapshot: validWorldSnapshot,
};

export const validEventsStreamMessage: Extract<WorldStreamMessage, { type: 'events' }> = {
  type: 'events',
  batch: validGameEventBatch,
};
