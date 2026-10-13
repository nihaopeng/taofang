import { describe, expect, it } from 'vitest';

import type { EntityState } from '@starvalley/protocol';
import { parseEntityId } from '@starvalley/protocol';
import { QUAT_IDENTITY } from '@starvalley/math';

import {
  DEFAULT_BLOCK_GRID,
  columnSupportTop,
  createBlockStore,
  createDefaultBlocks,
  createDefaultEntities,
  entityDefinition,
  extentsForYaw,
  footprintColumns,
  yawStepFromRotation,
} from '../src/index.ts';
import { block, flatBlocks, makeManager } from './helpers.ts';

/** A placeable entity authored at an explicit base position. */
function authored(
  id: string,
  kind: EntityState['kind'],
  x: number,
  y: number,
  z: number,
): EntityState {
  return {
    entityId: parseEntityId(id),
    actorId: null,
    kind,
    transform: { position: { x, y, z }, rotation: { ...QUAT_IDENTITY } },
    visible: true,
  };
}

describe('default authored world', () => {
  it('seats every authored placeable entity exactly on its support top', () => {
    const store = createBlockStore(DEFAULT_BLOCK_GRID, createDefaultBlocks());
    for (const entity of createDefaultEntities()) {
      const placement = entityDefinition(entity.kind).placement;
      if (placement === undefined) {
        throw new Error(`${entity.kind} is not placeable`);
      }
      const yaw = yawStepFromRotation(entity.transform.rotation);
      const extents = extentsForYaw(placement.footprint, yaw);
      const columns = footprintColumns(DEFAULT_BLOCK_GRID, entity.transform.position, extents);
      for (const column of columns) {
        const top = columnSupportTop(
          DEFAULT_BLOCK_GRID,
          store,
          column.x,
          column.z,
          entity.transform.position.y,
          DEFAULT_BLOCK_GRID.origin.y - 1,
        );
        expect(top, `${entity.entityId} cell (${column.x}, ${column.z})`).not.toBeNull();
        expect(top, `${entity.entityId} cell (${column.x}, ${column.z})`).toBeCloseTo(
          entity.transform.position.y,
          9,
        );
      }
    }
  });

  it('authors the slab tree at the slab top face (1.5), not a cell boundary (2.0)', () => {
    const tree = createDefaultEntities().find((entity) => entity.entityId === 'tree-1');
    if (tree === undefined) {
      throw new Error('tree-1 is missing');
    }
    expect(tree.transform.position.y).toBe(1.5);
  });
});

describe('authored placeable construction guard', () => {
  it('throws when an authored entity floats above its support', () => {
    expect(() =>
      makeManager({
        blocks: flatBlocks(8, 8),
        entities: [authored('tree-1', 'tree', 3.5, 2, 3.5)],
        spawnCell: { x: 1, z: 1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      makeManager({
        blocks: flatBlocks(8, 8),
        entities: [authored('tree-1', 'tree', 3.5, 2, 3.5)],
        spawnCell: { x: 1, z: 1 },
      }),
    ).toThrow(/support/i);
  });

  it('throws when an authored entity overlaps a solid block', () => {
    const blocks = [...flatBlocks(8, 8), block(1, 1, 1, 'stone')];
    expect(() =>
      makeManager({
        blocks,
        entities: [authored('tree-1', 'tree', 1.5, 1, 1.5)],
        spawnCell: { x: 4, z: 4 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      makeManager({
        blocks,
        entities: [authored('tree-1', 'tree', 1.5, 1, 1.5)],
        spawnCell: { x: 4, z: 4 },
      }),
    ).toThrow(/overlaps/i);
  });

  it('throws when an authored entity body intersects a solid block (bridge deck)', () => {
    const blocks = [...flatBlocks(8, 8)];
    for (let x = 1; x <= 6; x += 1) {
      blocks.push(block(x, 3, 3, 'stone'));
    }
    expect(() =>
      makeManager({
        blocks,
        entities: [authored('tree-1', 'tree', 3.5, 1, 3.5)],
        spawnCell: { x: 1, z: 1 },
      }),
    ).toThrow(/overlaps/i);
  });

  it('accepts a valid authored entity seated on the ground', () => {
    expect(() =>
      makeManager({
        blocks: flatBlocks(8, 8),
        entities: [authored('tree-1', 'tree', 3.5, 1, 3.5)],
        spawnCell: { x: 1, z: 1 },
      }),
    ).not.toThrow();
  });
});
