import { describe, expect, it } from 'vitest';

import type { BlockKind } from '@starvalley/protocol';

import {
  BLOCK_DEFINITIONS,
  blocksAtHeight,
  isSolidBlockKind,
  solidIntervalAt,
  supportHeightAt,
} from '../src/index.ts';
import { block } from './helpers.ts';

const ALL_KINDS: readonly BlockKind[] = [
  'air',
  'grass',
  'soil',
  'stone',
  'path',
  'water',
  'slab',
  'stairs',
  'ramp',
];

describe('block registry totality', () => {
  it('has a definition for every BlockKind', () => {
    for (const kind of ALL_KINDS) {
      const definition = BLOCK_DEFINITIONS[kind];
      expect(definition).toBeDefined();
      expect(definition.collisionShape).toBeDefined();
      expect(Array.isArray(definition.tags)).toBe(true);
    }
    expect(Object.keys(BLOCK_DEFINITIONS)).toHaveLength(ALL_KINDS.length);
  });

  it('models water as a non-solid block and ground/terrain blocks as solid cubes', () => {
    expect(isSolidBlockKind('water')).toBe(false);
    expect(isSolidBlockKind('air')).toBe(false);
    for (const kind of ['grass', 'soil', 'stone', 'path'] as const) {
      expect(isSolidBlockKind(kind)).toBe(true);
      expect(BLOCK_DEFINITIONS[kind].collisionShape).toEqual({ type: 'cube' });
    }
  });
});

describe('supportHeightAt (shape-driven, never kind-driven)', () => {
  it('returns the full cell for a cube', () => {
    expect(supportHeightAt(block(0, 0, 0, 'grass'), 0.1, 0.9)).toBe(1);
  });

  it('returns the slab height and its solid interval starts at 0', () => {
    expect(supportHeightAt(block(0, 0, 0, 'slab'), 0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(solidIntervalAt(block(0, 0, 0, 'slab'), 0.5, 0.5)).toEqual({
      bottom: 0,
      top: 0.5,
    });
  });

  it('returns the two stair steps according to the oriented axis', () => {
    for (const [yaw, lowX, lowZ, highX, highZ] of [
      [0, 0.5, 0.25, 0.5, 0.75],
      [90, 0.25, 0.5, 0.75, 0.5],
      [180, 0.5, 0.75, 0.5, 0.25],
      [270, 0.75, 0.5, 0.25, 0.5],
    ] as const) {
      expect(supportHeightAt(block(0, 0, 0, 'stairs', yaw), lowX, lowZ)).toBe(0.5);
      expect(supportHeightAt(block(0, 0, 0, 'stairs', yaw), highX, highZ)).toBe(1);
    }
  });

  it('returns a linear height field for a ramp along its oriented axis', () => {
    expect(supportHeightAt(block(0, 0, 0, 'ramp', 0), 0.5, 0.25)).toBeCloseTo(0.25, 12);
    expect(supportHeightAt(block(0, 0, 0, 'ramp', 0), 0.5, 0.75)).toBeCloseTo(0.75, 12);
    expect(supportHeightAt(block(0, 0, 0, 'ramp', 90), 0.25, 0.5)).toBeCloseTo(0.25, 12);
    expect(supportHeightAt(block(0, 0, 0, 'ramp', 180), 0.5, 0.25)).toBeCloseTo(0.75, 12);
    expect(supportHeightAt(block(0, 0, 0, 'ramp', 270), 0.75, 0.5)).toBeCloseTo(0.25, 12);
  });

  it('returns null for an empty/non-solid shape', () => {
    expect(supportHeightAt(block(0, 0, 0, 'air'), 0.5, 0.5)).toBeNull();
    expect(supportHeightAt(block(0, 0, 0, 'water'), 0.5, 0.5)).toBeNull();
  });

  it('blocksAtHeight agrees with the solid interval', () => {
    const slab = block(0, 0, 0, 'slab');
    expect(blocksAtHeight(slab, 0.5, 0.5, 0.25)).toBe(true);
    expect(blocksAtHeight(slab, 0.5, 0.5, 0.75)).toBe(false);
    expect(blocksAtHeight(block(0, 0, 0, 'water'), 0.5, 0.5, 0.25)).toBe(false);
  });

  it('produces identical geometry for distinct kinds that share a shape', () => {
    const probe = (kind: BlockKind) => [
      supportHeightAt(block(0, 0, 0, kind), 0.1, 0.2),
      supportHeightAt(block(0, 0, 0, kind), 0.8, 0.9),
    ];
    // Cube kinds share one shape, so the solver sees exactly the same geometry.
    expect(probe('grass')).toEqual(probe('stone'));
    expect(probe('grass')).toEqual(probe('soil'));
    expect(probe('grass')).toEqual(probe('path'));
  });
});
