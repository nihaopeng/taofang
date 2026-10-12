/**
 * Runtime tests for the Three.js Render ISA executor.
 *
 * These use real Three.js objects but **never call `mount`**, so no WebGL context
 * is required and the suite runs in the default node environment. The scene
 * composition (scene, groups, camera rig, lights, ground) exists from
 * construction, so `apply`, `update`, `setFollowTarget`, and `inspect` cover the
 * whole surface without a GPU.
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
import {
  KNOWN_APPEARANCES,
  RENDER_CAMERA,
  createThreeRuntime,
  orthographicBounds,
} from '../src/render/three/runtime.ts';
import type { RenderInspection, RenderRuntime } from '../src/render/three/runtime.ts';

const nodeA = 'node-a' as NodeId;
const nodeB = 'node-b' as NodeId;
const appearanceCharacter = 'appearance.character' as AppearanceId;
const appearanceTree = 'appearance.tree' as AppearanceId;
const appearanceGrass = 'appearance.terrain.grass' as AppearanceId;
const appearancePath = 'appearance.terrain.path' as AppearanceId;
const appearanceWater = 'appearance.terrain.water' as AppearanceId;
const appearanceBlocked = 'appearance.terrain.blocked' as AppearanceId;

const WORLD_SIZE = { width: 10, height: 10 } as const;

function makeRuntime(worldSize: { width: number; height: number } = WORLD_SIZE): RenderRuntime {
  return createThreeRuntime({ worldSize });
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
  it('handles all seven primitives in a single frame without throwing', () => {
    const runtime = makeRuntime();
    const frame: RenderFrame = [
      createCommand(nodeA, 'object', appearanceCharacter, 0, 0),
      createCommand(nodeB, 'object', appearanceCharacter, 1, 1),
      { type: 'transform.set', nodeId: nodeA, transform: { x: 1, y: 1 } },
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: { x: 2, y: 2 },
        durationMs: 150,
      },
      { type: 'appearance.set', nodeId: nodeA, appearance: appearanceTree },
      { type: 'visibility.set', nodeId: nodeB, visible: false },
      { type: 'animation.play', nodeId: nodeA, animation: 'walk' as never, loop: true },
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
      animation: 'walk',
    });

    runtime.dispose();
  });

  it('assigns each node to the group its prefab declares, not a layer convention', () => {
    const runtime = makeRuntime();

    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass),
      createCommand('entity:tree' as NodeId, 'object', appearanceTree),
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter),
    ]);

    const nodes = runtime.inspect().nodes;
    expect(nodes.find((n) => n.nodeId === 'tile:0,0')?.group).toBe('Terrain');
    expect(nodes.find((n) => n.nodeId === 'entity:tree')?.group).toBe('WorldObjects');
    expect(nodes.find((n) => n.nodeId === 'entity:actor')?.group).toBe('Actors');

    runtime.dispose();
  });

  it('reflects animation.play in inspect() and changes on a later command', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);

    // A fresh node is at rest: the bridge only emits walk/idle transitions.
    expect(findNode(runtime, nodeA).animation).toBe('idle');

    runtime.apply([
      { type: 'animation.play', nodeId: nodeA, animation: 'walk' as never, loop: true },
    ]);
    expect(findNode(runtime, nodeA).animation).toBe('walk');

    runtime.apply([
      { type: 'animation.play', nodeId: nodeA, animation: 'idle' as never, loop: true },
    ]);
    expect(findNode(runtime, nodeA).animation).toBe('idle');

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
  it('maps tile (x, y) to scene (x, 0, y) and inverts it from the real Object3D', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 3, 4)]);

    // Tile -> scene is scene.z = tile.y. inspect() inverts that from the actual
    // object, so changing the mapping (e.g. dropping the mapping) fails here.
    const node = findNode(runtime, nodeA);
    expect(node.x).toBe(3);
    expect(node.y).toBe(4);
    expect(node.depth).toBe(4);

    runtime.dispose();
  });

  it('reads an interpolated position back off the object, not off bookkeeping', () => {
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

  it('derives presentation-only facing from the visual movement delta', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    expect(findNode(runtime, nodeA).yaw).toBe(0);

    // Move east (+x): local +z front should rotate toward +π/2.
    runtime.apply([
      { type: 'transform.setTarget', nodeId: nodeA, transform: { x: 8, y: 0 }, durationMs: 100 },
    ]);
    runtime.update(0);
    runtime.update(100);

    expect(findNode(runtime, nodeA).yaw).toBeGreaterThan(0);
    expect(findNode(runtime, nodeA).yaw).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);

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

describe('three runtime animation completion', () => {
  it('returns to the prefab default animation and to rest when a move interpolation completes', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    runtime.apply([
      { type: 'transform.setTarget', nodeId: nodeA, transform: { x: 10, y: 0 }, durationMs: 100 },
    ]);
    runtime.apply([
      { type: 'animation.play', nodeId: nodeA, animation: 'walk' as never, loop: true },
    ]);

    runtime.update(0);
    runtime.update(50);
    // Mid-flight: walking and visibly bobbing, with the prefab's rest animation
    // available to return to.
    const mid = findNode(runtime, nodeA);
    expect(mid.animation).toBe('walk');
    expect(mid.defaultAnimation).toBe('idle');
    expect(Math.abs(mid.visualY)).toBeGreaterThan(0);

    // Advance past the interpolation duration. The runtime owns the end of the
    // move, so it resets to the prefab default. Removing that reset leaves the
    // node on `walk` and the nowMs-driven bob running forever — the reported
    // artefact — so the very next assertion fails.
    runtime.update(100);
    expect(findNode(runtime, nodeA).animation).toBe('idle');

    // Let the placeholder motion settle: no residual bob/roll at rest, and no
    // oscillation as the clock keeps advancing.
    for (let t = 120; t <= 2000; t += 20) {
      runtime.update(t);
    }
    const rest = findNode(runtime, nodeA);
    expect(Math.abs(rest.visualY)).toBeLessThan(1e-4);
    expect(Math.abs(rest.visualRoll)).toBeLessThan(1e-4);

    runtime.dispose();
  });

  it('ends a walk on an instant transform.set as well as on interpolation completion', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter, 0, 0)]);
    runtime.apply([
      { type: 'animation.play', nodeId: nodeA, animation: 'walk' as never, loop: true },
    ]);
    expect(findNode(runtime, nodeA).animation).toBe('walk');

    runtime.apply([{ type: 'transform.set', nodeId: nodeA, transform: { x: 9, y: 9 } }]);

    expect(findNode(runtime, nodeA).animation).toBe('idle');
    runtime.dispose();
  });
});

describe('three runtime depth and occlusion', () => {
  /** The real 10x10 map shape: terrain everywhere, two trees, the actor. */
  function makeWorldFrame(): RenderFrame {
    const frame: NodeCreateCommand[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        let appearance = appearanceGrass;
        if (x === 3 && y === 3) {
          appearance = appearanceWater;
        } else if (x === 2 && y === 8) {
          appearance = appearanceBlocked;
        } else if (y === 1 || y === 6) {
          appearance = appearancePath;
        }
        frame.push(createCommand(`tile:${x},${y}` as NodeId, 'base', appearance, x, y));
      }
    }
    frame.push(createCommand('entity:tree-1' as NodeId, 'object', appearanceTree, 6, 4));
    frame.push(createCommand('entity:tree-2' as NodeId, 'object', appearanceTree, 4, 7));
    frame.push(createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 5, 5));
    return frame;
  }

  it('applies the 10x10 map + entities frame and groups 100 terrain / 2 trees / 1 actor', () => {
    const runtime = makeRuntime();
    runtime.apply(makeWorldFrame());

    const inspection = runtime.inspect();
    expect(inspection.nodes).toHaveLength(103);
    const countGroup = (group: string): number =>
      inspection.nodes.filter((node) => node.group === group).length;
    expect(countGroup('Terrain')).toBe(100);
    expect(countGroup('WorldObjects')).toBe(2);
    expect(countGroup('Actors')).toBe(1);

    runtime.dispose();
  });

  it('resolves occlusion along the real camera view axis: an actor north of a tree is behind it, south is in front', () => {
    const runtime = makeRuntime();
    runtime.apply(makeWorldFrame());

    const tree = findNode(runtime, 'entity:tree-1' as NodeId);
    const { camera } = runtime.inspect();
    // Camera-space depth: projection of the world position onto the camera's own
    // forward axis. A LARGER value is farther from the camera. This is computed
    // from the real forward vector, so a change to pitch or yaw breaks it (raw
    // scene `z` could not).
    const viewDepth = (node: RenderInspection['nodes'][number]): number =>
      (node.world.x - camera.position.x) * camera.forward.x +
      (node.world.y - camera.position.y) * camera.forward.y +
      (node.world.z - camera.position.z) * camera.forward.z;

    // North of the tree -> smaller tile y -> farther along the view axis, so the
    // tree occludes the actor.
    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: { x: 6, y: 3 } },
    ]);
    const north = findNode(runtime, 'entity:actor' as NodeId);
    expect(viewDepth(north)).toBeGreaterThan(viewDepth(tree));

    // South of the tree -> larger tile y -> nearer the camera.
    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: { x: 6, y: 5 } },
    ]);
    const south = findNode(runtime, 'entity:actor' as NodeId);
    expect(viewDepth(south)).toBeLessThan(viewDepth(tree));

    runtime.dispose();
  });

  it('offsets the base layer behind the object layer at the same tile (depth, not pixels)', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('tile:5,5' as NodeId, 'base', appearanceGrass, 5, 5),
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 5, 5),
    ]);

    const base = findNode(runtime, 'tile:5,5' as NodeId);
    const object = findNode(runtime, 'entity:actor' as NodeId);
    // Same tile row, but the base layer carries a depth offset away from the camera.
    expect(base.y).toBeCloseTo(5);
    expect(object.y).toBeCloseTo(5);
    expect(base.depth).toBeLessThan(object.depth);

    runtime.dispose();
  });
});

describe('three runtime camera follow', () => {
  it('moves the camera toward the followed node and stops when the target is null', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 5, 5)]);

    const before = runtime.inspect().camera.position;
    // The camera rig starts at the world centre (4.5, 4.5); the camera itself
    // sits `distance * cos(pitch)` above it on +z.
    const zOffset = RENDER_CAMERA.distance * Math.cos((RENDER_CAMERA.pitchDegrees * Math.PI) / 180);
    expect(before.x).toBeCloseTo(4.5);
    expect(before.z).toBeCloseTo(4.5 + zOffset);

    runtime.setFollowTarget('entity:actor' as NodeId);
    runtime.update(0);
    runtime.update(200);
    const moving = runtime.inspect().camera.position;
    expect(moving.x).toBeGreaterThan(before.x);
    expect(moving.x).toBeLessThanOrEqual(5);

    for (let t = 400; t <= 3000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.position.x).toBeCloseTo(5);

    // A null target stops the follow without moving the camera.
    runtime.setFollowTarget(null);
    const frozen = runtime.inspect().camera.position;
    runtime.update(3100);
    runtime.update(4000);
    expect(runtime.inspect().camera.position).toEqual(frozen);

    runtime.dispose();
  });

  it('follows a node after it is snapped to a new tile', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 5, 5)]);
    runtime.setFollowTarget('entity:actor' as NodeId);
    runtime.update(0);
    for (let t = 100; t <= 1000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.position.x).toBeCloseTo(5);

    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: { x: 8, y: 5 } },
    ]);
    for (let t = 1100; t <= 3000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.position.x).toBeCloseTo(8);

    runtime.dispose();
  });
});

describe('three runtime shadows', () => {
  it('derives cast/receive flags from the real meshes: terrain receives, a tree casts', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass),
      createCommand('entity:tree' as NodeId, 'object', appearanceTree),
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter),
    ]);

    const inspection = runtime.inspect();
    expect(inspection.lights).toBe(2);

    // Asserted from inspection data (flags/map size), never by rendering pixels.
    expect(inspection.shadow).not.toBeNull();
    expect(inspection.shadow?.sunCasts).toBe(true);
    expect(inspection.shadow?.mapWidth).toBe(1024);
    expect(inspection.shadow?.mapHeight).toBe(1024);

    // These flags are measured by traversing the created visual, not copied from
    // the prefab record. Deleting `receiveShadow = true` in `createPlate` or the
    // tree's `castShadow = true` now changes them and fails this test.
    const grass = findNode(runtime, 'tile:0,0' as NodeId);
    expect(grass.receivesShadow).toBe(true);
    expect(grass.castsShadow).toBe(false);
    const tree = findNode(runtime, 'entity:tree' as NodeId);
    expect(tree.castsShadow).toBe(true);
    expect(tree.receivesShadow).toBe(false);
    expect(findNode(runtime, 'entity:actor' as NodeId).castsShadow).toBe(true);

    runtime.dispose();
  });
});

describe('three runtime lifecycle', () => {
  it('removes the scene background on dispose so a remount cannot inherit it', () => {
    const runtime = makeRuntime();
    // Same family as the canvas/page background in ui/styles.css.
    expect(runtime.inspect().background).toBe(0x1a140e);

    runtime.dispose();

    expect(runtime.inspect().background).toBeNull();
  });

  it('releases groups, lights (shadow resources), ground and nodes on dispose', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand(nodeA, 'base', appearanceGrass),
      createCommand(nodeB, 'object', appearanceCharacter),
    ]);

    const before = runtime.inspect();
    expect(before.mounted).toBe(false);
    expect(before.lights).toBe(2);
    expect(before.ground).toBe(true);
    expect(before.groups).toBe(4);
    expect(before.shadow).not.toBeNull();
    expect(before.nodes).toHaveLength(2);

    runtime.dispose();

    // dispose() must remove *everything* the runtime created, otherwise a
    // StrictMode remount stacks a second pair of lights (doubled lighting).
    const after = runtime.inspect();
    expect(after.lights).toBe(0);
    expect(after.ground).toBe(false);
    expect(after.groups).toBe(0);
    expect(after.shadow).toBeNull();
    expect(after.nodes).toHaveLength(0);
    expect(after.buckets).toHaveLength(0);
    expect(after.mounted).toBe(false);

    // Idempotent: a second dispose is safe.
    expect(() => {
      runtime.dispose();
    }).not.toThrow();
  });

  it('frames the world with the tilted-orthographic projection and a literal top bound', () => {
    const worldSize = { width: 10, height: 10 } as const;
    const runtime = makeRuntime(worldSize);
    const { camera } = runtime.inspect();

    // LITERAL: halfHeight = (10 / 2) * sin(58 deg) + 1 = 5.24024...  Pinning the
    // literal (rather than only re-calling `orthographicBounds`) catches a change
    // to the pitch or the headroom.
    expect(camera.top).toBeCloseTo(5.2402, 3);
    expect(camera.bottom).toBeCloseTo(-5.2402, 3);
    // Square default canvas aspect: halfWidth equals halfHeight.
    expect(camera.left).toBeCloseTo(-5.2402, 3);
    expect(camera.right).toBeCloseTo(5.2402, 3);

    // Frozen stance: front-facing (no yaw), pitched down by exactly 58 degrees.
    // A pitch or yaw change moves this literal forward vector.
    expect(camera.forward.x).toBeCloseTo(0, 6);
    expect(camera.forward.y).toBeCloseTo(-Math.sin((58 * Math.PI) / 180), 6);
    expect(camera.forward.z).toBeCloseTo(-Math.cos((58 * Math.PI) / 180), 6);
    expect(camera.up.y).toBeGreaterThan(0);

    // Cross-check the projection helper for the same arguments.
    const expected = orthographicBounds({ worldSize, aspect: 1 });
    expect(camera.left).toBeCloseTo(expected.left);
    expect(camera.right).toBeCloseTo(expected.right);
    expect(camera.top).toBeCloseTo(expected.top);
    expect(camera.bottom).toBeCloseTo(expected.bottom);

    runtime.dispose();
  });

  it('grows the vertical extent to fit a world wider than the canvas aspect, keeping scale uniform', () => {
    const worldSize = { width: 10, height: 10 } as const;
    // A portrait canvas (aspect 0.5): the aspect-derived half-width (2.62) would
    // crop the 10-wide world, so the single uniform scale grows the vertical
    // bound until halfWidth * matches the full world width.
    const bounds = orthographicBounds({ worldSize, aspect: 0.5 });
    expect(bounds.right).toBeCloseTo(5, 6);
    expect(bounds.left).toBeCloseTo(-5, 6);
    expect(bounds.top).toBeCloseTo(10, 6);
    // Uniform scale: the frustum aspect still equals the canvas aspect.
    expect(bounds.right / bounds.top).toBeCloseTo(0.5, 6);
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

describe('three runtime buckets', () => {
  it('groups nodes into (layer, appearance) buckets and updates them on appearance.set/node.destroy', () => {
    const runtime = makeRuntime();
    const frame: NodeCreateCommand[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        frame.push(createCommand(`tile:${x},${y}` as NodeId, 'base', appearanceGrass, x, y));
      }
    }
    frame.push(createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, 1, 1));
    runtime.apply(frame);

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
    runtime.apply([
      { type: 'appearance.set', nodeId: 'tile:0,0' as NodeId, appearance: appearanceGrass },
    ]);
    expect(runtime.inspect().buckets.map((bucket) => bucket.key)).not.toContain(
      'base:appearance.terrain.path',
    );

    runtime.dispose();
  });

  it('re-buckets and re-parents when appearance.set changes the prefab group', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand('entity:x' as NodeId, 'object', appearanceCharacter, 0, 0)]);
    expect(findNode(runtime, 'entity:x' as NodeId).group).toBe('Actors');

    runtime.apply([
      { type: 'appearance.set', nodeId: 'entity:x' as NodeId, appearance: appearanceTree },
    ]);

    expect(findNode(runtime, 'entity:x' as NodeId).group).toBe('WorldObjects');
    expect(bucketCount(runtime, 'object:appearance.character')).toBe(0);
    expect(bucketCount(runtime, 'object:appearance.tree')).toBe(1);

    runtime.dispose();
  });
});

describe('three runtime terrain shape cue', () => {
  it('gives path an opaque geometric cue beyond colour: a raised inlay taller than grass', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass, 0, 0),
      createCommand('tile:1,0' as NodeId, 'base', appearancePath, 1, 0),
    ]);

    const grass = findNode(runtime, 'tile:0,0' as NodeId);
    const path = findNode(runtime, 'tile:1,0' as NodeId);
    // Measured from the real geometry, not from a colour or a metadata flag. A
    // colour-only path would have `visualTopY` at or below grass (its base is
    // recessed), so this fails if the raised inlay is removed.
    expect(grass.visualTopY).toBeCloseTo(0, 6);
    expect(path.visualTopY).toBeGreaterThan(grass.visualTopY);

    runtime.dispose();
  });
});

describe('three runtime appearance catalogue binding', () => {
  it('covers every appearance id the bridge can emit', () => {
    for (const appearance of BRIDGE_APPEARANCES) {
      expect(KNOWN_APPEARANCES).toContain(appearance);
    }
  });
});
