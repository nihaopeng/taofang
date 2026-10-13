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
  DEFAULT_CELL_SIZE,
  KNOWN_APPEARANCES,
  RENDER_CAMERA,
  createThreeRuntime,
  perspectiveFrustum,
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

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Camera right axis in world space (forward × up), rebuilt from plain inspect data. */
function cameraRight(camera: RenderInspection['camera']): Vec3 {
  return cross(camera.forward, camera.up);
}

/** Project a world point to NDC through the perspective rig's real inspect data. */
function projectToNdc(
  point: Vec3,
  camera: RenderInspection['camera'],
): { x: number; y: number } {
  const right = cameraRight(camera);
  const relative = subtract(point, camera.position);
  const depth = dot(relative, camera.forward);
  const tanHalfFov = Math.tan((camera.fovDegrees * Math.PI) / 360);
  return {
    x: dot(relative, right) / (tanHalfFov * camera.aspect * depth),
    y: dot(relative, camera.up) / (tanHalfFov * depth),
  };
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

  it('reports an exact unit scale for every node in a normal frame', () => {
    const runtime = makeRuntime();
    runtime.apply(makeWorldFrame());

    // The bridge sends UNIT_SCALE for every node, and the runtime must not invent
    // a per-node/per-terrain scale. Any anomalous scale would break this, and a
    // scale is exactly what would fake a per-terrain footprint change.
    for (const node of runtime.inspect().nodes) {
      expect(node.scale).toEqual({ x: 1, y: 1, z: 1 });
    }

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

  it('locks the pitch as a fixed constant with no adjustable path', () => {
    const runtime = makeRuntime();

    // Phase 12: the locked pitch is exactly 35 degrees. It is ONE named constant
    // in RENDER_CAMERA; the flatter value is a deliberate composition decision.
    expect(RENDER_CAMERA.pitchDegrees).toBe(35);

    // The default stance reports the fixed pitch through both accessors.
    expect(runtime.getCameraState().pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
    expect(runtime.inspect().camera.pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);

    // A yaw change (the only orientation field that exists) never drifts the
    // pitch, and there is no runtime way to set it otherwise.
    runtime.setCameraOrientation({ yawDegrees: 123 });
    expect(runtime.getCameraState().pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
    expect(runtime.inspect().camera.pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
    expect(runtime.getCameraState().yawDegrees).toBe(123);

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
    expect(forwardAtNinety.x).toBeCloseTo(-Math.cos((RENDER_CAMERA.pitchDegrees * Math.PI) / 180), 6);
    expect(forwardAtNinety.z).toBeCloseTo(0, 6);

    runtime.setCameraOrientation({ yawDegrees: -90 });
    expect(runtime.getCameraState().yawDegrees).toBe(270);

    runtime.dispose();
  });

  it('changes the perspective distance with zoom, clamped to the rig limits', () => {
    const runtime = makeRuntime();
    const base = runtime.inspect().camera;
    const baseDistance = Math.hypot(base.position.x, base.position.y, base.position.z);

    runtime.setZoom(2);
    const zoomedIn = runtime.inspect().camera;
    const zoomedDistance = Math.hypot(
      zoomedIn.position.x,
      zoomedIn.position.y,
      zoomedIn.position.z,
    );
    // Zoom keeps the narrow FOV fixed and scales the camera DISTANCE (larger zoom
    // is closer), so the visible half-height at the focus plane halves.
    expect(zoomedIn.fovDegrees).toBe(base.fovDegrees);
    const tanHalf = Math.tan((base.fovDegrees * Math.PI) / 360);
    expect(zoomedDistance).toBeCloseTo(baseDistance / 2, 6);
    expect(zoomedDistance * tanHalf).toBeCloseTo((baseDistance * tanHalf) / 2, 6);
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

  it('keeps the oversized backdrop out of shadowing while the terrain still receives', () => {
    const runtime = makeRuntime();
    runtime.apply([createCommand('tile:0,0' as NodeId, 'base', appearanceGrass)]);

    const inspection = runtime.inspect();
    const backdrop = inspection.backdrop;
    expect(backdrop).not.toBeNull();
    if (backdrop === null) {
      return;
    }

    // A mutation that re-enables `receiveShadow` (or makes the backdrop cast) on
    // the oversized base would fail here. The backdrop extends far past the +-10
    // shadow frustum, so a shadow lookup on it clamps to the border texel and
    // paints a false world-space boundary (the reported "trapezoid").
    expect(backdrop.receivesShadow).toBe(false);
    expect(backdrop.castsShadow).toBe(false);

    // The terrain plates are inside the shadow frustum and remain the visible
    // lit ground, so they must KEEP receiving shadows.
    expect(findNode(runtime, 'tile:0,0' as NodeId).receivesShadow).toBe(true);

    runtime.dispose();
  });

  it('sizes the shadow frustum from the WORLD bounds, never from the visible ground', () => {
    const runtime = makeRuntime();

    // The orthographic shadow camera covers the world plus a fixed margin. For
    // the default 12x12 world that is max(12, 12) / 2 + 4 = 10 world units. It
    // must NOT be derived from the visible ground footprint: that footprint
    // depends on pitch and zoom, and coupling the two would grow the shadow
    // frustum (and collapse the 1024x1024 shadow map's resolution) as the
    // flatter camera or the zoomed-out view reveals more floor.
    const expectedExtent =
      Math.max(BOUNDS.max.x - BOUNDS.min.x, BOUNDS.max.z - BOUNDS.min.z) / 2 + 4;
    const base = runtime.inspect();
    expect(base.shadow?.extent).toBe(expectedExtent);
    const baseBackdrop = base.backdrop;
    expect(baseBackdrop).not.toBeNull();

    // Zoom changes the visible ground (and therefore the backdrop) by a large
    // factor while the shadow extent stays exactly the world-derived value.
    runtime.setZoom(RENDER_CAMERA.minZoom);
    const zoomedOut = runtime.inspect();
    expect(zoomedOut.shadow?.extent).toBe(expectedExtent);
    runtime.setZoom(RENDER_CAMERA.maxZoom);
    const zoomedIn = runtime.inspect();
    expect(zoomedIn.shadow?.extent).toBe(expectedExtent);

    // Prove the backdrop really did change size, so the constancy above is not
    // vacuous.
    expect(zoomedOut.backdrop?.sizeX).toBeGreaterThan(zoomedIn.backdrop?.sizeX ?? 0);

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

  it('frames the world with the narrow-FOV perspective projection and reports the frustum honestly', () => {
    const runtime = makeRuntime();
    const { camera } = runtime.inspect();

    // Phase 11 Wave D: a pure orbit with a completely constant projection.
    // `inspect()` must describe the frustum it actually uses, and the FOV is a
    // fixed constant, not the per-yaw derivation Wave C used.
    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(camera.near);
    expect(camera.aspect).toBe(1);
    expect(camera.fovDegrees).toBe(RENDER_CAMERA.fovDegrees);

    // The camera distance is fixed by the WORST-CASE yaw fit (the box diagonal)
    // at the fixed FOV, so rotating cannot dolly it.
    const diagonal = Math.hypot(
      (BOUNDS.max.x - BOUNDS.min.x) / 2,
      (BOUNDS.max.z - BOUNDS.min.z) / 2,
    );
    const worstHalfHeight =
      Math.max(
        diagonal * Math.sin((RENDER_CAMERA.pitchDegrees * Math.PI) / 180) +
          RENDER_CAMERA.verticalHeadroom,
        diagonal,
      ) * RENDER_CAMERA.framingMargin;
    const expectedDistance =
      worstHalfHeight / Math.tan((RENDER_CAMERA.fovDegrees * Math.PI) / 360);
    const distance = Math.hypot(camera.position.x, camera.position.y, camera.position.z);
    expect(distance).toBeCloseTo(expectedDistance, 6);

    // The visible focus-plane half-height is the WORST-CASE fit itself, because
    // the fixed FOV and the worst-case distance cancel (distance * tan(fov/2) =
    // worstHalfHeight). At the axis-aligned yaws the world then sits further
    // inside the frame; it never grows with yaw.
    expect(distance * Math.tan((camera.fovDegrees * Math.PI) / 360)).toBeCloseTo(
      worstHalfHeight,
      6,
    );

    // Frozen default stance: yaw 0, pitched down by exactly the fixed pitch.
    expect(camera.forward.x).toBeCloseTo(0, 6);
    expect(camera.forward.y).toBeCloseTo(
      -Math.sin((RENDER_CAMERA.pitchDegrees * Math.PI) / 180),
      6,
    );
    expect(camera.forward.z).toBeCloseTo(
      -Math.cos((RENDER_CAMERA.pitchDegrees * Math.PI) / 180),
      6,
    );
    expect(camera.up.y).toBeGreaterThan(0);

    // Cross-check the projection helper for the same arguments: it is the single
    // source of the fit, the distance, and near/far.
    const expected = perspectiveFrustum({
      bounds: BOUNDS,
      aspect: 1,
      pitchDegrees: RENDER_CAMERA.pitchDegrees,
      yawDegrees: 0,
      zoom: 1,
    });
    expect(expected.fovDegrees).toBe(camera.fovDegrees);
    expect(expected.halfHeight).toBeCloseTo(worstHalfHeight, 6);
    expect(expected.halfWidth).toBeCloseTo(worstHalfHeight, 6);
    expect(camera.near).toBe(expected.near);
    expect(camera.far).toBe(expected.far);
    expect(camera.aspect).toBe(expected.aspect);
    expect(distance).toBeCloseTo(expected.distance, 6);

    runtime.dispose();
  });

  it('grows the vertical extent to fit a world wider than the canvas aspect, keeping scale uniform', () => {
    // A portrait canvas (aspect 0.5): the aspect-derived half-width would crop
    // the 12-wide world, so the single uniform half-height grows until
    // halfWidth matches the full world width at the worst yaw. The framing margin
    // then scales both axes together, and the fixed-FOV distance follows.
    const frustum = perspectiveFrustum({
      bounds: BOUNDS,
      aspect: 0.5,
      pitchDegrees: RENDER_CAMERA.pitchDegrees,
      yawDegrees: 0,
      zoom: 1,
    });
    const framing = RENDER_CAMERA.framingMargin;
    const diagonal = Math.hypot(
      (BOUNDS.max.x - BOUNDS.min.x) / 2,
      (BOUNDS.max.z - BOUNDS.min.z) / 2,
    );
    const worstHalfHeight =
      Math.max(
        diagonal * Math.sin((RENDER_CAMERA.pitchDegrees * Math.PI) / 180) +
          RENDER_CAMERA.verticalHeadroom,
        diagonal / 0.5,
      ) * framing;
    // The focus-plane half-height is the WORST-CASE fit (not the axis-aligned
    // fit Wave C derived): the FOV is fixed and the distance carries the fit.
    expect(frustum.halfHeight).toBeCloseTo(worstHalfHeight, 6);
    expect(frustum.halfWidth).toBeCloseTo(worstHalfHeight * 0.5, 6);
    expect(frustum.halfWidth / frustum.halfHeight).toBeCloseTo(0.5, 6);
    expect(frustum.fovDegrees).toBe(RENDER_CAMERA.fovDegrees);
    // A different canvas aspect changes the fixed distance (the fit scales), not
    // the FOV mechanism.
    expect(frustum.distance).toBeCloseTo(
      worstHalfHeight / Math.tan((RENDER_CAMERA.fovDegrees * Math.PI) / 360),
      6,
    );
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

describe('three runtime terrain differentiation (phase 9)', () => {
  it('differentiates path by a full-cell recessed step, never by a shrunken raised pad', () => {
    const runtime = makeRuntime();
    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass, { x: 0, y: 0, z: 0 }),
      createCommand('tile:1,0' as NodeId, 'base', appearancePath, { x: 1, y: 0, z: 0 }),
    ]);

    const grass = findNode(runtime, 'tile:0,0' as NodeId);
    const path = findNode(runtime, 'tile:1,0' as NodeId);

    // The allowed cue is a VERTICAL step on a FULL-cell plate (path is paved slightly
    // below the grass). A per-cell raised inlay (the old `cellSize * 0.7` plate) is
    // forbidden: a shrunken flat pad inside every cell reads as a smaller tile, which
    // is exactly the artefact phase 9 removed. This assertion also fails if such a pad
    // is reintroduced, because the pad would raise `visualTopY` above the grass surface.
    expect(grass.visualTopY).toBeCloseTo(0, 6);
    expect(path.visualTopY).toBeLessThan(grass.visualTopY);

    // ...and neither cue may touch the horizontal footprint, so neighbours share edges.
    expect(grass.footprintX).toBeCloseTo(DEFAULT_CELL_SIZE, 6);
    expect(grass.footprintZ).toBeCloseTo(DEFAULT_CELL_SIZE, 6);
    expect(path.footprintX).toBeCloseTo(DEFAULT_CELL_SIZE, 6);
    expect(path.footprintZ).toBeCloseTo(DEFAULT_CELL_SIZE, 6);

    runtime.dispose();
  });
});

describe('three runtime seamless terrain footprint (phase 9)', () => {
  const TERRAIN_APPEARANCES = [
    appearanceGrass,
    appearancePath,
    appearanceBlocked,
    appearanceWater,
  ];

  it('measures every terrain plate at exactly cellSize on both axes (no inset)', () => {
    const runtime = makeRuntime();
    const frame: RenderFrame = TERRAIN_APPEARANCES.map((appearance, index) =>
      createCommand(`tile:${index},0` as NodeId, 'base', appearance, {
        x: index,
        y: 0,
        z: 0,
      }),
    );
    runtime.apply(frame);

    for (const appearance of TERRAIN_APPEARANCES) {
      const node = runtime
        .inspect()
        .nodes.find((candidate) => candidate.appearance === appearance);
      if (node === undefined) {
        throw new Error(`terrain ${appearance} was not created`);
      }
      // Measured off the real geometry, never the intended value: reintroducing
      // any per-terrain inset (the old 0.96 / 0.98 / 0.70 footprint plates) makes
      // this fail, which is the "no shrink, no seams" proof.
      expect(node.footprintX).toBeCloseTo(DEFAULT_CELL_SIZE, 6);
      expect(node.footprintZ).toBeCloseTo(DEFAULT_CELL_SIZE, 6);
    }

    runtime.dispose();
  });

  it('honours a non-default grid cellSize for the terrain footprint', () => {
    const cellSize = 2;
    const runtime = createThreeRuntime({
      bounds: BOUNDS,
      grid: { origin: { x: -6, y: 0, z: -6 }, width: 6, depth: 6, cellSize },
    });
    runtime.apply([
      createCommand('tile:0,0' as NodeId, 'base', appearanceGrass, { x: 0, y: 0, z: 0 }),
      createCommand('tile:1,0' as NodeId, 'base', appearancePath, {
        x: cellSize,
        y: 0,
        z: 0,
      }),
    ]);

    for (const node of runtime.inspect().nodes) {
      expect(node.footprintX).toBeCloseTo(cellSize, 6);
      expect(node.footprintZ).toBeCloseTo(cellSize, 6);
    }

    runtime.dispose();
  });
});

describe('three runtime grid overlay (phase 9)', () => {
  /** 100 grass tiles, plus the world, so the overlay is provably not per-tile. */
  function hundredTileFrame(): RenderFrame {
    const frame: NodeCreateCommand[] = [];
    for (let cellZ = 0; cellZ < 10; cellZ += 1) {
      for (let cellX = 0; cellX < 10; cellX += 1) {
        frame.push(
          createCommand(
            `tile:${cellX},${cellZ}` as NodeId,
            'base',
            appearanceGrass,
            { x: cellX - 5, y: 0, z: cellZ - 5 },
          ),
        );
      }
    }
    return frame;
  }

  it('is hidden by default and toggles visibility through the runtime API', () => {
    const runtime = makeRuntime();
    expect(runtime.inspect().gridOverlay.visible).toBe(false);

    runtime.setGridOverlayVisible(true);
    expect(runtime.inspect().gridOverlay.visible).toBe(true);

    runtime.setGridOverlayVisible(false);
    expect(runtime.inspect().gridOverlay.visible).toBe(false);

    runtime.dispose();
  });

  it('records a highlighted cell and clears it with null', () => {
    const runtime = makeRuntime();
    expect(runtime.inspect().gridOverlay.highlightedCell).toBeNull();

    runtime.setHighlightedCell({ x: 3, z: -2 });
    expect(runtime.inspect().gridOverlay.highlightedCell).toEqual({ x: 3, z: -2 });

    runtime.setHighlightedCell(null);
    expect(runtime.inspect().gridOverlay.highlightedCell).toBeNull();

    runtime.dispose();
  });

  it('holds exactly one line object and one marker regardless of tile count', () => {
    const runtime = makeRuntime();
    runtime.apply(hundredTileFrame());

    // 100 terrain nodes exist, yet the overlay is still one line object plus one
    // reusable marker: it is built from the grid spec, not from the tiles. A
    // per-tile implementation would report 100 here.
    expect(runtime.inspect().nodes).toHaveLength(100);
    const overlay = runtime.inspect().gridOverlay;
    expect(overlay.lineObjectCount).toBe(1);
    expect(overlay.highlightMarkerCount).toBe(1);

    runtime.dispose();
  });

  it('releases the overlay resources on dispose', () => {
    const runtime = makeRuntime();
    const geometriesBefore = runtime.inspect().released.geometries;

    runtime.dispose();

    const after = runtime.inspect();
    expect(after.gridOverlay.visible).toBe(false);
    expect(after.gridOverlay.highlightedCell).toBeNull();
    expect(after.gridOverlay.lineObjectCount).toBe(0);
    expect(after.gridOverlay.highlightMarkerCount).toBe(0);
    // The line geometry and the marker geometry were actually released, not only
    // detached with WorldRoot.
    expect(after.released.geometries).toBeGreaterThanOrEqual(geometriesBefore + 2);
  });
});

describe('three runtime rotation stability (phase 11: perspective)', () => {
  it('holds a valid perspective frustum, exact pitch, zoom, focus and a yaw-constant projection across a full yaw sweep', () => {
    const runtime = makeRuntime();
    const focus = runtime.inspect().camera.focus;
    const zoom = runtime.getCameraState().zoom;
    // Baseline the yaw-invariant projection at yaw 0, then require every other
    // yaw to match it exactly.
    const baseline = runtime.inspect().camera;
    const orbitDistance = Math.hypot(
      baseline.position.x - baseline.focus.x,
      baseline.position.y - baseline.focus.y,
      baseline.position.z - baseline.focus.z,
    );
    const orbitHeight = baseline.position.y - baseline.focus.y;
    const orbitNear = baseline.near;
    const orbitFar = baseline.far;

    for (let yaw = 0; yaw < 360; yaw += 15) {
      runtime.setCameraOrientation({ yawDegrees: yaw });
      const camera = runtime.inspect().camera;

      // A valid, honest perspective frustum at every yaw (phase 11 replaced the
      // ortho left/right/top/bottom fields). Wave D holds the FOV at a fixed
      // constant: it does NOT vary per yaw.
      expect(camera.fovDegrees).toBe(RENDER_CAMERA.fovDegrees);
      expect(camera.near).toBeGreaterThan(0);
      expect(camera.far).toBeGreaterThan(camera.near);
      expect(camera.aspect).toBe(1);
      // Rotation never drifts the pitch, zoom or focus.
      expect(camera.pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
      expect(runtime.getCameraState().pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
      expect(camera.zoom).toBe(zoom);
      expect(camera.focus).toEqual(focus);

      // Wave D pure orbit with a constant projection: the camera's radius and
      // height about the focus, and the near/far clip distances, are identical
      // at every yaw. The fixed FOV means nothing absorbs the fit per yaw.
      const offset = {
        x: camera.position.x - camera.focus.x,
        y: camera.position.y - camera.focus.y,
        z: camera.position.z - camera.focus.z,
      };
      const distance = Math.hypot(offset.x, offset.y, offset.z);
      expect(distance).toBeCloseTo(orbitDistance, 9);
      expect(offset.y).toBeCloseTo(orbitHeight, 9);
      expect(camera.near).toBeCloseTo(orbitNear, 9);
      expect(camera.far).toBeCloseTo(orbitFar, 9);

      // Phase 11 deliberately gives up "the projection is affine". Across the
      // view (vertical NDC), equal NDC steps map to LARGER world steps farther
      // from the camera — real foreshortening, not a restated identity. The step
      // is kept small (0.1) because at the flatter phase-12 pitch (45) the
      // visible ground reaches much farther, so a larger NDC would project past
      // the world bounds and `pick()` would (correctly) return `null`.
      const first = runtime.pick(0, 0);
      const second = runtime.pick(0, 0.1);
      const third = runtime.pick(0, 0.2);
      expect(first?.kind).toBe('ground');
      expect(second?.kind).toBe('ground');
      expect(third?.kind).toBe('ground');
      if (first?.kind === 'ground' && second?.kind === 'ground' && third?.kind === 'ground') {
        const nearStep = Math.hypot(second.point.x - first.point.x, second.point.z - first.point.z);
        const farStep = Math.hypot(third.point.x - second.point.x, third.point.z - second.point.z);
        expect(farStep).toBeGreaterThan(nearStep);
      }
    }

    // Explicitly pin the cardinal yaws named by the acceptance contract.
    for (const yaw of [90, 180, 270]) {
      runtime.setCameraOrientation({ yawDegrees: yaw });
      const camera = runtime.inspect().camera;
      expect(camera.pitchDegrees).toBe(RENDER_CAMERA.pitchDegrees);
      expect(runtime.getCameraState().yawDegrees).toBe(yaw);
    }

    runtime.dispose();
  });
});

describe('three runtime unbounded backdrop and framing margin (phase 11)', () => {
  const MIN_ZOOM = RENDER_CAMERA.minZoom;

  /** 12x12 grass tiles whose combined footprint is exactly the world bounds. */
  function tileWorldFrame(): NodeCreateCommand[] {
    const frame: NodeCreateCommand[] = [];
    for (let cellZ = 0; cellZ < 12; cellZ += 1) {
      for (let cellX = 0; cellX < 12; cellX += 1) {
        frame.push(
          createCommand(`tile:${cellX},${cellZ}` as NodeId, 'base', appearanceGrass, {
            x: cellX - 6 + 0.5,
            y: 0,
            z: cellZ - 6 + 0.5,
          }),
        );
      }
    }
    return frame;
  }

  it('keeps the world silhouette off the viewport edge at every yaw, at default and minimum zoom', () => {
    // The framing margin is a real gap, not decoration. The perspective fit puts
    // the fit-driving FOCUS-plane corner at |ndc| = 1 / framingMargin; the near
    // ground corners project a little larger than that (real foreshortening),
    // but must stay strictly inside the viewport. Removing the margin
    // (framingMargin = 1) makes the near corners cross |ndc| = 1 and fails here.
    const FIT_NDC = 1 / RENDER_CAMERA.framingMargin;
    // Measured worst case at zoom 1 (yaw 0/90/180/270) for this 12x12 world.
    const PERSPECTIVE_NEAR_NDC = 0.93;
    expect(FIT_NDC).toBeLessThanOrEqual(0.95);

    const runtime = makeRuntime();
    runtime.apply(tileWorldFrame());

    for (const zoom of [1, MIN_ZOOM]) {
      runtime.setZoom(zoom);
      for (let yaw = 0; yaw < 360; yaw += 15) {
        runtime.setCameraOrientation({ yawDegrees: yaw });
        const camera = runtime.inspect().camera;
        let maxNdc = 0;
        for (const node of runtime.inspect().nodes) {
          for (const signX of [-1, 1]) {
            for (const signZ of [-1, 1]) {
              const corner: Vec3 = {
                x: node.world.x + (signX * node.footprintX) / 2,
                y: node.world.y,
                z: node.world.z + (signZ * node.footprintZ) / 2,
              };
              const ndc = projectToNdc(corner, camera);
              maxNdc = Math.max(maxNdc, Math.abs(ndc.x), Math.abs(ndc.y));
            }
          }
        }
        // Strictly inside the viewport: the silhouette never touches the edge.
        // At the most zoomed-out state the world is far smaller on screen.
        expect(maxNdc).toBeLessThanOrEqual(PERSPECTIVE_NEAR_NDC + 1e-9);
      }
    }

    runtime.dispose();
  });

  it('derives the near plane from the geometry so nothing visible is clipped at any yaw or zoom', () => {
    // Wave C replaces the old fixed `near = 0.1`. The near plane is now derived
    // from the world radius and clamped below the nearest VISIBLE ground depth,
    // so at every yaw and every zoom it must sit strictly in front of the
    // nearest ground ray and behind it for `far`.
    const runtime = makeRuntime();
    const groundY = BOUNDS.min.y;

    for (const zoom of [MIN_ZOOM, 0.5, 1, 2, 4, RENDER_CAMERA.maxZoom]) {
      runtime.setZoom(zoom);
      for (let yaw = 0; yaw < 360; yaw += 15) {
        runtime.setCameraOrientation({ yawDegrees: yaw });
        const camera = runtime.inspect().camera;
        expect(camera.near).toBeGreaterThan(0);
        expect(camera.far).toBeGreaterThan(camera.near);

        const right = cameraRight(camera);
        const tanHalfFov = Math.tan((camera.fovDegrees * Math.PI) / 360);
        let minDepth = Number.POSITIVE_INFINITY;
        let maxDepth = 0;
        for (const u of [-1, 1]) {
          for (const v of [-1, 1]) {
            const dir: Vec3 = {
              x:
                camera.forward.x +
                right.x * u * tanHalfFov * camera.aspect +
                camera.up.x * v * tanHalfFov,
              y: camera.forward.y + camera.up.y * v * tanHalfFov,
              z:
                camera.forward.z +
                right.z * u * tanHalfFov * camera.aspect +
                camera.up.z * v * tanHalfFov,
            };
            const t = (groundY - camera.position.y) / dir.y;
            expect(t).toBeGreaterThan(0);
            const depth = Math.hypot(t * dir.x, t * dir.y, t * dir.z);
            minDepth = Math.min(minDepth, depth);
            maxDepth = Math.max(maxDepth, depth);
          }
        }
        // Near is strictly closer than the nearest visible ground (no hole in
        // the backdrop), and far is strictly beyond the farthest ground.
        expect(camera.near).toBeLessThan(minDepth);
        expect(camera.far).toBeGreaterThan(maxDepth);
      }
    }

    runtime.dispose();
  });

  it('sizes the single backdrop so the min-zoom perspective footprint always lands well inside it', () => {
    const runtime = makeRuntime();
    const groundY = BOUNDS.min.y;

    for (const zoom of [1, MIN_ZOOM]) {
      runtime.setZoom(zoom);
      for (let yaw = 0; yaw < 360; yaw += 15) {
        runtime.setCameraOrientation({ yawDegrees: yaw });
        const camera = runtime.inspect().camera;
        const backdrop = runtime.inspect().backdrop;
        expect(backdrop).not.toBeNull();
        if (backdrop === null) {
          continue;
        }
        const right = cameraRight(camera);
        const tanHalfFov = Math.tan((camera.fovDegrees * Math.PI) / 360);
        const backdropHalfX = backdrop.sizeX / 2;
        const backdropHalfZ = backdrop.sizeZ / 2;

        // The four viewport corners cast rays that meet the ground; every one
        // must land inside the backdrop — and with a real gap (the overshoot).
        for (const u of [-1, 1]) {
          for (const v of [-1, 1]) {
            const dir: Vec3 = {
              x:
                camera.forward.x +
                right.x * u * tanHalfFov * camera.aspect +
                camera.up.x * v * tanHalfFov,
              y: camera.forward.y + camera.up.y * v * tanHalfFov,
              z:
                camera.forward.z +
                right.z * u * tanHalfFov * camera.aspect +
                camera.up.z * v * tanHalfFov,
            };
            const t = (groundY - camera.position.y) / dir.y;
            expect(t).toBeGreaterThan(0);
            const offsetX = Math.abs(camera.position.x + t * dir.x - backdrop.center.x);
            const offsetZ = Math.abs(camera.position.z + t * dir.z - backdrop.center.z);
            // Strictly inside, so the silhouette is off-screen...
            expect(offsetX).toBeLessThanOrEqual(backdropHalfX);
            expect(offsetZ).toBeLessThanOrEqual(backdropHalfZ);
            // ...and well inside: the edge keeps >=20% of its half-extent as gap.
            expect(offsetX).toBeLessThanOrEqual(backdropHalfX * 0.8);
            expect(offsetZ).toBeLessThanOrEqual(backdropHalfZ * 0.8);
          }
        }
      }
    }

    runtime.dispose();
  });

  it('uses one backdrop mesh, below the terrain, released on dispose', () => {
    const runtime = makeRuntime();
    const backdrop = runtime.inspect().backdrop;
    expect(backdrop).not.toBeNull();
    if (backdrop === null) {
      return;
    }
    // Far larger than a bounds-sized floor (the exact-fit floor was what showed
    // a clipped inverted trapezoid) and below the terrain plates.
    expect(backdrop.sizeX).toBeGreaterThan((BOUNDS.max.x - BOUNDS.min.x) * 3);
    expect(backdrop.sizeZ).toBeGreaterThan((BOUNDS.max.z - BOUNDS.min.z) * 3);
    expect(backdrop.center.x).toBeCloseTo(0, 6);
    expect(backdrop.center.z).toBeCloseTo(0, 6);
    expect(backdrop.center.y).toBeLessThan(BOUNDS.min.y);

    runtime.dispose();
    expect(runtime.inspect().backdrop).toBeNull();
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
