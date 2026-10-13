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
 * - a slab is half-height (top at the cell centre) and `air` never renders; and
 * - the DIRECTIONAL kinds (`stairs`, `ramp`) match the authoritative collision
 *   shape in `packages/manager/src/blocks.ts` at every yaw step, not merely in
 *   their maximum height.
 */

import { describe, expect, it } from 'vitest';
import { Raycaster, Vector3 } from 'three';
import type { Group } from 'three';

import type { BlockKind, BlockState } from '@starvalley/protocol';
import { supportHeightAt } from '@starvalley/manager';
import type { AppearanceId, NodeCreateCommand, NodeId } from '@starvalley/render-protocol';

import { BLOCK_RENDER_REGISTRY, blockRenderEntry } from '../src/render/three/blocks.ts';
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

/**
 * Yaw steps the bridge can apply to a directional block (the frozen contract).
 */
const DIRECTION_ORIENTATIONS = [0, 90, 180, 270] as const;

/**
 * Cell-local sample points across one cell. They deliberately avoid `0.5`, the
 * stair step boundary: a ray exactly on a discontinuity is ambiguous, and the
 * direction is already pinned by the many off-boundary samples.
 */
const CELL_SAMPLES = [0.15, 0.35, 0.65, 0.85] as const;

/**
 * Measure the visual's top at a cell-local point as a fraction of `cellSize`
 * (`0` is the cell bottom, `1` the cell top). A downward ray at the point finds
 * the top surface; the highest hit is the surface the actor would stand on.
 */
function visualTopFraction(
  visual: Group,
  cellSize: number,
  localX: number,
  localZ: number,
): number {
  const raycaster = new Raycaster();
  raycaster.set(
    new Vector3((localX - 0.5) * cellSize, cellSize * 4, (localZ - 0.5) * cellSize),
    new Vector3(0, -1, 0),
  );
  const hits = raycaster.intersectObject(visual, true);
  if (hits.length === 0) {
    throw new Error(`no visual top at cell-local (${localX}, ${localZ})`);
  }
  let top = Number.NEGATIVE_INFINITY;
  for (const hit of hits) {
    top = Math.max(top, hit.point.y);
  }
  // Cell-local fraction = node-local y / cellSize + 0.5, because the node root is
  // the cell centre.
  return top / cellSize + 0.5;
}

/**
 * B1 regression: the rendered `stairs`/`ramp` must rise on the SAME side the
 * collision authority says they do.
 *
 * The authority is `packages/manager/src/blocks.ts`: a `stair`'s full-height step
 * is the `+Z` half (`cz < 0.5 ? 0.5 : 1`) and a `ramp`'s top rises toward `+Z`
 * (`top = clamp01(cz)`), with `toCanonicalLocal` undoing the yaw. The bridge then
 * applies a plain right-handed `+Y` yaw to the node root. These tests build the
 * real visual, apply the SAME yaw, and compare the whole measured height field
 * against `supportHeightAt` at every yaw step, so a 180-degree mirror at any
 * quarter turn fails here rather than shipping.
 */
describe('block direction matches the authoritative collision shape', () => {
  it('rises on the same side as packages/manager/src/blocks.ts at every yaw', () => {
    for (const kind of ['stairs', 'ramp'] as const) {
      const entry = blockRenderEntry(kind);
      if (entry === undefined) {
        throw new Error(`no render entry for ${kind}`);
      }
      for (const orientation of DIRECTION_ORIENTATIONS) {
        const block: BlockState = {
          coord: { x: 0, y: 0, z: 0 },
          kind: kind as BlockKind,
          orientation,
        };
        const visual = entry.createVisual(CELL_SIZE);
        // The runtime applies the node's yaw ON TOP of the visual's own group
        // rotation, so compose it the same way (`rotateY` post-multiplies).
        visual.rotateY((orientation * Math.PI) / 180);
        visual.updateMatrixWorld(true);

        let maxAuthority = Number.NEGATIVE_INFINITY;
        let minAuthority = Number.POSITIVE_INFINITY;
        let maxAuthorityTop = 0;
        let minAuthorityTop = 0;
        for (const localX of CELL_SAMPLES) {
          for (const localZ of CELL_SAMPLES) {
            const authority = supportHeightAt(block, localX, localZ);
            if (authority === null) {
              throw new Error(`non-solid ${kind} at (${localX}, ${localZ})`);
            }
            const measured = visualTopFraction(visual, CELL_SIZE, localX, localZ);
            // The measured height field must equal the authoritative one at every
            // sample: this pins DIRECTION, not just the maximum height.
            expect(
              measured,
              `${kind} yaw ${orientation} at (${localX}, ${localZ})`,
            ).toBeCloseTo(authority, 6);
            if (authority > maxAuthority) {
              maxAuthority = authority;
              maxAuthorityTop = measured;
            }
            if (authority < minAuthority) {
              minAuthority = authority;
              minAuthorityTop = measured;
            }
          }
        }
        // Direction, stated directly: the authoritative high side is visibly
        // higher than the authoritative low side.
        expect(maxAuthority, `${kind} yaw ${orientation} has a rise`).toBeGreaterThan(
          minAuthority,
        );
        expect(maxAuthorityTop).toBeGreaterThan(minAuthorityTop);
      }
    }
  });
});
