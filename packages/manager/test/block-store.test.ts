import { describe, expect, it } from 'vitest';

import {
  isGameEventBatch,
  isWorldSnapshot,
  parseCellCoord,
} from '@starvalley/protocol';

import {
  createBlockStore,
  createDefaultBlocks,
  DEFAULT_BLOCK_GRID,
} from '../src/index.ts';
import { ACTOR_ID, block, flatBlocks, makeManager, snapshotOf } from './helpers.ts';

describe('sparse block store', () => {
  it('stores only non-air blocks with unique absolute cells', () => {
    const store = createBlockStore(DEFAULT_BLOCK_GRID, createDefaultBlocks());
    const entries = store.entries();
    expect(entries.length).toBe(store.size());
    const seen = new Set<string>();
    for (const entry of entries) {
      expect(entry.kind).not.toBe('air');
      const key = `${entry.coord.x},${entry.coord.y},${entry.coord.z}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('emits blocks in a deterministic (layer, z, x) order', () => {
    const store = createBlockStore(DEFAULT_BLOCK_GRID, [
      block(2, 1, 0, 'stone'),
      block(0, 0, 0, 'grass'),
      block(1, 0, 0, 'grass'),
      block(5, 2, 3, 'slab'),
    ]);
    const coords = store.entries().map((entry) => entry.coord);
    expect(coords).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 5, y: 2, z: 3 },
    ]);
  });

  it('keeps a chunk index addressable in both directions', () => {
    const store = createBlockStore(DEFAULT_BLOCK_GRID, [
      block(0, 0, 0, 'grass'),
      block(15, 0, 15, 'stone'),
      block(16, 0, 0, 'stone'),
      block(-1, 0, 0, 'stone'),
    ]);
    const chunks = store.chunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      for (const cell of store.cellsInChunk(chunk)) {
        expect(store.has(cell)).toBe(true);
      }
    }
    // Floor division for negative cells: cell -1 is in chunk -1, local 15.
    expect(store.cellsInChunk({ x: -1, y: 0, z: 0 })).toEqual([{ x: -1, y: 0, z: 0 }]);
    expect(store.cellsInChunk({ x: 0, y: 0, z: 0 })).toContainEqual({ x: 0, y: 0, z: 0 });
    expect(store.cellsInChunk({ x: 0, y: 0, z: 0 })).toContainEqual({ x: 15, y: 0, z: 15 });
  });
});

describe('v9 snapshot', () => {
  it('emits a valid v9 snapshot whose blocks are sparse and non-air', () => {
    const manager = makeManager({ blocks: flatBlocks(4, 4), spawnCell: { x: 1, z: 1 } });
    const snapshot = snapshotOf(manager);
    expect(isWorldSnapshot(snapshot)).toBe(true);
    expect(snapshot.blocks.every((entry) => entry.kind !== 'air')).toBe(true);
    expect(snapshot.blockGrid.cellSize).toBe(1);
  });

  it('never hardcodes cellSize 1: a 0.5 cell world resolves its support', () => {
    const manager = makeManager({
      grid: { origin: { x: 0, y: 0, z: 0 }, cellSize: 0.5 },
      blocks: flatBlocks(4, 4),
      spawnCell: { x: 1, z: 1 },
    });
    const snapshot = snapshotOf(manager);
    expect(snapshot.blockGrid.cellSize).toBe(0.5);
    // A grounded block at cell y=0 with cellSize 0.5 has its top at y = 0.5.
    expect(snapshot.entities[0].transform.position.y).toBeCloseTo(0.5, 9);
  });

  it('returns a fresh object graph on every read', () => {
    const manager = makeManager({ blocks: flatBlocks(3, 3), spawnCell: { x: 1, z: 1 } });
    const first = snapshotOf(manager);
    first.blocks[0].kind = 'stone';
    const second = snapshotOf(manager);
    expect(second.blocks[0].kind).toBe('grass');
  });
});

describe('block.set / block.remove commands', () => {
  it('block.set mutates the store and emits exactly one block.changed', () => {
    const manager = makeManager({ blocks: flatBlocks(4, 4), spawnCell: { x: 1, z: 1 } });
    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.set', coord: parseCellCoord({ x: 1, y: 2, z: 1 }), kind: 'stone', orientation: 0 },
    });
    expect(isGameEventBatch(response)).toBe(true);
    if (!isGameEventBatch(response)) throw new Error('expected batch');
    expect(response.events).toHaveLength(1);
    expect(response.events[0]).toEqual({
      type: 'block.changed',
      coord: { x: 1, y: 2, z: 1 },
      kind: 'stone',
      orientation: 0,
    });
    expect(snapshotOf(manager).blocks).toContainEqual({
      coord: { x: 1, y: 2, z: 1 },
      kind: 'stone',
      orientation: 0,
    });
  });

  it('setting air via block.set is a removal', () => {
    const manager = makeManager({ blocks: flatBlocks(4, 4), spawnCell: { x: 1, z: 1 } });
    manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.set', coord: parseCellCoord({ x: 1, y: 1, z: 1 }), kind: 'stone', orientation: 0 },
    });
    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.set', coord: parseCellCoord({ x: 1, y: 1, z: 1 }), kind: 'air', orientation: 0 },
    });
    if (!isGameEventBatch(response)) throw new Error('expected batch');
    expect(response.events[0]).toMatchObject({ type: 'block.changed', kind: 'air' });
    expect(snapshotOf(manager).blocks.some((entry) => entry.coord.y === 1)).toBe(false);
  });

  it('block.remove emits a block.changed with kind air', () => {
    const manager = makeManager({ blocks: flatBlocks(4, 4), spawnCell: { x: 1, z: 1 } });
    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.remove', coord: parseCellCoord({ x: 0, y: 0, z: 0 }) },
    });
    if (!isGameEventBatch(response)) throw new Error('expected batch');
    expect(response.events[0]).toEqual({
      type: 'block.changed',
      coord: { x: 0, y: 0, z: 0 },
      kind: 'air',
      orientation: 0,
    });
  });

  it('rejects duplicate and air blocks at construction', () => {
    const duplicate = [block(0, 0, 0, 'grass'), block(0, 0, 0, 'stone')];
    expect(() => makeManager({ blocks: duplicate })).toThrow(RangeError);
    expect(() => makeManager({ blocks: [{ ...block(0, 0, 0, 'air') }] })).toThrow(RangeError);
  });
});
