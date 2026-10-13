import type {
  BlockGrid,
  BlockOrientation,
  BlockState,
  EntityState,
} from '@starvalley/protocol';
import { parseEntityId } from '@starvalley/protocol';
import { QUAT_IDENTITY } from '@starvalley/math';

import { supportHeightAt } from './blocks.ts';

/**
 * The default authored world's block grid. `cellSize` is configuration, never
 * hardcoded by any algorithm; the authored world happens to use one world unit.
 * The origin places cell `(0, 0, 0)`'s low corner at `(-6, 0, -6)`, so a 12x12
 * play area spans `[-6, 6)` in X and Z with its ground at `y = 0`.
 */
export const DEFAULT_BLOCK_GRID: BlockGrid = {
  origin: { x: -6, y: 0, z: -6 },
  cellSize: 1,
};

const GRID_WIDTH = 12;
const GRID_DEPTH = 12;

/** Cell-centre X for a cell index on the default grid. */
function centreX(cellX: number): number {
  return DEFAULT_BLOCK_GRID.origin.x + (cellX + 0.5) * DEFAULT_BLOCK_GRID.cellSize;
}

/** Cell-centre Z for a cell index on the default grid. */
function centreZ(cellZ: number): number {
  return DEFAULT_BLOCK_GRID.origin.z + (cellZ + 0.5) * DEFAULT_BLOCK_GRID.cellSize;
}

/**
 * The world `y` of the support top face under an entity, at in-cell local
 * `(localX, localZ)` of the solid block it stands on.
 *
 * This is the SHAPE's own top at that point (a `slab`'s `0.5`, a `ramp`'s
 * height field), NOT the cell's top boundary. A placeable entity's base anchors
 * on the continuous support top face, so authoring it from this helper keeps the
 * entity seated on the real surface instead of floating above a half-height
 * block. It throws for a non-solid supporting block, which is an authoring bug.
 */
function supportTopAt(blockState: BlockState, localX: number, localZ: number): number {
  const localTop = supportHeightAt(blockState, localX, localZ);
  if (localTop === null) {
    throw new RangeError(
      `Default world authoring error: block ${blockState.kind} at ` +
        `(${blockState.coord.x}, ${blockState.coord.y}, ${blockState.coord.z}) is not solid`,
    );
  }
  const baseY =
    DEFAULT_BLOCK_GRID.origin.y + blockState.coord.y * DEFAULT_BLOCK_GRID.cellSize;
  return baseY + localTop * DEFAULT_BLOCK_GRID.cellSize;
}

function block(
  x: number,
  y: number,
  z: number,
  kind: BlockState['kind'],
  orientation: BlockOrientation = 0,
): BlockState {
  return { coord: { x, y, z }, kind, orientation };
}

/**
 * The default authored world as BLOCKS (no surfaces/colliders).
 *
 * Layout (cells, `y = 0` is the ground layer):
 *
 * - flat grass ground across the whole 12x12;
 * - a half `slab` on the ground at `(2, 1, 2)`;
 * - `water` (a NON-SOLID block) at `(1..2, 1, 3..4)`;
 * - an ascending `stairs` staircase at `z = 9` (risers of 0.5), with stone
 *   support beneath;
 * - a full `stone` cube barrier (top `y = 2`, too high to step) at `(7..10, 1, 4)`;
 * - a raised `stone` platform at `x = 8..10, z = 0..2` (top `y = 2`);
 * - a `stone` bridge deck at `(3..9, 3, 7)` (top `y = 4`) with pillars, and a
 *   two-block-high clearance beneath for the walkable under-passage, reached by
 *   a `ramp` run at `x = 3, z = 4..6`.
 *
 * The spawn (the centre of the block bounding box, cell `(5, 5)`) is on flat
 * ground, clear of every prop.
 */
export function createDefaultBlocks(): BlockState[] {
  const blocks: BlockState[] = [];

  for (let z = 0; z < GRID_DEPTH; z += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      blocks.push(block(x, 0, z, 'grass'));
    }
  }

  // A half slab and a non-solid water patch on the ground.
  blocks.push(block(2, 1, 2, 'slab'));
  blocks.push(block(1, 1, 3, 'water'));
  blocks.push(block(2, 1, 3, 'water'));
  blocks.push(block(1, 1, 4, 'water'));
  blocks.push(block(2, 1, 4, 'water'));

  // Ascending staircase (yaw 90 rises toward +X), 0.5 risers.
  blocks.push(block(4, 1, 9, 'stairs', 90));
  blocks.push(block(5, 2, 9, 'stairs', 90));
  blocks.push(block(6, 3, 9, 'stairs', 90));
  blocks.push(block(5, 1, 9, 'stone'));
  blocks.push(block(6, 1, 9, 'stone'));
  blocks.push(block(6, 2, 9, 'stone'));

  // A full cube barrier, one full cube above the ground (top y = 2).
  for (let x = 7; x <= 10; x += 1) {
    blocks.push(block(x, 1, 4, 'stone'));
  }

  // A raised platform, one full cube above the ground (top y = 2).
  for (let x = 8; x <= 10; x += 1) {
    for (let z = 0; z <= 2; z += 1) {
      blocks.push(block(x, 1, z, 'stone'));
    }
  }

  // A ramp run up to a bridge deck: ramps at y = 1..3 rising toward +Z.
  blocks.push(block(3, 1, 4, 'ramp', 0));
  blocks.push(block(3, 2, 5, 'ramp', 0));
  blocks.push(block(3, 3, 6, 'ramp', 0));

  // The bridge deck (top y = 4) and its two pillars. The span x = 4..8 has a
  // two-unit clearance above the ground, so an actor walks under it.
  for (let x = 3; x <= 9; x += 1) {
    blocks.push(block(x, 3, 7, 'stone'));
  }
  blocks.push(block(3, 1, 7, 'stone'));
  blocks.push(block(3, 2, 7, 'stone'));
  blocks.push(block(9, 1, 7, 'stone'));
  blocks.push(block(9, 2, 7, 'stone'));

  return blocks;
}

/**
 * The default authored placeable entities: a `tree` on the slab (base `y =
 * 1.5`, proving y is the continuous support top), a `rock`, a `chest`, and a
 * 2x2 `building` for the footprint/rotation path.
 */
export function createDefaultEntities(): EntityState[] {
  return [
    {
      entityId: parseEntityId('tree-1'),
      actorId: null,
      kind: 'tree',
      transform: {
        // The slab's top face is 1.5, not the cell boundary `cellTopY(1)` = 2.0.
        position: { x: centreX(2), y: supportTopAt(block(2, 1, 2, 'slab'), 0.5, 0.5), z: centreZ(2) },
        rotation: { ...QUAT_IDENTITY },
      },
      visible: true,
    },
    {
      entityId: parseEntityId('rock-1'),
      actorId: null,
      kind: 'rock',
      transform: {
        position: { x: centreX(1), y: supportTopAt(block(1, 0, 5, 'grass'), 0.5, 0.5), z: centreZ(5) },
        rotation: { ...QUAT_IDENTITY },
      },
      visible: true,
    },
    {
      entityId: parseEntityId('chest-1'),
      actorId: null,
      kind: 'chest',
      transform: {
        position: { x: centreX(2), y: supportTopAt(block(2, 0, 5, 'grass'), 0.5, 0.5), z: centreZ(5) },
        rotation: { ...QUAT_IDENTITY },
      },
      visible: true,
    },
    {
      entityId: parseEntityId('building-1'),
      actorId: null,
      kind: 'building',
      // Even 2x2 footprint snaps to a cell BOUNDARY (the centre of cells 9..10).
      transform: {
        position: {
          x: DEFAULT_BLOCK_GRID.origin.x + 10 * DEFAULT_BLOCK_GRID.cellSize,
          y: supportTopAt(block(9, 0, 9, 'grass'), 0.5, 0.5),
          z: DEFAULT_BLOCK_GRID.origin.z + 10 * DEFAULT_BLOCK_GRID.cellSize,
        },
        rotation: { ...QUAT_IDENTITY },
      },
      visible: true,
    },
  ];
}
