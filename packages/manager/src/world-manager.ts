import type {
  ActorId,
  BlockGrid,
  BlockState,
  CellCoord,
  CommandResponse,
  EntityId,
  EntityKind,
  EntityState,
  GameCommand,
  GameEvent,
  GameEventBatch,
  Transform,
  ValidatePlacementResponse,
  Vec3,
  WorldBounds,
  WorldId,
  WorldSnapshot,
} from '@starvalley/protocol';
import {
  isBlockState,
  isEntityState,
  parseActorId,
  parseEntityId,
  parseWorldId,
} from '@starvalley/protocol';
import type { Quat } from '@starvalley/math';
import { QUAT_IDENTITY, clampXZToUnit, quatFromYaw } from '@starvalley/math';

import type { BlockStore } from './blocks.ts';
import { createBlockStore } from './blocks.ts';
import { DEFAULT_BLOCK_GRID, createDefaultBlocks, createDefaultEntities } from './default-world.ts';
import type { EntityDefinition } from './entities.ts';
import {
  DEFAULT_ACTOR_HEIGHT,
  DEFAULT_ACTOR_RADIUS,
  ENTITY_DEFINITIONS,
  entityDefinition,
} from './entities.ts';
import type { MovementCollider } from './movement.ts';
import {
  JUMP_SPEED,
  actorCanOccupy,
  stepMovement,
  supportTopUnderActor,
} from './movement.ts';
import type { OccupancyIndex, PlacementRejectionReason } from './placement.ts';
import {
  assertAuthoredPlaceable,
  createOccupancyIndex,
  deriveOccupiedCells,
  resolvePlacement,
} from './placement.ts';

/** Fixed-step simulation rate. `step(dtMs)` is authoritative; timers live outside. */
export const TICK_RATE_HZ = 20;

/** Default actor speed, in world units per second (at movement magnitude 1). */
export const DEFAULT_ACTOR_SPEED = 3;

/**
 * Interaction reach, measured on the ground plane (XZ); height is ignored.
 */
export const INTERACTION_RANGE = 1.5;

const DEFAULT_WORLD_ID: WorldId = parseWorldId('world-1');
const DEFAULT_ACTOR_ID: ActorId = parseActorId('actor-1');

/**
 * Whether the actor can interact with a kind. Manager runtime rule, not on the
 * wire. Total over `EntityKind`.
 */
export const INTERACTABLE_BY_ENTITY_KIND: Record<EntityKind, boolean> = {
  character: false,
  tree: true,
  rock: true,
  chest: true,
  building: false,
};

/** Thrown when an operation names an actor the manager does not know about. */
export class UnknownActorError extends Error {
  readonly actorId: ActorId;
  constructor(actorId: ActorId) {
    super(`Unknown actor: ${actorId}`);
    this.name = 'UnknownActorError';
    this.actorId = actorId;
  }
}

/** Thrown when an operation names an entity the manager does not know about. */
export class UnknownEntityError extends Error {
  readonly entityId: EntityId;
  constructor(entityId: EntityId) {
    super(`Unknown entity: ${entityId}`);
    this.name = 'UnknownEntityError';
    this.entityId = entityId;
  }
}

/** Why an interaction was refused even though the request itself was valid. */
export type InteractionRejectionReason = 'out-of-range' | 'not-interactable';

/** Thrown when an interaction is well-formed but illegal against current state. */
export class InteractionRejectedError extends Error {
  readonly entityId: EntityId;
  readonly reason: InteractionRejectionReason;
  constructor(entityId: EntityId, reason: InteractionRejectionReason) {
    super(`Interaction with ${entityId} rejected: ${reason}`);
    this.name = 'InteractionRejectedError';
    this.entityId = entityId;
    this.reason = reason;
  }
}

/**
 * Thrown when an `entity.place` / `entity.rotate` resolves to a placement the
 * server refuses. Transport maps this to `CONFLICT` (409); the discriminator is
 * surfaced verbatim.
 */
export class PlacementRejectedError extends Error {
  readonly kind: EntityKind;
  readonly reason: PlacementRejectionReason;
  constructor(kind: EntityKind, reason: PlacementRejectionReason) {
    super(`Placement of ${kind} rejected: ${reason}`);
    this.name = 'PlacementRejectedError';
    this.kind = kind;
    this.reason = reason;
  }
}

type MovementMode =
  | { readonly kind: 'direction'; readonly movement: { readonly x: number; readonly z: number } }
  | { readonly kind: 'moveTo'; readonly target: Vec3 };

/**
 * Read-only, transport-neutral access to the authoritative world.
 *
 * Identity is typed input on every operation; commands carry no actor field.
 */
export interface WorldManager {
  /** Point-in-time authoritative v9 snapshot. Always a fresh object graph. */
  getSnapshot(input: { actorId: ActorId }): WorldSnapshot;
  /**
   * Apply a command for `input.actorId`.
   *
   * Movement/jump intents set the actor's movement state and return an empty
   * event batch (movement is emitted by {@link step}). Mutating world commands
   * return a `GameEventBatch`. `entity.validatePlacement` is a pure query and
   * returns a `ValidatePlacementResponse` (it never mutates).
   */
  submitIntent(input: { actorId: ActorId; command: GameCommand }): CommandResponse;
  /** Advance the simulation by `dtMs`. Pure/deterministic; emits movement deltas. */
  step(dtMs: number): GameEventBatch;
  /**
   * Server-only introspection: the live placement-occupancy index (never wire
   * data). Exposed so the derived index can be audited against
   * `rebuildOccupancyFromEntities`.
   */
  getOccupancy(): Array<{ cell: CellCoord; entityIds: EntityId[] }>;
}

/** Construction-time dependencies for {@link createWorldManager}. */
export interface CreateWorldManagerDeps {
  worldId?: WorldId;
  /** Grid overrides. `cellSize` is never assumed to be 1. */
  grid?: Partial<BlockGrid>;
  bounds?: WorldBounds;
  actorId?: ActorId;
  actorSpeed?: number;
  actorRadius?: number;
  actorHeight?: number;
  /** Replace the authored blocks entirely (Manager authoring/test seam). */
  blocks?: readonly BlockState[];
  /** Replace the authored placeable entities entirely (Manager authoring/test seam). */
  entities?: readonly EntityState[];
  /** Requested spawn cell. Defaults to the centre of the block bounding box. */
  spawnCell?: { readonly x: number; readonly z: number };
  /**
   * Explicit spawn feet position (authoring/test seam). When given, it is used
   * verbatim after validating that it is free and supported; this is how a
   * test can spawn UNDER a bridge rather than on the highest support.
   */
  spawnPosition?: Vec3;
  clock?: () => Date;
}

function copyVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function copyQuat(value: Quat): Quat {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function copyTransform(value: Transform): Transform {
  return { position: copyVec3(value.position), rotation: copyQuat(value.rotation) };
}

function copyEntity(entity: EntityState): EntityState {
  return {
    entityId: entity.entityId,
    actorId: entity.actorId,
    kind: entity.kind,
    transform: copyTransform(entity.transform),
    visible: entity.visible,
  };
}

/** Ground-plane (XZ) distance; `y` is ignored. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isFiniteVec3(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function sameTransform(a: Transform, b: Transform): boolean {
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.position.z === b.position.z &&
    a.rotation.x === b.rotation.x &&
    a.rotation.y === b.rotation.y &&
    a.rotation.z === b.rotation.z &&
    a.rotation.w === b.rotation.w
  );
}

interface CellColumn {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function cellBounds(blocks: readonly BlockState[]): CellColumn {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    minX = Math.min(minX, block.coord.x);
    maxX = Math.max(maxX, block.coord.x);
    minY = Math.min(minY, block.coord.y);
    maxY = Math.max(maxY, block.coord.y);
    minZ = Math.min(minZ, block.coord.z);
    maxZ = Math.max(maxZ, block.coord.z);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Deterministic cells at Chebyshev distance `ring` from `(cx, cz)`. */
function ringCells(
  centre: { readonly x: number; readonly z: number },
  ring: number,
): Array<{ readonly x: number; readonly z: number }> {
  if (ring === 0) {
    return [{ x: centre.x, z: centre.z }];
  }
  const cells: Array<{ x: number; z: number }> = [];
  for (let dx = -ring; dx <= ring; dx += 1) {
    for (let dz = -ring; dz <= ring; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) {
        continue;
      }
      cells.push({ x: centre.x + dx, z: centre.z + dz });
    }
  }
  return cells;
}

/**
 * Create the authoritative block-spatial `WorldManager`.
 *
 * Pure, synchronous, in-memory: no I/O, no transport, no persistence. The
 * world is a sparse block store plus a placement/occupancy index; entities are
 * continuous transforms. Movement is the unified shape-based solver.
 */
export function createWorldManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  const worldId = deps.worldId ?? DEFAULT_WORLD_ID;
  const cellSize = deps.grid?.cellSize ?? DEFAULT_BLOCK_GRID.cellSize;
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new RangeError(`Grid cellSize must be a positive finite number, received ${cellSize}`);
  }
  const origin = deps.grid?.origin ?? DEFAULT_BLOCK_GRID.origin;
  if (!isFiniteVec3(origin)) {
    throw new RangeError('Grid origin must be a finite Vec3');
  }
  const grid: BlockGrid = { origin: copyVec3(origin), cellSize };

  const rawBlocks = deps.blocks ?? createDefaultBlocks();
  const seenCells = new Set<string>();
  for (const block of rawBlocks) {
    if (!isBlockState(block)) {
      throw new RangeError('Invalid block override');
    }
    if (block.kind === 'air') {
      throw new RangeError('The block store is sparse: air must be omitted, never stored');
    }
    const key = `${block.coord.x}|${block.coord.y}|${block.coord.z}`;
    if (seenCells.has(key)) {
      throw new RangeError(`Duplicate block at ${key}`);
    }
    seenCells.add(key);
  }
  if (rawBlocks.length === 0) {
    throw new RangeError('World must contain at least one non-air block');
  }
  const store: BlockStore = createBlockStore(grid, rawBlocks);

  const blockColumn = cellBounds(rawBlocks);
  const defaultBounds: WorldBounds = {
    min: {
      x: grid.origin.x + (blockColumn.minX - 1) * cellSize,
      y: grid.origin.y + (blockColumn.minY - 1) * cellSize,
      z: grid.origin.z + (blockColumn.minZ - 1) * cellSize,
    },
    max: {
      x: grid.origin.x + (blockColumn.maxX + 2) * cellSize,
      y: grid.origin.y + (blockColumn.maxY + 2) * cellSize,
      z: grid.origin.z + (blockColumn.maxZ + 2) * cellSize,
    },
  };
  const bounds: WorldBounds = deps.bounds ?? defaultBounds;
  if (!isFiniteVec3(bounds.min) || !isFiniteVec3(bounds.max)) {
    throw new RangeError('World bounds must be finite Vec3 corners');
  }
  if (!(bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y && bounds.min.z < bounds.max.z)) {
    throw new RangeError('World bounds must satisfy min < max on every axis');
  }

  const actorSpeed = deps.actorSpeed ?? DEFAULT_ACTOR_SPEED;
  if (!Number.isFinite(actorSpeed) || actorSpeed <= 0) {
    throw new RangeError(`Actor speed must be a positive finite number, received ${actorSpeed}`);
  }
  const actorRadius = deps.actorRadius ?? DEFAULT_ACTOR_RADIUS;
  if (!Number.isFinite(actorRadius) || actorRadius <= 0 || actorRadius * 2 >= bounds.max.x - bounds.min.x) {
    throw new RangeError(`Invalid actor radius: ${actorRadius}`);
  }
  const actorHeight = deps.actorHeight ?? DEFAULT_ACTOR_HEIGHT;
  if (!Number.isFinite(actorHeight) || actorHeight <= 0) {
    throw new RangeError(`Invalid actor height: ${actorHeight}`);
  }

  const actorId = deps.actorId ?? DEFAULT_ACTOR_ID;
  const actorEntityId: EntityId = parseEntityId('actor-entity-1');
  const clock = deps.clock ?? ((): Date => new Date());

  // Placeable entities live in a map keyed by id; the actor is separate state.
  const placeables = new Map<EntityId, EntityState>();
  // The authored default entities belong with the authored default blocks. If
  // `blocks` is overridden, the world is fully caller-authored, so the default
  // entities (positioned for the default grid) must not leak into it; callers
  // that want placeables in a custom block world pass `entities` explicitly.
  const rawEntities =
    deps.entities ?? (deps.blocks !== undefined ? [] : createDefaultEntities());
  for (const entity of rawEntities) {
    if (!isEntityState(entity)) {
      throw new RangeError('Invalid entity override');
    }
    const definition = ENTITY_DEFINITIONS[entity.kind];
    if (definition.placement === undefined) {
      throw new RangeError(`Entity ${entity.entityId} is not placeable`);
    }
    placeables.set(entity.entityId, copyEntity(entity));
  }

  const occupancy: OccupancyIndex = createOccupancyIndex();
  for (const entity of placeables.values()) {
    const definition = entityDefinition(entity.kind);
    const placement = definition.placement;
    if (placement === undefined) {
      continue;
    }
    // Authored placeables get the same support/clearance rules the resolver
    // enforces on placement; a bad authored layout fails loudly here instead
    // of shipping a floating or embedded entity.
    assertAuthoredPlaceable({
      entity,
      definition,
      grid,
      blocks: store,
      occupancy,
      minY: bounds.min.y,
    });
    occupancy.add(entity.entityId, deriveOccupiedCells(entity.transform, placement, grid));
  }

  /** Entity colliders for the movement solver; excludes the dynamic actor. */
  const placeableColliders = (): MovementCollider[] =>
    [...placeables.values()]
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
      .map((entity) => ({
        collider: entityDefinition(entity.kind).collider,
        position: copyVec3(entity.transform.position),
      }));

  // Spawn search: the requested/default cell first, then an expanding ring.
  const startCell =
    deps.spawnCell ??
    {
      x: Math.floor((blockColumn.minX + blockColumn.maxX) / 2),
      z: Math.floor((blockColumn.minZ + blockColumn.maxZ) / 2),
    };
  let spawnPosition: Vec3 | null = null;
  if (deps.spawnPosition !== undefined) {
    const requested = deps.spawnPosition;
    if (!isFiniteVec3(requested)) {
      throw new RangeError('spawnPosition must be a finite Vec3');
    }
    const support = supportTopUnderActor(
      grid,
      bounds,
      store,
      requested.x,
      requested.z,
      requested.y,
      actorRadius,
    );
    if (
      support === null ||
      !actorCanOccupy(
        grid,
        bounds,
        store,
        placeableColliders(),
        requested.x,
        requested.z,
        requested.y,
        actorRadius,
        actorHeight,
      )
    ) {
      throw new RangeError('spawnPosition is not a legal, supported position');
    }
    spawnPosition = { x: requested.x, y: requested.y, z: requested.z };
  }
  for (let ring = 0; ring < 64 && spawnPosition === null; ring += 1) {
    for (const cell of ringCells(startCell, ring)) {
      const x = grid.origin.x + (cell.x + 0.5) * cellSize;
      const z = grid.origin.z + (cell.z + 0.5) * cellSize;
      const support = supportTopUnderActor(grid, bounds, store, x, z, bounds.max.y, actorRadius);
      if (support === null) {
        continue;
      }
      if (
        actorCanOccupy(
          grid,
          bounds,
          store,
          placeableColliders(),
          x,
          z,
          support,
          actorRadius,
          actorHeight,
        )
      ) {
        spawnPosition = { x, y: support, z };
        break;
      }
    }
  }
  if (spawnPosition === null) {
    throw new RangeError('Could not find a valid spawn position with support');
  }

  const transform: Transform = {
    position: copyVec3(spawnPosition),
    rotation: copyQuat(QUAT_IDENTITY),
  };
  let verticalVelocity = 0;
  let grounded = true;
  let movementMode: MovementMode | null = null;
  let nextPlaceableIndex = 1;

  const findEntity = (id: EntityId): EntityState | undefined => {
    if (id === actorEntityId) {
      return {
        entityId: actorEntityId,
        actorId,
        kind: 'character',
        transform: copyTransform(transform),
        visible: true,
      };
    }
    const entity = placeables.get(id);
    return entity === undefined ? undefined : copyEntity(entity);
  };

  const transformChangedEvent = (): GameEvent => ({
    type: 'transform.changed',
    entityId: actorEntityId,
    transform: copyTransform(transform),
  });

  const performInteract = (targetEntityId: EntityId, serverTime: string): GameEventBatch => {
    const target = findEntity(targetEntityId);
    if (target === undefined) {
      throw new UnknownEntityError(targetEntityId);
    }
    if (!INTERACTABLE_BY_ENTITY_KIND[target.kind]) {
      throw new InteractionRejectedError(targetEntityId, 'not-interactable');
    }
    if (distanceXZ(transform.position, target.transform.position) > INTERACTION_RANGE) {
      throw new InteractionRejectedError(targetEntityId, 'out-of-range');
    }
    movementMode = null;
    const deltaX = target.transform.position.x - transform.position.x;
    const deltaZ = target.transform.position.z - transform.position.z;
    transform.rotation = quatFromYaw(Math.atan2(deltaX, deltaZ));
    return { events: [transformChangedEvent()], serverTime };
  };

  const resolveForCommand = (
    definition: EntityDefinition,
    requestedPosition: Vec3,
    yawDegrees: number,
    ignoreEntityId?: EntityId,
  ) =>
    resolvePlacement({
      definition,
      requestedPosition,
      yawDegrees,
      grid,
      blocks: store,
      occupancy,
      ignoreEntityId,
      minY: bounds.min.y,
    });

  const placeEntity = (
    command: Extract<GameCommand, { type: 'entity.place' }>,
    serverTime: string,
  ): GameEventBatch => {
    const definition = entityDefinition(command.kind);
    const resolution = resolveForCommand(definition, command.position, command.yawDegrees);
    if (!resolution.ok) {
      throw new PlacementRejectedError(command.kind, resolution.reason);
    }
    while (placeables.has(parseEntityId(`entity-place-${nextPlaceableIndex}`))) {
      nextPlaceableIndex += 1;
    }
    const entityId = parseEntityId(`entity-place-${nextPlaceableIndex}`);
    nextPlaceableIndex += 1;
    const entity: EntityState = {
      entityId,
      actorId: null,
      kind: command.kind,
      transform: resolution.transform,
      visible: true,
    };
    placeables.set(entityId, entity);
    occupancy.add(entityId, resolution.occupiedCells);
    return {
      events: [{ type: 'entity.spawned', entity: copyEntity(entity) }],
      serverTime,
    };
  };

  const rotateEntity = (
    command: Extract<GameCommand, { type: 'entity.rotate' }>,
    serverTime: string,
  ): GameEventBatch => {
    const existing = placeables.get(command.entityId);
    if (existing === undefined) {
      throw new UnknownEntityError(command.entityId);
    }
    const resolution = resolveForCommand(
      entityDefinition(existing.kind),
      existing.transform.position,
      command.yawDegrees,
      existing.entityId,
    );
    if (!resolution.ok) {
      throw new PlacementRejectedError(existing.kind, resolution.reason);
    }
    const updated: EntityState = { ...existing, transform: resolution.transform };
    placeables.set(existing.entityId, updated);
    occupancy.remove(existing.entityId);
    occupancy.add(existing.entityId, resolution.occupiedCells);
    if (sameTransform(existing.transform, resolution.transform)) {
      return { events: [], serverTime };
    }
    return {
      events: [
        { type: 'transform.changed', entityId: existing.entityId, transform: copyTransform(resolution.transform) },
      ],
      serverTime,
    };
  };

  const removeEntity = (
    command: Extract<GameCommand, { type: 'entity.remove' }>,
    serverTime: string,
  ): GameEventBatch => {
    if (!placeables.has(command.entityId)) {
      throw new UnknownEntityError(command.entityId);
    }
    placeables.delete(command.entityId);
    occupancy.remove(command.entityId);
    return { events: [{ type: 'entity.removed', entityId: command.entityId }], serverTime };
  };

  const validatePlacement = (
    command: Extract<GameCommand, { type: 'entity.validatePlacement' }>,
  ): ValidatePlacementResponse => {
    const resolution = resolveForCommand(
      entityDefinition(command.kind),
      command.position,
      command.yawDegrees,
    );
    if (resolution.ok) {
      return {
        valid: true,
        reason: null,
        occupiedCells: resolution.occupiedCells.map((cell) => ({ ...cell })),
        resolvedTransform: copyTransform(resolution.transform),
      };
    }
    return {
      valid: false,
      reason: resolution.reason,
      occupiedCells: resolution.occupiedCells.map((cell) => ({ ...cell })),
      resolvedTransform: null,
    };
  };

  return {
    getSnapshot(input: { actorId: ActorId }): WorldSnapshot {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }
      const placeableList = [...placeables.values()]
        .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
        .map(copyEntity);
      return {
        worldId,
        bounds: { min: copyVec3(bounds.min), max: copyVec3(bounds.max) },
        blockGrid: { origin: copyVec3(grid.origin), cellSize: grid.cellSize },
        blocks: store.entries(),
        entities: [
          {
            entityId: actorEntityId,
            actorId,
            kind: 'character',
            transform: copyTransform(transform),
            visible: true,
          },
          ...placeableList,
        ],
        controlledActorId: actorId,
        serverTime: clock().toISOString(),
      };
    },

    submitIntent(input: { actorId: ActorId; command: GameCommand }): CommandResponse {
      if (input.actorId !== actorId) {
        throw new UnknownActorError(input.actorId);
      }
      const serverTime = clock().toISOString();
      const command = input.command;
      switch (command.type) {
        case 'actor.moveIntent': {
          const movement = clampXZToUnit({
            x: command.movement.x,
            y: 0,
            z: command.movement.z,
          });
          movementMode =
            movement.x === 0 && movement.z === 0
              ? null
              : { kind: 'direction', movement: { x: movement.x, z: movement.z } };
          return { events: [], serverTime };
        }
        case 'actor.moveTo': {
          movementMode = { kind: 'moveTo', target: copyVec3(command.target) };
          return { events: [], serverTime };
        }
        case 'actor.interact': {
          return performInteract(command.targetEntityId, serverTime);
        }
        case 'actor.jump': {
          if (!grounded) {
            return { events: [], serverTime };
          }
          verticalVelocity = -JUMP_SPEED;
          grounded = false;
          return { events: [], serverTime };
        }
        case 'block.set': {
          const event = store.set(command.coord, command.kind, command.orientation);
          return { events: [event], serverTime };
        }
        case 'block.remove': {
          const event = store.remove(command.coord);
          return { events: [event], serverTime };
        }
        case 'entity.place': {
          return placeEntity(command, serverTime);
        }
        case 'entity.rotate': {
          return rotateEntity(command, serverTime);
        }
        case 'entity.remove': {
          return removeEntity(command, serverTime);
        }
        case 'entity.validatePlacement': {
          return validatePlacement(command);
        }
        default: {
          const exhaustive: never = command;
          throw new Error(`Unhandled game command: ${String(exhaustive)}`);
        }
      }
    },

    step(dtMs: number): GameEventBatch {
      const serverTime = clock().toISOString();
      const mode = movementMode;
      if (!(dtMs > 0)) {
        return { events: [], serverTime };
      }
      const dtSeconds = dtMs / 1000;
      const stepDistance = actorSpeed * dtSeconds;

      const startX = transform.position.x;
      const startZ = transform.position.z;

      let displacementX = 0;
      let displacementZ = 0;
      let arrived = false;
      if (mode !== null) {
        if (mode.kind === 'direction') {
          displacementX = mode.movement.x * stepDistance;
          displacementZ = mode.movement.z * stepDistance;
        } else {
          const deltaX = mode.target.x - startX;
          const deltaZ = mode.target.z - startZ;
          const distance = Math.hypot(deltaX, deltaZ);
          if (distance <= stepDistance) {
            displacementX = deltaX;
            displacementZ = deltaZ;
            arrived = true;
          } else {
            displacementX = (deltaX / distance) * stepDistance;
            displacementZ = (deltaZ / distance) * stepDistance;
          }
        }
      }

      const result = stepMovement({
        grid,
        bounds,
        radius: actorRadius,
        height: actorHeight,
        position: transform.position,
        verticalVelocity,
        grounded,
        displacement: { x: displacementX, z: displacementZ },
        blocks: store,
        colliders: placeableColliders(),
        dtSeconds,
      });

      transform.position = copyVec3(result.position);
      verticalVelocity = result.verticalVelocity;
      grounded = result.grounded;

      if (!result.moved) {
        if (mode !== null && mode.kind === 'moveTo') {
          movementMode = null;
        }
        return { events: [], serverTime };
      }

      const deltaX = result.position.x - startX;
      const deltaZ = result.position.z - startZ;
      if (deltaX !== 0 || deltaZ !== 0) {
        transform.rotation = quatFromYaw(Math.atan2(deltaX, deltaZ));
      }
      if (arrived) {
        movementMode = null;
      }
      return { events: [transformChangedEvent()], serverTime };
    },

    getOccupancy(): Array<{ cell: CellCoord; entityIds: EntityId[] }> {
      return occupancy.cells().map((cell) => ({
        cell: { ...cell },
        entityIds: occupancy.entitiesAt(cell),
      }));
    },
  };
}
