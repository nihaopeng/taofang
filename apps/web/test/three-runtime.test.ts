/// <reference types="node" />
/**
 * Runtime tests for the Three.js Render ISA executor.
 *
 * These use real Three.js objects but **never call `mount`**, so no WebGL context
 * is required and the suite runs in the default node environment. The scene
 * composition (scene, groups, camera rig, lights, ground) exists from
 * construction, so `apply`, `update`, `setFollowTarget`, `getCameraState`,
 * `setCameraOrientation`, `setZoom`, and `inspect` cover the whole surface
 * without a GPU.
 *
 * Phase 7: nodes are placed directly at their authoritative world transforms —
 * these tests assert world positions and the applied quaternion numerically, and
 * assert the camera rig's follow/pitch/yaw/zoom through plain inspection data.
 */

import { readFileSync } from 'node:fs';

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import {
  Bone,
  Float32BufferAttribute,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type {
  AppearanceId,
  NodeCreateCommand,
  NodeId,
  Quat,
  RenderFrame,
  RenderLayer,
  RenderTransform,
  Vec3,
} from '@starvalley/render-protocol';

import { BRIDGE_APPEARANCES } from '../src/render/bridge.ts';
import { asAppearanceId } from '../src/render/three/assets.ts';
import {
  KNOWN_APPEARANCES,
  RENDER_CAMERA,
  createThreeRuntime,
  orthographicBounds,
} from '../src/render/three/runtime.ts';
import type {
  ModelLoader,
  RenderInspection,
  RenderRuntime,
} from '../src/render/three/runtime.ts';

const nodeA = 'node-a' as NodeId;
const nodeB = 'node-b' as NodeId;
const appearanceCharacter = 'appearance.character' as AppearanceId;
const appearanceTree = 'appearance.tree' as AppearanceId;
const appearanceGrass = 'appearance.terrain.grass' as AppearanceId;
const appearancePath = 'appearance.terrain.path' as AppearanceId;
const appearanceWater = 'appearance.terrain.water' as AppearanceId;
const appearanceBlocked = 'appearance.terrain.blocked' as AppearanceId;

/** Default 12x12 ground, 8 units tall, centred on the world origin. */
const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } } as const;

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const UNIT_SCALE: Vec3 = { x: 1, y: 1, z: 1 };

/** Quaternion for a yaw about +Y (the actor heading convention). */
function yawQuat(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function transform(
  position: Vec3 = { x: 0, y: 0, z: 0 },
  rotation: Quat = IDENTITY,
): RenderTransform {
  return { position, rotation, scale: { ...UNIT_SCALE } };
}

function makeRuntime(bounds: { min: Vec3; max: Vec3 } = BOUNDS): RenderRuntime {
  return createThreeRuntime({ bounds });
}

/** `node.create` with the layer supplied explicitly and sensible defaults. */
function createCommand(
  nodeId: NodeId,
  layer: RenderLayer,
  appearance: AppearanceId = appearanceCharacter,
  position: Vec3 = { x: 0, y: 0, z: 0 },
  rotation: Quat = IDENTITY,
  visible = true,
): NodeCreateCommand {
  return {
    type: 'node.create',
    layer,
    nodeId,
    appearance,
    transform: transform(position, rotation),
    visible,
  };
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

/** Camera-space depth: projection of a world position onto the camera forward axis. */
function viewDepth(
  node: RenderInspection['nodes'][number],
  camera: RenderInspection['camera'],
): number {
  return (
    (node.world.x - camera.position.x) * camera.forward.x +
    (node.world.y - camera.position.y) * camera.forward.y +
    (node.world.z - camera.position.z) * camera.forward.z
  );
}

describe('three runtime command execution', () => {
  it('handles all seven primitives in a single frame without throwing', () => {
    const runtime = makeRuntime();
    const frame: RenderFrame = [
      createCommand(nodeA, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }),
      createCommand(nodeB, 'object', appearanceCharacter, { x: 1, y: 0, z: 1 }),
      { type: 'transform.set', nodeId: nodeA, transform: transform({ x: 1, y: 0, z: 1 }) },
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: transform({ x: 2, y: 0, z: 2 }, yawQuat(90)),
        durationMs: 50,
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
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);

    // A fresh node is at rest: the bridge only emits walk transitions.
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

describe('three runtime world-space placement', () => {
  it('places a node exactly at its authoritative world position (no tile mapping, no inversion)', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand(nodeA, 'object', appearanceCharacter, { x: 3, y: 1.5, z: -4 }),
    ]);

    // Every axis is reported verbatim; a leftover tile->scene mapping or an
    // axis flip would change one of these literals.
    const node = findNode(runtime, nodeA);
    expect(node.world).toEqual({ x: 3, y: 1.5, z: -4 });

    runtime.dispose();
  });

  it('applies the authoritative quaternion directly and reports its yaw', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand(nodeA, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }, yawQuat(90)),
    ]);

    const node = findNode(runtime, nodeA);
    expect(node.rotation.x).toBeCloseTo(0, 9);
    expect(node.rotation.y).toBeCloseTo(Math.SQRT1_2, 9);
    expect(node.rotation.w).toBeCloseTo(Math.SQRT1_2, 9);
    // yaw 0 faces +Z; a 90-degree turn about +Y reads back numerically.
    expect(node.yaw).toBeCloseTo(Math.PI / 2, 9);

    runtime.dispose();
  });

  it('separates the base and object layers by render order, never by position', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('tile:5,5' as NodeId, 'base', appearanceGrass, { x: 5, y: 0, z: 5 }),
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 5, y: 0, z: 5 }),
    ]);

    const base = findNode(runtime, 'tile:5,5' as NodeId);
    const object = findNode(runtime, 'entity:actor' as NodeId);
    // Same world position: occlusion is the depth buffer's job.
    expect(base.world).toEqual(object.world);
    // Draw order is the documented coarse rule.
    expect(base.renderOrder).toBeLessThan(object.renderOrder);

    runtime.dispose();
  });
});

describe('three runtime transforms', () => {
  it('applies transform.set instantly (position and rotation)', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);

    runtime.apply([
      {
        type: 'transform.set',
        nodeId: nodeA,
        transform: transform({ x: 5, y: 6, z: 7 }, yawQuat(180)),
      },
    ]);

    const node = findNode(runtime, nodeA);
    expect(node.world).toEqual({ x: 5, y: 6, z: 7 });
    expect(Math.abs(node.yaw)).toBeCloseTo(Math.PI, 9);
    runtime.dispose();
  });

  it('interpolates transform.setTarget position AND rotation and reaches both', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);
    runtime.apply([
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: transform({ x: 10, y: 4, z: 20 }, yawQuat(90)),
        durationMs: 100,
      },
    ]);

    // The first update establishes the interpolation start; no clock is read in apply.
    runtime.update(1000);
    expect(findNode(runtime, nodeA).world).toEqual({ x: 0, y: 0, z: 0 });

    runtime.update(1050);
    const mid = findNode(runtime, nodeA);
    expect(mid.world.x).toBeCloseTo(5);
    expect(mid.world.y).toBeCloseTo(2);
    expect(mid.world.z).toBeCloseTo(10);
    expect(mid.yaw).toBeCloseTo(Math.PI / 4, 6);

    runtime.update(1100);
    const done = findNode(runtime, nodeA);
    expect(done.world).toEqual({ x: 10, y: 4, z: 20 });
    expect(done.yaw).toBeCloseTo(Math.PI / 2, 9);

    // Once it reaches the authoritative target it stays there.
    runtime.update(2000);
    expect(findNode(runtime, nodeA).world).toEqual({ x: 10, y: 4, z: 20 });

    runtime.dispose();
  });

  it('cancels interpolation when a transform.set snaps mid-flight', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);
    runtime.apply([
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: transform({ x: 10, y: 0, z: 0 }),
        durationMs: 100,
      },
    ]);
    runtime.update(0);
    runtime.update(50);

    runtime.apply([
      { type: 'transform.set', nodeId: nodeA, transform: transform({ x: 99, y: 1, z: 99 }) },
    ]);
    runtime.update(200);

    expect(findNode(runtime, nodeA).world).toEqual({ x: 99, y: 1, z: 99 });
    runtime.dispose();
  });
});

describe('three runtime animation completion', () => {
  it('returns to the prefab default animation and to rest when a move interpolation completes', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);
    runtime.apply([
      {
        type: 'transform.setTarget',
        nodeId: nodeA,
        transform: transform({ x: 10, y: 0, z: 0 }),
        durationMs: 100,
      },
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
    // node on `walk` and the nowMs-driven bob running forever.
    runtime.update(100);
    expect(findNode(runtime, nodeA).animation).toBe('idle');

    // Let the placeholder motion settle: no residual bob/roll at rest.
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
    runtime.apply([createCommand(nodeA, 'object', appearanceCharacter)]);
    runtime.apply([
      { type: 'animation.play', nodeId: nodeA, animation: 'walk' as never, loop: true },
    ]);
    expect(findNode(runtime, nodeA).animation).toBe('walk');

    runtime.apply([
      { type: 'transform.set', nodeId: nodeA, transform: transform({ x: 9, y: 0, z: 9 }) },
    ]);

    expect(findNode(runtime, nodeA).animation).toBe('idle');
    runtime.dispose();
  });
});

describe('three runtime depth and occlusion', () => {
  /** A 12x12 ground of plates plus two trees and the actor, all in world space. */
  function makeWorldFrame(): RenderFrame {
    const frame: NodeCreateCommand[] = [];
    for (let cellZ = 0; cellZ < 12; cellZ += 1) {
      for (let cellX = 0; cellX < 12; cellX += 1) {
        let appearance = appearanceGrass;
        if (cellX === 3 && cellZ === 3) {
          appearance = appearanceWater;
        } else if (cellX === 2 && cellZ === 8) {
          appearance = appearanceBlocked;
        } else if (cellZ === 1 || cellZ === 6) {
          appearance = appearancePath;
        }
        frame.push(
          createCommand(
            `tile:${cellX},${cellZ}` as NodeId,
            'base',
            appearance,
            { x: cellX - 6, y: 0, z: cellZ - 6 },
          ),
        );
      }
    }
    frame.push(
      createCommand('entity:tree-1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: -2 }),
    );
    frame.push(
      createCommand('entity:tree-2' as NodeId, 'object', appearanceTree, { x: -2, y: 0, z: 1 }),
    );
    frame.push(
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: -1, y: 0, z: -1 }),
    );
    return frame;
  }

  it('applies the 12x12 map + entities frame and groups 144 terrain / 2 trees / 1 actor', () => {
    const runtime = makeRuntime();
    runtime.apply(makeWorldFrame());

    const inspection = runtime.inspect();
    expect(inspection.nodes).toHaveLength(147);
    const countGroup = (group: string): number =>
      inspection.nodes.filter((node) => node.group === group).length;
    expect(countGroup('Terrain')).toBe(144);
    expect(countGroup('WorldObjects')).toBe(2);
    expect(countGroup('Actors')).toBe(1);

    runtime.dispose();
  });

  it('resolves occlusion along the real camera view axis from real world positions', () => {
    const runtime = makeRuntime();
    runtime.apply(makeWorldFrame());

    const tree = findNode(runtime, 'entity:tree-1' as NodeId);
    const { camera } = runtime.inspect();

    // North of the tree (smaller z) -> farther along the view axis, so the tree
    // occludes the actor.
    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: transform({ x: 0, y: 0, z: -3 }) },
    ]);
    const north = findNode(runtime, 'entity:actor' as NodeId);
    expect(viewDepth(north, camera)).toBeGreaterThan(viewDepth(tree, camera));

    // South of the tree (larger z) -> nearer the camera.
    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: transform({ x: 0, y: 0, z: -1 }) },
    ]);
    const south = findNode(runtime, 'entity:actor' as NodeId);
    expect(viewDepth(south, camera)).toBeLessThan(viewDepth(tree, camera));

    runtime.dispose();
  });
});

describe('three runtime camera rig', () => {
  it('exposes the default stance as plain data', () => {
    const runtime = makeRuntime();
    const state = runtime.getCameraState();
    expect(state.pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
    expect(state.yawDegrees).toBe(0);
    expect(state.zoom).toBe(1);
    expect(state.focus).toEqual({ x: 0, y: 0, z: 0 });

    runtime.dispose();
  });

  it('follows the controlled node with smoothing and stops when the target is null', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 5, y: 0, z: 5 }),
    ]);

    const before = runtime.inspect().camera.focus;
    expect(before).toEqual({ x: 0, y: 0, z: 0 });

    runtime.setFollowTarget('entity:actor' as NodeId);
    runtime.update(0);
    runtime.update(200);
    const moving = runtime.inspect().camera.focus;
    expect(moving.x).toBeGreaterThan(0);
    expect(moving.x).toBeLessThanOrEqual(5);

    for (let t = 400; t <= 3000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.focus.x).toBeCloseTo(5);
    expect(runtime.inspect().camera.focus.z).toBeCloseTo(5);

    // A null target stops the follow without moving the camera focus.
    runtime.setFollowTarget(null);
    const frozen = runtime.inspect().camera.focus;
    runtime.update(3100);
    runtime.update(4000);
    expect(runtime.inspect().camera.focus).toEqual(frozen);

    runtime.dispose();
  });

  it('follows a node after it is snapped to a new world position', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }),
    ]);
    runtime.setFollowTarget('entity:actor' as NodeId);
    runtime.update(0);
    for (let t = 100; t <= 1000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.focus.x).toBeCloseTo(0);

    runtime.apply([
      { type: 'transform.set', nodeId: 'entity:actor' as NodeId, transform: transform({ x: 8, y: 0, z: 0 }) },
    ]);
    for (let t = 1100; t <= 3000; t += 100) {
      runtime.update(t);
    }
    expect(runtime.inspect().camera.focus.x).toBeCloseTo(8);

    runtime.dispose();
  });

  it('clamps pitch into the constrained range', () => {
    const runtime = makeRuntime();

    runtime.setCameraOrientation({ pitchDegrees: 5 });
    expect(runtime.getCameraState().pitchDegrees).toBe(RENDER_CAMERA.minPitchDegrees);

    runtime.setCameraOrientation({ pitchDegrees: 120 });
    expect(runtime.getCameraState().pitchDegrees).toBe(RENDER_CAMERA.maxPitchDegrees);

    runtime.setCameraOrientation({ pitchDegrees: 45 });
    expect(runtime.getCameraState().pitchDegrees).toBe(45);
    expect(runtime.inspect().camera.pitchDegrees).toBe(45);

    runtime.dispose();
  });

  it('yaws the view without changing world coordinates, and normalises yaw', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand(nodeA, 'object', appearanceCharacter, { x: 3, y: 0, z: -4 }),
    ]);
    const before = findNode(runtime, nodeA);
    const forwardAtZero = runtime.inspect().camera.forward;

    runtime.setCameraOrientation({ yawDegrees: 90 });
    const after = findNode(runtime, nodeA);
    const forwardAtNinety = runtime.inspect().camera.forward;

    // The node did not move: yaw rotates the rig, not the world.
    expect(after.world).toEqual(before.world);
    expect(forwardAtNinety).not.toEqual(forwardAtZero);
    expect(forwardAtNinety.x).toBeCloseTo(-Math.cos((58 * Math.PI) / 180), 6);
    expect(forwardAtNinety.z).toBeCloseTo(0, 6);

    runtime.setCameraOrientation({ yawDegrees: -90 });
    expect(runtime.getCameraState().yawDegrees).toBe(270);

    runtime.dispose();
  });

  it('changes the frustum extent with zoom, clamped to the rig limits', () => {
    const runtime = makeRuntime();
    const base = runtime.inspect().camera;

    runtime.setZoom(2);
    const zoomedIn = runtime.inspect().camera;
    expect(zoomedIn.top).toBeCloseTo(base.top / 2, 9);
    expect(zoomedIn.zoom).toBe(2);

    runtime.setZoom(100);
    expect(runtime.getCameraState().zoom).toBe(RENDER_CAMERA.maxZoom);

    runtime.setZoom(0);
    expect(runtime.getCameraState().zoom).toBe(RENDER_CAMERA.minZoom);

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

    expect(inspection.shadow).not.toBeNull();
    expect(inspection.shadow?.sunCasts).toBe(true);
    expect(inspection.shadow?.mapWidth).toBe(1024);
    expect(inspection.shadow?.mapHeight).toBe(1024);

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
    const runtime = makeRuntime();
    const { camera } = runtime.inspect();

    // The 12-deep ground foreshortens to (12/2)*sin(58) plus 1 unit of headroom.
    const expectedTop = (12 / 2) * Math.sin((58 * Math.PI) / 180) + 1;
    expect(camera.top).toBeCloseTo(expectedTop, 6);
    expect(camera.bottom).toBeCloseTo(-expectedTop, 6);
    // Square aspect: halfWidth equals halfHeight.
    expect(camera.left).toBeCloseTo(-expectedTop, 6);
    expect(camera.right).toBeCloseTo(expectedTop, 6);

    // Frozen default stance: yaw 0, pitched down by exactly 58 degrees.
    expect(camera.forward.x).toBeCloseTo(0, 6);
    expect(camera.forward.y).toBeCloseTo(-Math.sin((58 * Math.PI) / 180), 6);
    expect(camera.forward.z).toBeCloseTo(-Math.cos((58 * Math.PI) / 180), 6);
    expect(camera.up.y).toBeGreaterThan(0);

    // Cross-check the projection helper for the same arguments.
    const expected = orthographicBounds({
      bounds: BOUNDS,
      aspect: 1,
      pitchDegrees: 58,
      yawDegrees: 0,
      zoom: 1,
    });
    expect(camera.left).toBeCloseTo(expected.left);
    expect(camera.right).toBeCloseTo(expected.right);
    expect(camera.top).toBeCloseTo(expected.top);
    expect(camera.bottom).toBeCloseTo(expected.bottom);

    runtime.dispose();
  });

  it('grows the vertical extent to fit a world wider than the canvas aspect, keeping scale uniform', () => {
    // A portrait canvas (aspect 0.5): the aspect-derived half-width (1.25) would
    // crop the 12-wide world, so the single uniform scale grows the vertical
    // bound until halfWidth * matches the full world width.
    const bounds = orthographicBounds({
      bounds: BOUNDS,
      aspect: 0.5,
      pitchDegrees: 58,
      yawDegrees: 0,
      zoom: 1,
    });
    expect(bounds.right).toBeCloseTo(6, 6);
    expect(bounds.left).toBeCloseTo(-6, 6);
    expect(bounds.top).toBeCloseTo(12, 6);
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
    for (let cellZ = 0; cellZ < 10; cellZ += 1) {
      for (let cellX = 0; cellX < 10; cellX += 1) {
        frame.push(
          createCommand(
            `tile:${cellX},${cellZ}` as NodeId,
            'base',
            appearanceGrass,
            { x: cellX, y: 0, z: cellZ },
          ),
        );
      }
    }
    frame.push(createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 1, y: 0, z: 1 }));
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
    runtime.apply([createCommand('entity:x' as NodeId, 'object', appearanceCharacter)]);
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
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass, { x: 0, y: 0, z: 0 }),
      createCommand('tile:1,0' as NodeId, 'base', appearancePath, { x: 1, y: 0, z: 0 }),
    ]);

    const grass = findNode(runtime, 'tile:0,0' as NodeId);
    const path = findNode(runtime, 'tile:1,0' as NodeId);
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

describe('three runtime picking', () => {
  it('picks a registered entity node under the centre ray', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }),
    ]);

    expect(runtime.pick(0, 0)).toEqual({ kind: 'node', nodeId: 'entity:actor' });

    runtime.dispose();
  });

  it('picks the mathematical ground point for a bare ground click', () => {
    const runtime = makeRuntime();

    const hit = runtime.pick(0, 0);
    expect(hit?.kind).toBe('ground');
    if (hit?.kind === 'ground') {
      // The centre ray points at the rig focus, which lies on the ground plane.
      expect(hit.point.x).toBeCloseTo(0, 6);
      expect(hit.point.y).toBeCloseTo(BOUNDS.min.y, 6);
      expect(hit.point.z).toBeCloseTo(0, 6);
    }

    runtime.dispose();
  });

  it('returns null for a ground hit outside the world bounds, with no clamping', () => {
    const runtime = makeRuntime();

    // A corner ray lands far outside the 12x12 world; no intent may be derived.
    expect(runtime.pick(1, 1)).toBeNull();
    expect(runtime.pick(-1, -1)).toBeNull();

    runtime.dispose();
  });

  it('prefers a node visual over the ground behind it at the same screen point', () => {
    const runtime = makeRuntime();
    // Tall tree at the focus: the centre ray would also reach the ground there.
    runtime.apply([
      createCommand('entity:tree' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
    ]);

    expect(runtime.pick(0, 0)).toEqual({ kind: 'node', nodeId: 'entity:tree' });

    runtime.dispose();
  });

  it('does not let a base-layer terrain plate shadow the mathematical ground pick', () => {
    const runtime = makeRuntime();
    // A grass plate is the visible ground at the focus. If it were raycast as a
    // node, every ground click would pick a tile node and never reach moveTo.
    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass, { x: 0, y: 0, z: 0 }),
    ]);

    const hit = runtime.pick(0, 0);
    expect(hit?.kind).toBe('ground');
    if (hit?.kind === 'ground') {
      expect(hit.point.x).toBeCloseTo(0, 6);
      expect(hit.point.z).toBeCloseTo(0, 6);
    }

    runtime.dispose();
  });

  it('ignores an invisible node and falls through to the ground', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('entity:actor' as NodeId, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }, IDENTITY, false),
    ]);

    expect(runtime.pick(0, 0)?.kind).toBe('ground');

    runtime.dispose();
  });
});

describe('three runtime GLB pipeline (injected loader)', () => {
  /** A 1x1x1 box template whose base sits at y = 0. */
  function makeTemplate(materialOverride?: MeshStandardMaterial): Group {
    const group = new Group();
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      materialOverride ?? new MeshStandardMaterial({ color: 0xff8844 }),
    );
    mesh.position.y = 0.5;
    group.add(mesh);
    return group;
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('keeps the placeholder until the load resolves, then shares one parse across two node clones', async () => {
    const template = makeTemplate();
    const loads: string[] = [];
    const loadModel: ModelLoader = (url) => {
      loads.push(url);
      return Promise.resolve(template);
    };
    const catalogue = {
      [asAppearanceId('appearance.tree')]: { url: '/models/tree.glb' },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });

    runtime.apply([
      createCommand('entity:t1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
      createCommand('entity:t2' as NodeId, 'object', appearanceTree, { x: 2, y: 0, z: 0 }),
    ]);

    // The procedural placeholder is the immediate visual: a tall tree.
    expect(findNode(runtime, 'entity:t1' as NodeId).model).toBe('loading');
    expect(findNode(runtime, 'entity:t1' as NodeId).visualTopY).toBeGreaterThan(1);

    await flush();

    // Both nodes swapped to the model (one cached parse, one clone per node).
    const first = findNode(runtime, 'entity:t1' as NodeId);
    const second = findNode(runtime, 'entity:t2' as NodeId);
    expect(first.model).toBe('loaded');
    expect(second.model).toBe('loaded');
    // Only one template exists, but each node has its own visual.
    expect(runtime.inspect().models).toBe(1);
    expect(loads).toEqual(['/models/tree.glb']);
    // Height accounting re-measured off the model, not the retired placeholder.
    expect(first.visualTopY).toBeCloseTo(1, 6);
    expect(second.visualTopY).toBeCloseTo(1, 6);

    runtime.dispose();
  });

  it('keeps the placeholder and records failure when the loader rejects', async () => {
    const loadModel: ModelLoader = () => Promise.reject(new Error('404'));
    const catalogue = {
      [asAppearanceId('appearance.tree')]: { url: '/models/missing.glb' },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runtime.apply([
      createCommand('entity:t1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
    ]);
    await flush();

    const node = findNode(runtime, 'entity:t1' as NodeId);
    expect(node.model).toBe('failed');
    // The placeholder is still there and still visible.
    expect(node.visualTopY).toBeGreaterThan(1);
    expect(node.visible).toBe(true);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    runtime.dispose();
  });

  it('coerces a blended material to an alpha-tested opaque material and reports it', async () => {
    const blended = new MeshStandardMaterial({ color: 0xff0000, transparent: true, alphaTest: 0 });
    blended.name = 'artist-blend';
    const template = makeTemplate(blended);
    const loadModel: ModelLoader = () => Promise.resolve(template);
    const catalogue = {
      [asAppearanceId('appearance.tree')]: { url: '/models/cutout.glb' },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });

    runtime.apply([
      createCommand('entity:t1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
    ]);
    await flush();

    // The parsed template's material is coerced once, so every clone shares it.
    expect(blended.transparent).toBe(false);
    expect(blended.alphaTest).toBeGreaterThan(0);
    // The coercion is no longer silent: one warning names the material and asset.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('artist-blend');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('/models/cutout.glb');

    warnSpy.mockRestore();
    runtime.dispose();
  });

  it('uses the skeleton-aware clone for a skinned template', async () => {
    const skinned = (() => {
      const geometry = new BoxGeometry(1, 1, 1);
      const vertexCount = geometry.attributes.position.count;
      geometry.setAttribute(
        'skinIndex',
        new Uint16BufferAttribute(new Uint16Array(vertexCount * 4), 4),
      );
      const weights = new Float32Array(vertexCount * 4);
      for (let i = 0; i < vertexCount; i += 1) {
        weights[i * 4] = 1;
      }
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
      const bone = new Bone();
      const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: 0x33aa55 }));
      mesh.add(bone);
      mesh.bind(new Skeleton([bone]));
      const group = new Group();
      group.add(mesh);
      return group;
    })();
    const loadModel: ModelLoader = () => Promise.resolve(skinned);
    const catalogue = {
      [asAppearanceId('appearance.character')]: { url: '/models/rig.glb' },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });

    runtime.apply([
      createCommand('entity:a' as NodeId, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }),
      createCommand('entity:b' as NodeId, 'object', appearanceCharacter, { x: 2, y: 0, z: 0 }),
    ]);
    await flush();

    const first = findNode(runtime, 'entity:a' as NodeId);
    const second = findNode(runtime, 'entity:b' as NodeId);
    expect(first.model).toBe('loaded');
    expect(second.model).toBe('loaded');
    expect(runtime.inspect().models).toBe(1);
    // `SkeletonUtils.clone` (not a plain `clone(true)`) produced the two node
    // visuals. A plain clone shares the source `SkinnedMesh`'s skeleton, so the
    // two ids would be equal; independent skeletons prove the skeleton-aware
    // branch ran and each clone owns its bones.
    expect(first.skeletonId).not.toBeNull();
    expect(second.skeletonId).not.toBeNull();
    expect(first.skeletonId).not.toBe(second.skeletonId);

    runtime.dispose();
  });

  it('releases the loaded template resources on dispose and counts them', async () => {
    const loadModel: ModelLoader = () => Promise.resolve(makeTemplate());
    const catalogue = {
      [asAppearanceId('appearance.tree')]: { url: '/models/tree.glb' },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });

    runtime.apply([
      createCommand('entity:t1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
    ]);
    await flush();
    expect(runtime.inspect().models).toBe(1);

    runtime.dispose();

    const after = runtime.inspect();
    expect(after.models).toBe(0);
    // The placeholder tree (3 meshes) plus the box template have been released.
    expect(after.released.geometries).toBeGreaterThanOrEqual(4);
    expect(after.released.materials).toBeGreaterThanOrEqual(4);
  });

  it('never lets a load that resolves after dispose add to the scene', async () => {
    let resolveTemplate: (template: Group) => void = () => {};
    const loadModel: ModelLoader = () =>
      new Promise<Group>((resolve) => {
        resolveTemplate = resolve;
      });
    const catalogue = {
      [asAppearanceId('appearance.tree')]: { url: '/models/slow.glb' },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel, catalogue });

    runtime.apply([
      createCommand('entity:t1' as NodeId, 'object', appearanceTree, { x: 0, y: 0, z: 0 }),
    ]);
    runtime.dispose();

    resolveTemplate(makeTemplate());
    await flush();

    const after = runtime.inspect();
    expect(after.nodes).toHaveLength(0);
    expect(after.models).toBe(0);
    // The late template was released immediately rather than leaked.
    expect(after.released.geometries).toBeGreaterThanOrEqual(4);
  });
});

describe('three runtime GLB real-file path', () => {
  it('loads the checked-in box.glb through the real GLTFLoader, clones for two nodes, and disposes', async () => {
    // Node has no `ProgressEvent`; browsers do. `FileLoader` constructs one while
    // streaming the response, so the minimal shape is polyfilled for this test.
    const globalWithProgress = globalThis as { ProgressEvent?: unknown };
    const originalProgressEvent = globalWithProgress.ProgressEvent;
    globalWithProgress.ProgressEvent = class ProgressEvent extends Event {
      readonly lengthComputable: boolean;
      readonly loaded: number;
      readonly total: number;
      constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
        super(type);
        this.lengthComputable = init.lengthComputable ?? false;
        this.loaded = init.loaded ?? 0;
        this.total = init.total ?? 0;
      }
    };

    try {
      const bytes = readFileSync(new URL('./fixtures/box.glb', import.meta.url));
      const dataUrl = `data:model/gltf-binary;base64,${bytes.toString('base64')}`;
      const catalogue = {
        [asAppearanceId('appearance.character')]: { url: dataUrl },
      };
      // No `loadModel`: the PRODUCTION default (real GLTFLoader) is exercised.
      const runtime = createThreeRuntime({ bounds: BOUNDS, catalogue });

      runtime.apply([
        createCommand('entity:hero' as NodeId, 'object', appearanceCharacter, { x: 0, y: 0, z: 0 }),
        createCommand('entity:hero2' as NodeId, 'object', appearanceCharacter, { x: 2, y: 0, z: 0 }),
      ]);
      expect(findNode(runtime, 'entity:hero' as NodeId).model).toBe('loading');

      await vi.waitFor(() => {
        expect(findNode(runtime, 'entity:hero' as NodeId).model).toBe('loaded');
        expect(findNode(runtime, 'entity:hero2' as NodeId).model).toBe('loaded');
      });

      // One parse for the URL, two visual clones (placeholder replaced by the box).
      expect(runtime.inspect().models).toBe(1);
      expect(findNode(runtime, 'entity:hero' as NodeId).visualTopY).toBeCloseTo(0.5, 6);
      expect(findNode(runtime, 'entity:hero2' as NodeId).visualTopY).toBeCloseTo(0.5, 6);
      // The prefab's shadow intent (character: casts, does not receive) survives
      // the swap. `GLTFLoader` leaves the clone's flags false, so without
      // re-applying the intent these would read back false and real art would
      // silently cast no shadows while the placeholder did.
      expect(findNode(runtime, 'entity:hero' as NodeId).castsShadow).toBe(true);
      expect(findNode(runtime, 'entity:hero' as NodeId).receivesShadow).toBe(false);

      runtime.dispose();
      expect(runtime.inspect().models).toBe(0);
      expect(runtime.inspect().released.geometries).toBeGreaterThanOrEqual(1);
    } finally {
      globalWithProgress.ProgressEvent = originalProgressEvent;
    }
  });
});
