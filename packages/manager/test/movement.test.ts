import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ACTOR_HEIGHT,
  DEFAULT_ACTOR_RADIUS,
  MAX_STEP_HEIGHT,
} from '../src/index.ts';
import {
  ACTOR_ID,
  actorOf,
  block,
  flatBlocks,
  makeManager,
  move,
  moveTo,
  snapshotOf,
  stepMany,
} from './helpers.ts';
import { createWorldManager } from '../src/index.ts';

function bridgeBlocks(): ReturnType<typeof flatBlocks> {
  const blocks = flatBlocks(8, 8);
  for (let x = 1; x <= 6; x += 1) {
    blocks.push(block(x, 3, 3, 'stone'));
  }
  return blocks;
}

/**
 * True when the actor's body AABB overlaps a solid block CELL. This enumerates
 * every cell the body occupies (not just the destination point), with a tiny
 * inset so an exact face-touch is not reported as penetration.
 */
function actorOverlapsSolid(manager: ReturnType<typeof makeManager>): boolean {
  const snapshot = snapshotOf(manager);
  const actor = actorOf(manager).transform.position;
  const { origin, cellSize } = snapshot.blockGrid;
  const inset = 1e-6;
  const minX = actor.x - DEFAULT_ACTOR_RADIUS + inset;
  const maxX = actor.x + DEFAULT_ACTOR_RADIUS - inset;
  const minY = actor.y + inset;
  const maxY = actor.y + DEFAULT_ACTOR_HEIGHT - inset;
  const minZ = actor.z - DEFAULT_ACTOR_RADIUS + inset;
  const maxZ = actor.z + DEFAULT_ACTOR_RADIUS - inset;
  const x0 = Math.floor((minX - origin.x) / cellSize);
  const x1 = Math.floor((maxX - origin.x) / cellSize);
  const y0 = Math.floor((minY - origin.y) / cellSize);
  const y1 = Math.floor((maxY - origin.y) / cellSize);
  const z0 = Math.floor((minZ - origin.z) / cellSize);
  const z1 = Math.floor((maxZ - origin.z) / cellSize);
  for (const entry of snapshot.blocks) {
    if (entry.coord.x < x0 || entry.coord.x > x1) continue;
    if (entry.coord.y < y0 || entry.coord.y > y1) continue;
    if (entry.coord.z < z0 || entry.coord.z > z1) continue;
    if (entry.kind === 'water') continue;
    return true;
  }
  return false;
}

describe('movement: horizontal', () => {
  it('walks on flat ground at the block top (y = 1)', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 10);
    const actor = actorOf(manager);
    expect(actor.transform.position.y).toBeCloseTo(1, 9);
    expect(actor.transform.position.x).toBeGreaterThan(2.5);
  });

  it('auto-steps up a 0.5 slab (<= maxStepHeight)', () => {
    const manager = makeManager({
      blocks: [...flatBlocks(8, 8), block(3, 1, 1, 'slab')],
      spawnCell: { x: 1, z: 1 },
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 3.5, y: 1.5, z: 1.5 }) });
    stepMany(manager, 40);
    const actor = actorOf(manager);
    expect(actor.transform.position.x).toBeCloseTo(3.5, 6);
    expect(actor.transform.position.y).toBeCloseTo(1.5, 6);
  });

  it('is blocked by a full cube (1.0 > maxStepHeight)', () => {
    const manager = makeManager({
      blocks: [...flatBlocks(8, 8), block(3, 1, 1, 'stone')],
      spawnCell: { x: 1, z: 1 },
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 40);
    const actor = actorOf(manager);
    expect(actor.transform.position.y).toBeCloseTo(1, 9);
    expect(actor.transform.position.x).toBeLessThan(3 - 0.35 + 1e-6);
    expect(MAX_STEP_HEIGHT).toBeLessThan(1);
  });

  it('behaves identically on two kinds that share the cube shape (kind-agnostic)', () => {
    const build = (kind: 'grass' | 'stone') =>
      makeManager({ blocks: flatBlocks(8, 8, kind), spawnCell: { x: 1, z: 1 } });
    const grass = build('grass');
    const stone = build('stone');
    grass.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stone.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    for (let i = 0; i < 20; i += 1) {
      grass.step(50);
      stone.step(50);
    }
    expect(actorOf(grass).transform).toEqual(actorOf(stone).transform);
  });
});

describe('movement: jump', () => {
  it('jumps onto a cube and stands on it', () => {
    const manager = makeManager({
      blocks: [...flatBlocks(8, 8), block(3, 1, 1, 'stone')],
      spawnCell: { x: 1, z: 1 },
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 40);
    expect(actorOf(manager).transform.position.x).toBeLessThan(2.7);

    manager.submitIntent({ actorId: ACTOR_ID, command: { type: 'actor.jump' } });
    let landed = false;
    for (let i = 0; i < 60 && !landed; i += 1) {
      manager.step(50);
      const y = actorOf(manager).transform.position.y;
      if (y > 1.9 && y < 2.1) {
        landed = true;
      }
    }
    expect(landed).toBe(true);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 0 }) });
    stepMany(manager, 5);
    expect(actorOf(manager).transform.position.y).toBeCloseTo(2, 6);
  });
});

describe('movement: bridge', () => {
  it('walks ON a bridge deck', () => {
    const manager = makeManager({ blocks: bridgeBlocks(), spawnCell: { x: 3, z: 3 } });
    expect(actorOf(manager).transform.position.y).toBeCloseTo(4, 9);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 8);
    const actor = actorOf(manager);
    expect(actor.transform.position.y).toBeCloseTo(4, 9);
    expect(actor.transform.position.x).toBeGreaterThan(4);
  });

  it('walks UNDER the same bridge', () => {
    const manager = makeManager({
      blocks: bridgeBlocks(),
      spawnPosition: { x: 3.5, y: 1, z: 3.5 },
    });
    expect(actorOf(manager).transform.position.y).toBeCloseTo(1, 9);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 8);
    const actor = actorOf(manager);
    expect(actor.transform.position.y).toBeCloseTo(1, 9);
    expect(actor.transform.position.x).toBeGreaterThan(4);
  });
});

describe('movement: gravity and invariants', () => {
  it('falls when its support is removed and lands exactly on the ground', () => {
    const manager = makeManager({
      blocks: [...flatBlocks(8, 8), block(3, 3, 3, 'stone')],
      spawnCell: { x: 3, z: 3 },
    });
    expect(actorOf(manager).transform.position.y).toBeCloseTo(4, 9);
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.remove', coord: { x: 3, y: 3, z: 3 } },
    });
    stepMany(manager, 60);
    const actor = actorOf(manager);
    expect(actor.transform.position.y).toBeCloseTo(1, 9);
    expect(Number.isFinite(actor.transform.position.x)).toBe(true);
  });

  it('never tunnels through a support even with a huge dt', () => {
    const manager = makeManager({
      blocks: [...flatBlocks(8, 8), block(3, 3, 3, 'stone')],
      spawnCell: { x: 3, z: 3 },
    });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.remove', coord: { x: 3, y: 3, z: 3 } },
    });
    manager.step(5000);
    expect(actorOf(manager).transform.position.y).toBeCloseTo(1, 9);
  });

  it('never produces NaN across a long, varied run', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    const inputs = [
      move({ x: 1, z: 0 }),
      move({ x: 0, z: 1 }),
      move({ x: -1, z: 0 }),
      move({ x: 0, z: -1 }),
      move({ x: 0.707, z: 0.707 }),
    ];
    for (let i = 0; i < 200; i += 1) {
      manager.submitIntent({ actorId: ACTOR_ID, command: inputs[i % inputs.length] });
      if (i % 17 === 0) {
        manager.submitIntent({ actorId: ACTOR_ID, command: { type: 'actor.jump' } });
      }
      manager.step(50);
      const position = actorOf(manager).transform.position;
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Number.isFinite(position.z)).toBe(true);
    }
  });

  it('lets a wedged actor escape a block placed on it', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    const before = actorOf(manager).transform.position;
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.set', coord: { x: 1, y: 1, z: 1 }, kind: 'stone', orientation: 0 },
    });
    stepMany(manager, 3);
    const after = actorOf(manager).transform.position;
    expect(Number.isFinite(after.x)).toBe(true);
    expect(after.x).not.toBeCloseTo(before.x, 3);
    // The actor escaped the cube column: it no longer overlaps x in [1, 2].
    expect(after.x >= 2 + 0.35 - 1e-6 || after.x <= 1 - 0.35 + 1e-6).toBe(true);
  });

  it('step(dtMs <= 0) is a strict no-op', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    const before = snapshotOf(manager).entities;
    const batch = manager.step(0);
    expect(batch.events).toEqual([]);
    expect(snapshotOf(manager).entities).toEqual(before);
  });
});

describe('movement: axis-separated sliding (restored coverage)', () => {
  const WALL_X = 3;

  /** The flat ground plus a solid cube wall at `x = 3` spanning every `z`. */
  function wallBlocks(wallHeight: number): ReturnType<typeof flatBlocks> {
    const blocks = flatBlocks(8, 8);
    for (let y = 1; y <= wallHeight; y += 1) {
      for (let z = 0; z < 8; z += 1) {
        blocks.push(block(WALL_X, y, z, 'stone'));
      }
    }
    return blocks;
  }

  for (const wallHeight of [1, 2]) {
    it(`slides diagonally along a ${wallHeight}-high cube wall and never penetrates it`, () => {
      const manager = makeManager({
        blocks: wallBlocks(wallHeight),
        spawnCell: { x: 1, z: 1 },
      });
      expect(actorOverlapsSolid(manager)).toBe(false);

      manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 1 }) });

      // Reach the wall, asserting the non-penetration invariant every tick.
      for (let i = 0; i < 12; i += 1) {
        manager.step(50);
        expect(actorOverlapsSolid(manager)).toBe(false);
      }
      const stalled = actorOf(manager).transform.position;
      // The blocked axis stopped at the wall face (never inside the cell).
      expect(stalled.x).toBeLessThanOrEqual(WALL_X - DEFAULT_ACTOR_RADIUS + 1e-6);
      expect(stalled.x).toBeGreaterThan(1.5);

      // The free axis keeps advancing while the blocked axis is held.
      for (let i = 0; i < 20; i += 1) {
        manager.step(50);
        expect(actorOverlapsSolid(manager)).toBe(false);
      }
      const later = actorOf(manager).transform.position;
      expect(later.x).toBeCloseTo(stalled.x, 9);
      expect(later.z).toBeGreaterThan(stalled.z + 0.5);
    });
  }
});

describe('movement: the default authored world is navigable', () => {
  it('walks on the default flat ground without NaN', () => {
    const manager = createWorldManager({ actorId: ACTOR_ID });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepMany(manager, 20);
    const position = actorOf(manager).transform.position;
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(position.y)).toBe(true);
  });
});
