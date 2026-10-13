/**
 * Block-render registry tests (real Three.js objects, no WebGL).
 *
 * The Game Protocol carries only a block's integer cell, `kind` and yaw-step
 * `orientation`; every material, colour and piece of geometry lives in the
 * render-side `BlockRenderRegistry`. These tests pin the geometry contract that
 * makes a block world seamless:
 *
 * - every block's horizontal footprint is EXACTLY `cellSize` (no inset);
 * - the node scale is 1 (a full block is not shrunk to fake a gap);
 * - a full cube's top face is the cell's top (`+cellSize/2` above the cell
 *   centre the bridge places the node at), so stacked/adjacent full blocks are
 *   continuous and the dark backdrop cannot show through a base layer; and
 * - a slab is half-height (top at the cell centre) and `air` never renders.
 */

import { describe, expect, it } from 'vitest';

import type { AppearanceId, NodeCreateCommand, NodeId } from '@starvalley/render-protocol';

import { BLOCK_RENDER_REGISTRY } from '../src/render/three/blocks.ts';
import { createThreeRuntime } from '../src/render/three/runtime.ts';

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
const CELL_SIZE = 1;

/** One block node at the cell centre for cell `(0, 0, 0)` of this grid. */
function blockCommand(appearance: AppearanceId): NodeCreateCommand {
  return {
    type: 'node.create',
    layer: 'object',
    nodeId: `block:0,0,0` as NodeId,
    appearance,
    transform: {
      // cellCentre(origin -0.5, cell 0) = 0.5 on each axis for a unit grid.
      position: { x: 0.5, y: 0.5, z: 0.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    visible: true,
  };
}

describe('block render registry geometry', () => {
  it('registers a distinct visual for every renderable kind, and never `air`', () => {
    const kinds = BLOCK_RENDER_REGISTRY.map((entry) => entry.kind);
    expect([...kinds].sort()).toEqual([
      'grass',
      'path',
      'ramp',
      'slab',
      'soil',
      'stairs',
      'stone',
      'water',
    ]);
    expect(kinds).not.toContain('air');
    const appearances = BLOCK_RENDER_REGISTRY.map((entry) => entry.appearance);
    expect(new Set(appearances).size).toBe(appearances.length);
    for (const appearance of appearances) {
      expect(appearance.startsWith('appearance.block.')).toBe(true);
    }
  });

  it('gives every block a footprint of exactly cellSize and unit scale', () => {
    for (const entry of BLOCK_RENDER_REGISTRY) {
      const runtime = createThreeRuntime({ bounds: BOUNDS, grid: { origin: { x: -0.5, y: 0, z: -0.5 }, cellSize: CELL_SIZE } });
      runtime.apply([blockCommand(entry.appearance as AppearanceId)]);
      const node = runtime.inspect().nodes[0];
      expect(node, `node for ${entry.kind}`).toBeDefined();
      expect(node.footprintX, `footprintX for ${entry.kind}`).toBeCloseTo(CELL_SIZE, 9);
      expect(node.footprintZ, `footprintZ for ${entry.kind}`).toBeCloseTo(CELL_SIZE, 9);
      expect(node.scale, `scale for ${entry.kind}`).toEqual({ x: 1, y: 1, z: 1 });
      runtime.dispose();
    }
  });

  it('places a full cube top face at the cell top, and a slab at the cell centre', () => {
    for (const entry of BLOCK_RENDER_REGISTRY) {
      const runtime = createThreeRuntime({ bounds: BOUNDS, grid: { origin: { x: -0.5, y: 0, z: -0.5 }, cellSize: CELL_SIZE } });
      runtime.apply([blockCommand(entry.appearance as AppearanceId)]);
      const node = runtime.inspect().nodes[0];
      // The node root is the cell centre (world y 0.5 here); a full cube tops out
      // at +0.5 relative to it, i.e. exactly the cell top.
      expect(node.visualTopY, `visualTopY for ${entry.kind}`).toBeCloseTo(
        entry.topOffsetInCells * CELL_SIZE,
        9,
      );
      runtime.dispose();
    }
  });

  it('makes adjacent full-cube blocks share boundaries exactly (no seam)', () => {
    const runtime = createThreeRuntime({ bounds: BOUNDS, grid: { origin: { x: -0.5, y: 0, z: -0.5 }, cellSize: CELL_SIZE } });
    const make = (x: number): NodeCreateCommand => ({
      type: 'node.create',
      layer: 'object',
      nodeId: `block:${x},0,0` as NodeId,
      appearance: 'appearance.block.grass' as AppearanceId,
      transform: {
        position: { x: x + 0.5, y: 0.5, z: 0.5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      visible: true,
    });
    runtime.apply([make(0), make(1)]);

    const nodes = runtime.inspect().nodes;
    const a = nodes.find((node) => node.nodeId === 'block:0,0,0');
    const b = nodes.find((node) => node.nodeId === 'block:1,0,0');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Centres step by exactly cellSize ...
    expect((b?.world.x ?? 0) - (a?.world.x ?? 0)).toBeCloseTo(CELL_SIZE, 9);
    // ... and the full footprints touch with no gap: the right edge of A equals
    // the left edge of B.
    const aRight = (a?.world.x ?? 0) + (a?.footprintX ?? 0) / 2;
    const bLeft = (b?.world.x ?? 0) - (b?.footprintX ?? 0) / 2;
    expect(aRight).toBeCloseTo(bLeft, 9);
    runtime.dispose();
  });
});
