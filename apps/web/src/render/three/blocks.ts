/**
 * Block render registry: `BlockKind` -> procedural visual.
 *
 * This is the client-side presentation half of the block-spatial kernel. The
 * Game Protocol carries only a block's integer cell, its `kind` label and its
 * yaw-step `orientation`; it deliberately carries no appearance, material or
 * collision shape. **Every texture, material and colour for a block lives here**
 * and is never sent over the wire.
 *
 * Geometry contract (applies to every block kind)
 * ----------------------------------------------
 * A block node's world transform places its root at the cell's centre
 * (`cellCentre = origin + (cell + 0.5) * cellSize`). Each visual is therefore
 * authored **relative to the cell centre** and, crucially:
 *
 * - its horizontal footprint (world-space AABB on X/Z) is EXACTLY `cellSize`, so
 *   neighbouring cells share their boundaries exactly with no seam; and
 * - a full block's top face is the cell's top (`+cellSize / 2` locally), so a
 *   stack of full blocks is continuous and the dark backdrop can never show
 *   through a base layer.
 *
 * `air` is the absence of a block and is deliberately **not** in this registry:
 * it never renders.
 *
 * Adding an instanced / greedy-meshed realisation is a change to this file (or
 * to how the runtime consumes it) alone: the Render ISA only ever names an
 * appearance, and the bridge groups emission per chunk.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';

/** One block kind's presentation: the appearance key, and the visual factory. */
export interface BlockRenderEntry {
  /** The block `kind` this entry realises (`air` is absent). */
  readonly kind: string;
  /** The opaque appearance id the bridge emits for this kind. */
  readonly appearance: string;
  /**
   * The tallest point of the visual relative to the cell centre, as a multiple
   * of `cellSize`. `0.5` is the cell top (a full cube); a half-height slab tops
   * out at `0`. Exposed so the geometry contract is assertable without reading
   * Three.js objects.
   */
  readonly topOffsetInCells: number;
  /** Build a fresh visual rooted at the cell centre. */
  createVisual(cellSize: number): Group;
}

function material(colour: number, options: { roughness?: number; metalness?: number } = {}) {
  const entry = new MeshStandardMaterial({ color: colour });
  if (options.roughness !== undefined) {
    entry.roughness = options.roughness;
  }
  if (options.metalness !== undefined) {
    entry.metalness = options.metalness;
  }
  return entry;
}

/**
 * A full-height opaque cube centred on the cell centre: its top face is the
 * cell's top and its footprint is exactly one cell on both horizontal axes.
 */
function createCubeVisual(cellSize: number, colour: number): Group {
  const group = new Group();
  const cube = new Mesh(new BoxGeometry(cellSize, cellSize, cellSize), material(colour, { roughness: 0.9 }));
  // Centred on the node root, which the bridge places at the cell centre, so the
  // top face sits at exactly `cellCentre.y + cellSize / 2`.
  cube.position.y = 0;
  cube.castShadow = true;
  cube.receiveShadow = true;
  group.add(cube);
  return group;
}

/**
 * Water: a full-cell cube with a translucent, slightly glossy material so it
 * reads as liquid. The footprint is still exactly `cellSize` and the top is the
 * cell top, so adjacent water cells meet seamlessly. Opaque enough that the
 * depth buffer still resolves it.
 */
function createWaterVisual(cellSize: number): Group {
  const group = new Group();
  const water = new Mesh(
    new BoxGeometry(cellSize, cellSize, cellSize),
    new MeshStandardMaterial({
      color: 0x2f8fd0,
      transparent: true,
      opacity: 0.72,
      roughness: 0.2,
      metalness: 0.05,
    }),
  );
  water.castShadow = false;
  water.receiveShadow = true;
  group.add(water);
  return group;
}

/**
 * A half-height slab anchored at the cell's bottom: it occupies the lower half
 * of the cell, so its top is the cell centre. Its footprint is still exactly
 * `cellSize`.
 */
function createSlabVisual(cellSize: number): Group {
  const group = new Group();
  const slab = new Mesh(
    new BoxGeometry(cellSize, cellSize / 2, cellSize),
    material(0xb0a090, { roughness: 0.9 }),
  );
  slab.position.y = -cellSize / 4;
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);
  return group;
}

/**
 * Stairs: a lower full-footprint step (top at the cell centre) plus an upper
 * half-footprint step behind it (top at the cell top). The node's yaw-step
 * orientation rotates the whole profile, so a directional stair faces its own
 * way without any additional derivation.
 */
function createStairsVisual(cellSize: number): Group {
  const group = new Group();
  const lower = new Mesh(
    new BoxGeometry(cellSize, cellSize / 2, cellSize),
    material(0xa08050, { roughness: 0.9 }),
  );
  lower.position.y = -cellSize / 4;
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Upper step: back half of the cell (local -Z), top at the cell top.
  const upper = new Mesh(
    new BoxGeometry(cellSize, cellSize / 2, cellSize / 2),
    material(0xb08f5b, { roughness: 0.9 }),
  );
  upper.position.set(0, cellSize / 4, -cellSize / 4);
  upper.castShadow = true;
  upper.receiveShadow = true;
  group.add(upper);
  return group;
}

/**
 * A wedge whose top face is a single plane rising from the front-bottom edge to
 * the back-top edge: a ramp reads as a slope. Authored as an explicit triangular
 * prism so the standard 3D transform stays shear-free and the horizontal
 * footprint stays exactly one cell (a rotated box would not).
 */
function createRampVisual(cellSize: number): Group {
  const half = cellSize / 2;
  const group = new Group();

  // Cell-local corners. `y` spans the cell; +Z is the low (front) side.
  const positions = new Float32Array([
    -half, -half, half, // 0 front-left bottom
    half, -half, half, // 1 front-right bottom
    half, -half, -half, // 2 back-right bottom
    -half, -half, -half, // 3 back-left bottom
    -half, half, -half, // 4 back-left top
    half, half, -half, // 5 back-right top
  ]);
  const indices = [
    0, 3, 2, 0, 2, 1, // bottom
    2, 3, 4, 2, 4, 5, // back
    0, 4, 3, // left
    1, 2, 5, // right
    0, 1, 5, 0, 5, 4, // slope (the plane top face)
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const ramp = new Mesh(geometry, material(0x9c7b4a, { roughness: 0.9 }));
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  group.add(ramp);
  return group;
}

/**
 * The registry, keyed by block kind. `air` is intentionally absent: it is the
 * absence of a block and never produces a node.
 */
export const BLOCK_RENDER_REGISTRY: readonly BlockRenderEntry[] = Object.freeze([
  { kind: 'grass', appearance: 'appearance.block.grass', topOffsetInCells: 0.5, createVisual: (s: number) => createCubeVisual(s, 0x5cab3f) },
  { kind: 'soil', appearance: 'appearance.block.soil', topOffsetInCells: 0.5, createVisual: (s: number) => createCubeVisual(s, 0x7a5230) },
  { kind: 'stone', appearance: 'appearance.block.stone', topOffsetInCells: 0.5, createVisual: (s: number) => createCubeVisual(s, 0x9a9a9a) },
  { kind: 'path', appearance: 'appearance.block.path', topOffsetInCells: 0.5, createVisual: (s: number) => createCubeVisual(s, 0xc2a76b) },
  { kind: 'water', appearance: 'appearance.block.water', topOffsetInCells: 0.5, createVisual: createWaterVisual },
  { kind: 'slab', appearance: 'appearance.block.slab', topOffsetInCells: 0, createVisual: createSlabVisual },
  { kind: 'stairs', appearance: 'appearance.block.stairs', topOffsetInCells: 0.5, createVisual: createStairsVisual },
  { kind: 'ramp', appearance: 'appearance.block.ramp', topOffsetInCells: 0.5, createVisual: createRampVisual },
] as const);

/** The entry for a block kind, or `undefined` (including for `air`). */
export function blockRenderEntry(kind: string): BlockRenderEntry | undefined {
  return BLOCK_RENDER_REGISTRY.find((entry) => entry.kind === kind);
}
