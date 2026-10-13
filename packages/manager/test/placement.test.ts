import { describe, expect, it } from 'vitest';

import type {
  BlockState,
  CellCoord,
  FootprintExtents,
} from '@starvalley/protocol';
import { QUAT_IDENTITY } from '@starvalley/math';

import type { EntityDefinition } from '../src/index.ts';
import {
  PlacementRejectedError,
  checkPlacementInvariants,
  createBlockStore,
  createOccupancyIndex,
  deriveOccupiedCells,
  entityDefinition,
  extentsForYaw,
  rebuildOccupancyFromEntities,
  resolvePlacement,
} from '../src/index.ts';
import { ACTOR_ID, block, flatBlocks, makeManager, move, snapshotOf, stepMany } from './helpers.ts';

const GRID = { origin: { x: 0, y: 0, z: 0 }, cellSize: 1 };

function ground(): BlockState[] {
  return flatBlocks(8, 8);
}

/** The flat ground plus a one-cube bridge deck row at `z = 3`, `y = 3`. */
function bridgeBlocks(): BlockState[] {
  const blocks = ground();
  for (let x = 1; x <= 6; x += 1) {
    blocks.push(block(x, 3, 3, 'stone'));
  }
  return blocks;
}

function store(blocks: readonly BlockState[] = ground()) {
  return createBlockStore(GRID, blocks);
}

/** A placeable definition with an arbitrary footprint/height. */
function def(footprint: FootprintExtents, height = 1): EntityDefinition {
  return {
    kind: 'building',
    collider: { type: 'aabb', halfExtents: { x: 1, y: 1, z: 1 } },
    placement: { footprint, height, allowedYawSteps: [0, 90, 180, 270] },
  };
}

function resolve(
  definition: EntityDefinition,
  position: { x: number; y: number; z: number },
  yawDegrees: number,
  blocks = store(),
) {
  return resolvePlacement({
    definition,
    requestedPosition: position,
    yawDegrees,
    grid: GRID,
    blocks,
    occupancy: createOccupancyIndex(),
    minY: -1,
  });
}

function assertResolved(result: ReturnType<typeof resolve>) {
  if (!result.ok) {
    throw new Error(`expected a resolved placement, got ${result.reason}`);
  }
  return result;
}

function cellSpan(cells: readonly CellCoord[]): { x: number; z: number } {
  const xs = new Set(cells.map((cell) => cell.x));
  const zs = new Set(cells.map((cell) => cell.z));
  return { x: xs.size, z: zs.size };
}

describe('placement resolver: rotation lattice', () => {
  it('leaves parity-preserving footprints (2x2, 2x4, 1x3) at the same position', () => {
    for (const footprint of [
      { x: 2, z: 2 },
      { x: 2, z: 4 },
      { x: 1, z: 3 },
    ]) {
      const base = assertResolved(
        resolve(def(footprint), { x: 2.5, y: 1, z: 3.5 }, 0),
      );
      const rotated = assertResolved(
        resolve(def(footprint), base.transform.position, 90),
      );
      expect(rotated.transform.position.x).toBeCloseTo(base.transform.position.x, 9);
      expect(rotated.transform.position.z).toBeCloseTo(base.transform.position.z, 9);
    }
  });

  it('shifts parity-changing footprints (1x2, 2x3) by exactly half a cell per axis', () => {
    for (const footprint of [
      { x: 1, z: 2 },
      { x: 2, z: 3 },
    ]) {
      const base = assertResolved(resolve(def(footprint), { x: 2.5, y: 1, z: 3 }, 0));
      const rotated = assertResolved(resolve(def(footprint), base.transform.position, 90));
      expect(Math.abs(rotated.transform.position.x - base.transform.position.x)).toBeCloseTo(
        0.5,
        9,
      );
      expect(Math.abs(rotated.transform.position.z - base.transform.position.z)).toBeCloseTo(
        0.5,
        9,
      );
    }
  });

  it('transposes the occupied footprint on rotation', () => {
    const base = assertResolved(resolve(def({ x: 1, z: 2 }), { x: 2.5, y: 1, z: 3 }, 0));
    expect(cellSpan(base.occupiedCells)).toEqual({ x: 1, z: 2 });
    const rotated = assertResolved(resolve(def({ x: 1, z: 2 }), base.transform.position, 90));
    expect(cellSpan(rotated.occupiedCells)).toEqual({ x: 2, z: 1 });
  });

  it('extentsForYaw swaps only on 90/270', () => {
    expect(extentsForYaw({ x: 2, z: 5 }, 0)).toEqual({ x: 2, z: 5 });
    expect(extentsForYaw({ x: 2, z: 5 }, 180)).toEqual({ x: 2, z: 5 });
    expect(extentsForYaw({ x: 2, z: 5 }, 90)).toEqual({ x: 5, z: 2 });
    expect(extentsForYaw({ x: 2, z: 5 }, 270)).toEqual({ x: 5, z: 2 });
  });
});

describe('placement resolver: y is the support top face', () => {
  it('seats a base on a 0.5 slab at y = 0.5', () => {
    const blocks = store([...ground(), block(2, 1, 2, 'slab')]);
    const result = assertResolved(
      resolve(def({ x: 1, z: 1 }), { x: 2.5, y: 1.0, z: 2.5 }, 0, blocks),
    );
    expect(result.transform.position.y).toBeCloseTo(1.5, 9);
  });

  it('requires every footprint column to be solid (no half-floating footprint)', () => {
    const blocks = ground().filter(
      (entry) => !(entry.coord.x === 2 && entry.coord.z === 2),
    );
    const result = resolve(def({ x: 2, z: 2 }), { x: 2, y: 1, z: 2 }, 0, store(blocks));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('insufficient-support');
  });

  it('rejects a non-placeable kind', () => {
    const definition: EntityDefinition = { kind: 'character', collider: { type: 'cylinder', radius: 0.35, height: 1.8 } };
    const result = resolve(definition, { x: 2.5, y: 1, z: 3.5 }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('not-placeable');
  });
});

describe('shared support+clearance rule (R1: one rule, one owner)', () => {
  it('flags a body intersecting a solid block and clears the same body on top', () => {
    const blocks = store(bridgeBlocks());
    const tree = entityDefinition('tree');
    const placement = tree.placement;
    if (placement === undefined) throw new Error('tree must be placeable');

    const under = checkPlacementInvariants({
      placement,
      collider: tree.collider,
      position: { x: 3.5, y: 1, z: 3.5 },
      yaw: 0,
      grid: GRID,
      blocks,
      minY: -1,
    });
    expect(under).toMatchObject({ kind: 'blocked' });

    const onTop = checkPlacementInvariants({
      placement,
      collider: tree.collider,
      position: { x: 3.5, y: 4, z: 3.5 },
      yaw: 0,
      grid: GRID,
      blocks,
      minY: -1,
    });
    expect(onTop).toBeNull();
  });

  it('resolver rejects a tree under the bridge deck with the new blocked reason', () => {
    const result = resolve(
      entityDefinition('tree'),
      { x: 3.5, y: 1, z: 3.5 },
      0,
      store(bridgeBlocks()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('blocked');
  });

  it('resolver still accepts the equivalent legal tree seated on the deck', () => {
    const result = resolve(
      entityDefinition('tree'),
      { x: 3.5, y: 4, z: 3.5 },
      0,
      store(bridgeBlocks()),
    );
    if (!result.ok) throw new Error(`expected resolved placement, got ${result.reason}`);
    expect(result.transform.position.y).toBeCloseTo(4, 9);
  });
});

describe('occupancy index', () => {
  it('deriveOccupiedCells applies the > 0.5 vertical extrusion rule', () => {
    const transform = {
      position: { x: 2.5, y: 1, z: 3.5 },
      rotation: { ...QUAT_IDENTITY },
    };
    // height 1.5 -> floor 1, remainder exactly 0.5 -> 1 layer.
    expect(deriveOccupiedCells(transform, { footprint: { x: 1, z: 1 }, height: 1.5, allowedYawSteps: [0] }, GRID)).toHaveLength(1);
    // height 2.5 -> 2 layers.
    expect(deriveOccupiedCells(transform, { footprint: { x: 1, z: 1 }, height: 2.5, allowedYawSteps: [0] }, GRID)).toHaveLength(2);
    // height 2.6 -> 3 layers (remainder 0.6 > 0.5).
    expect(deriveOccupiedCells(transform, { footprint: { x: 1, z: 1 }, height: 2.6, allowedYawSteps: [0] }, GRID)).toHaveLength(3);
  });

  it('rebuildOccupancyFromEntities reproduces the live index exactly', () => {
    const manager = makeManager({ blocks: ground(), spawnCell: { x: 1, z: 1 } });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'building', position: { x: 2, y: 1, z: 2 }, yawDegrees: 0 },
    });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'chest', position: { x: 6.5, y: 1, z: 6.5 }, yawDegrees: 0 },
    });
    // Rotate the building (2x2 -> 2x2, position unchanged) and remove the chest.
    const placeables = snapshotOf(manager).entities.filter((entity) => entity.kind !== 'character');
    const building = placeables.find((entity) => entity.kind === 'building');
    if (building === undefined) throw new Error('expected building');
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.rotate', entityId: building.entityId, yawDegrees: 90 },
    });
    const chest = placeables.find((entity) => entity.kind === 'chest');
    if (chest === undefined) throw new Error('expected chest');
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.remove', entityId: chest.entityId },
    });

    const live = manager.getOccupancy().map((entry) => entry.cell);
    const rebuilt = rebuildOccupancyFromEntities(
      snapshotOf(manager).entities,
      GRID,
    ).cells();
    expect(rebuilt).toEqual(live);
  });

  it('is untouched by dynamic actor movement', () => {
    const manager = makeManager({ blocks: ground(), spawnCell: { x: 6.5, z: 6.5 } });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'chest', position: { x: 6.5, y: 1, z: 6.5 }, yawDegrees: 0 },
    });
    const before = manager.getOccupancy();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0.5, z: 0.5 }) });
    stepMany(manager, 20);
    expect(manager.getOccupancy()).toEqual(before);
  });
});

describe('entity commands', () => {
  it('entity.place emits entity.spawned and validatePlacement mutates nothing', () => {
    const manager = makeManager({ blocks: ground(), spawnCell: { x: 1, z: 1 } });
    const before = snapshotOf(manager);
    const preview = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.validatePlacement', kind: 'building', position: { x: 2, y: 1, z: 2 }, yawDegrees: 0 },
    });
    const after = snapshotOf(manager);
    expect(after.blocks).toEqual(before.blocks);
    expect(after.entities).toEqual(before.entities);
    if ('valid' in preview) {
      expect(preview.valid).toBe(true);
      expect(preview.resolvedTransform).not.toBeNull();
      expect(preview.occupiedCells.length).toBe(12);
    } else {
      throw new Error('expected a validate-placement response');
    }

    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'building', position: { x: 2, y: 1, z: 2 }, yawDegrees: 0 },
    });
    if (!('events' in response)) throw new Error('expected a batch');
    expect(response.events[0]).toMatchObject({ type: 'entity.spawned' });
  });

  it('a stale preview cannot place: place re-validates and rejects an occupied footprint', () => {
    const manager = makeManager({ blocks: ground(), spawnCell: { x: 1, z: 1 } });
    const preview = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.validatePlacement', kind: 'chest', position: { x: 4.5, y: 1, z: 4.5 }, yawDegrees: 0 },
    });
    if (!('valid' in preview) || !preview.valid) throw new Error('expected valid preview');
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'chest', position: { x: 4.5, y: 1, z: 4.5 }, yawDegrees: 0 },
    });
    expect(() =>
      manager.submitIntent({
        actorId: ACTOR_ID,
        command: { type: 'entity.place', kind: 'chest', position: { x: 4.5, y: 1, z: 4.5 }, yawDegrees: 0 },
      }),
    ).toThrow(PlacementRejectedError);
  });

  it('entity.rotate commits rotation and position atomically and emits transform.changed', () => {
    const manager = makeManager({ blocks: ground(), spawnCell: { x: 1, z: 1 } });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.place', kind: 'building', position: { x: 2, y: 1, z: 2 }, yawDegrees: 0 },
    });
    const building = snapshotOf(manager).entities.find((entity) => entity.kind === 'building');
    if (building === undefined) throw new Error('expected building');
    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'entity.rotate', entityId: building.entityId, yawDegrees: 90 },
    });
    if (!('events' in response)) throw new Error('expected a batch');
    expect(response.events[0]).toMatchObject({ type: 'transform.changed', entityId: building.entityId });
  });
});
