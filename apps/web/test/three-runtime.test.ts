/**
 * Runtime tests for the Three.js Render ISA executor.
 *
 * These use real Three.js objects but **never call `mount`**, so no WebGL context
 * is required and the suite runs in the default node environment. The scene
 * composition (camera, ground, lights, nodes) exists from construction, so
 * `apply`, `update`, and `inspect` cover the whole command surface without a GPU.
 */

import { describe, expect, it } from 'vitest';

import type {
  AppearanceId,
  NodeCreateCommand,
  NodeId,
  RenderFrame,
  RenderLayer,
} from '@starvalley/render-protocol';

import { BRIDGE_APPEARANCES } from '../src/render/bridge.ts';
import { KNOWN_APPEARANCES, createThreeRuntime } from '../src/render/three/runtime.ts';
import type { RenderInspection, RenderRuntime } from '../src/render/three/runtime.ts';

const nodeA = 'node-a' as NodeId;
const nodeB = 'node-b' as NodeId;
const appearanceCharacter = 'appearance.character' as AppearanceId;
const appearanceTree = 'appearance.tree' as AppearanceId;
const appearanceGrass = 'appearance.terrain.grass' as AppearanceId;
const appearancePath = 'appearance.terrain.path' as AppearanceId;

const WORLD_SIZE = { width: 12, height: 8 } as const;

function makeRuntime(): RenderRuntime {
  return createThreeRuntime({ worldSize: WORLD_SIZE });
}

/** `node.create` with the layer supplied explicitly and sensible defaults. */
function createCommand(
  nodeId: NodeId,
  layer: RenderLayer,
  appearance: AppearanceId = appearanceCharacter,
  x = 0,
  y = 0,
  visible = true,
): NodeCreateCommand {
  return { type: 'node.create', layer, nodeId, appearance, transform: { x, y }, visible };
}

function findNode(runtime: RenderRuntime, nodeId: NodeId): RenderInspection['nodes'][number] {
  const node = runtime.inspect().nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) {
    throw new Error(`node ${String(nodeId)} not present`);
  }
  return node;
}

function bucketCount(runtime: RenderRuntime, key: string): number {
  return runtime.inspect().buckets.find((bucket) => bucket.key === key)?.count ?? 0;
}

describe('three runtime command execution', () => {
  it('applies a frame containing all six primitives without throwing', () => {
    const runtime = makeRuntime();
    const frame: RenderFrame = [
      createCommand(nodeA, 'object', appearanceCharacter, 0, 0),
      createCommand(nodeB, 'object', appearanceCharacter, 1, 1),
      { type: 'transform.set', nodeId: nodeA, transform: { x: 1, y: 1 } },
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: { x: 2, y: 2 },
        durationMs: 100,
      },
      { type: 'appearance.set', nodeId: nodeA, appearance: appearanceTree },
      { type: 'visibility.set', nodeId: nodeB, visible: false },
      { type: 'node.destroy', nodeId: nodeB },
    ];

    expect(() => {
      runtime.apply(frame);
    }).not.toThrow();

    const inspection = runtime.inspect();
    expect(inspection.mounted).toBe(false);
    expect(inspection.nodes).toHaveLength(1);
    expect(findNode(runtime, nodeA)).toMatchObject({
      nodeId: 'node-a',
      layer: 'object',
      appearance: 'appearance.tree',
    });

    runtime.dispose();
  });

  it('reflects created nodes and their transforms in inspect()', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 3, 4)]);

    expect(findNode(runtime, nodeA)).toEqual({
      nodeId: 'node-a',
      layer: 'object',
      x: 3,
      y: 4,
      depth: 0,
      visible: true,
      appearance: 'appearance.character',
    });

    runtime.dispose();
  });

  it('removes a destroyed node from inspect()', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);
    expect(runtime.inspect().nodes).toHaveLength(1);

    runtime.apply([{ type: 'node.destroy', nodeId: nodeA }]);

    expect(runtime.inspect().nodes).toHaveLength(0);
    runtime.dispose();
  });

  it('reflects visibility.set in inspect()', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);

    runtime.apply([{ type: 'visibility.set', nodeId: nodeA, visible: false }]);

    expect(findNode(runtime, nodeA).visible).toBe(false);
    runtime.dispose();
  });
});

describe('three runtime coordinate mapping', () => {
  it('derives inspect() coordinates from the real Object3D position', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 3, 4)]);

    // Tile -> scene is scene.y = -tile.y. inspect() inverts that from the actual
    // mesh, so changing the mapping (e.g. dropping the negation) fails here even
    // though the runtime's tile-space bookkeeping would still read (3, 4).
    const node = findNode(runtime, nodeA);
    expect(node.x).toBe(3);
    expect(node.y).toBe(4);

    runtime.dispose();
  });

  it('reads an interpolated position back off the mesh, not off bookkeeping', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    runtime.apply([
      { type: 'transform.setTarget', nodeId: nodeA, transform: { x: 10, y: 20 }, durationMs: 100 },
    ]);

    runtime.update(1000);
    runtime.update(1050);

    const node = findNode(runtime, nodeA);
    expect(node.x).toBeCloseTo(5);
    expect(node.y).toBeCloseTo(10);

    runtime.dispose();
  });
});

describe('three runtime transforms', () => {
  it('applies transform.set instantly', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);

    runtime.apply([{ type: 'transform.set', nodeId: nodeA, transform: { x: 5, y: 6 } }]);

    expect(findNode(runtime, nodeA)).toMatchObject({ x: 5, y: 6 });
    runtime.dispose();
  });

  it('interpolates a transform.setTarget toward the target and reaches it', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    runtime.apply([
      { type: 'transform.setTarget', nodeId: nodeA, transform: { x: 10, y: 20 }, durationMs: 100 },
    ]);

    // The first update establishes the interpolation start; no clock is read in apply.
    runtime.update(1000);
    expect(findNode(runtime, nodeA)).toMatchObject({ x: 0, y: 0 });

    runtime.update(1050);
    expect(findNode(runtime, nodeA).x).toBeCloseTo(5);
    expect(findNode(runtime, nodeA).y).toBeCloseTo(10);

    runtime.update(1100);
    expect(findNode(runtime, nodeA).x).toBeCloseTo(10);
    expect(findNode(runtime, nodeA).y).toBeCloseTo(20);

    // Once it reaches the authoritative target it stays there.
    runtime.update(2000);
    expect(findNode(runtime, nodeA)).toMatchObject({ x: 10, y: 20 });

    runtime.dispose();
  });

  it('cancels interpolation when a transform.set snaps mid-flight', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    runtime.apply([
      { type: 'transform.setTarget', nodeId: nodeA, transform: { x: 10, y: 0 }, durationMs: 100 },
    ]);
    runtime.update(0);
    runtime.update(50);

    runtime.apply([{ type: 'transform.set', nodeId: nodeA, transform: { x: 99, y: 99 } }]);
    runtime.update(200);

    expect(findNode(runtime, nodeA)).toMatchObject({ x: 99, y: 99 });
    runtime.dispose();
  });
});

describe('three runtime lifecycle', () => {
  it('composes the scene at construction and releases lights, ground and nodes on dispose', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);

    // Built without mount: the composition is what the runtime owns.
    const before = runtime.inspect();
    expect(before.mounted).toBe(false);
    expect(before.lights).toBe(2);
    expect(before.ground).toBe(true);
    expect(before.nodes).toHaveLength(1);

    runtime.dispose();

    // dispose() must remove *everything* the runtime created, otherwise a
    // StrictMode remount stacks a second pair of lights (doubled lighting).
    const after = runtime.inspect();
    expect(after.lights).toBe(0);
    expect(after.ground).toBe(false);
    expect(after.nodes).toHaveLength(0);
    expect(after.mounted).toBe(false);

    // Idempotent: a second dispose is safe.
    expect(() => {
      runtime.dispose();
    }).not.toThrow();
  });

  it('frames the camera with the world height as the vertical extent', () => {
    const runtime = makeRuntime();
    const { camera } = runtime.inspect();
    // Initial frustum fits the world exactly (12 x 8).
    expect(camera.top).toBe(4);
    expect(camera.bottom).toBe(-4);
    expect(camera.right).toBe(6);
    expect(camera.left).toBe(-6);
    runtime.dispose();
  });

  it('does not throw for an unknown appearance and falls back to a material', () => {
    const runtime = makeRuntime();
    expect(() => {
      runtime.apply([createCommand(nodeA, 'object', 'appearance.unknown' as AppearanceId)]);
    }).not.toThrow();
    expect(findNode(runtime, nodeA).appearance).toBe('appearance.unknown');
    runtime.dispose();
  });
});

describe('three runtime layers', () => {
  /** A 10x10 base-layer grid plus one object-layer node: 101 creations. */
  function makeFullFrame(): RenderFrame {
    const frame: NodeCreateCommand[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        frame.push(
          createCommand(`tile:${x},${y}` as NodeId, 'base', appearanceGrass, x, y),
        );
      }
    }
    frame.push(createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 1, 1));
    return frame;
  }

  it('applies a 10x10 base-layer frame plus an object-layer node and reports all 101 with layers', () => {
    const runtime = makeRuntime();

    runtime.apply(makeFullFrame());

    const inspection = runtime.inspect();
    expect(inspection.nodes).toHaveLength(101);
    expect(inspection.nodes.filter((node) => node.layer === 'base')).toHaveLength(100);
    expect(inspection.nodes.filter((node) => node.layer === 'object')).toHaveLength(1);
    expect(findNode(runtime, 'entity:actor' as NodeId)).toMatchObject({
      layer: 'object',
      x: 1,
      y: 1,
    });

    runtime.dispose();
  });

  it('draws the base layer behind the object layer (depth ordering, not pixels)', () => {
    const runtime = makeRuntime();
    runtime.apply(makeFullFrame());

    const nodes = runtime.inspect().nodes;
    const object = nodes.find((node) => node.layer === 'object');
    const base = nodes.find((node) => node.layer === 'base');
    if (object === undefined || base === undefined) {
      throw new Error('expected both a base and an object node');
    }

    // Base is pushed away from the camera; the object layer sits at the front.
    expect(base.depth).toBeLessThan(object.depth);
    expect(Math.max(...nodes.filter((node) => node.layer === 'base').map((node) => node.depth)))
      .toBeLessThan(
        Math.min(...nodes.filter((node) => node.layer === 'object').map((node) => node.depth)),
      );

    runtime.dispose();
  });

  it('groups nodes into (layer, appearance) buckets and updates them on appearance.set/node.destroy', () => {
    const runtime = makeRuntime();
    runtime.apply(makeFullFrame());

    // 100 grass tiles in one base bucket, the actor alone in an object bucket.
    expect(bucketCount(runtime, 'base:appearance.terrain.grass')).toBe(100);
    expect(bucketCount(runtime, 'object:appearance.character')).toBe(1);
    expect(runtime.inspect().buckets).toHaveLength(2);

    runtime.apply([
      { type: 'appearance.set', nodeId: 'tile:0,0' as NodeId, appearance: appearancePath },
    ]);

    expect(bucketCount(runtime, 'base:appearance.terrain.grass')).toBe(99);
    expect(bucketCount(runtime, 'base:appearance.terrain.path')).toBe(1);

    runtime.apply([{ type: 'node.destroy', nodeId: 'tile:1,0' as NodeId }]);

    expect(bucketCount(runtime, 'base:appearance.terrain.grass')).toBe(98);
    // The emptied path bucket is removed, not left at zero.
    runtime.apply([
      { type: 'appearance.set', nodeId: 'tile:0,0' as NodeId, appearance: appearanceGrass },
    ]);
    expect(runtime.inspect().buckets.map((bucket) => bucket.key)).not.toContain(
      'base:appearance.terrain.path',
    );

    runtime.dispose();
  });

  it('releases all 101 nodes and their buckets on dispose', () => {
    const runtime = makeRuntime();
    runtime.apply(makeFullFrame());
    expect(runtime.inspect().nodes).toHaveLength(101);

    runtime.dispose();

    const after = runtime.inspect();
    expect(after.nodes).toHaveLength(0);
    expect(after.buckets).toHaveLength(0);
  });
});

describe('three runtime appearance catalogue binding', () => {
  it('covers every appearance id the bridge can emit', () => {
    for (const appearance of BRIDGE_APPEARANCES) {
      expect(KNOWN_APPEARANCES).toContain(appearance);
    }
  });
});
