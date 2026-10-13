/**
 * Asset-descriptor swap + AnimationMixer tests (render-owned, no WebGL).
 *
 * These prove the two properties the Entity GLB pipeline must have:
 *
 * 1. an asset descriptor is PRESENTATION metadata — swapping it (or removing it)
 *    can only change how a node is drawn, never an authoritative entity, its
 *    transform, or any collider/occupancy concept (which live server-side and
 *    are not even on the client at all); and
 * 2. a loaded GLB with named clips is actually driven by a per-node
 *    `AnimationMixer`: the bridge's `animation.play` switches the playing clip,
 *    and a completed move returns to rest.
 */

import { describe, expect, it } from 'vitest';
import { AnimationClip, BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

import type { AnimationId, NodeId } from '@starvalley/render-protocol';

import { createRenderBridge } from '../src/render/bridge.ts';
import type { WorldState } from '../src/organizer/index.ts';
import { asAppearanceId } from '../src/render/three/assets.ts';
import { createThreeRuntime } from '../src/render/three/runtime.ts';
import type { LoadedModel, ModelLoader } from '../src/render/three/runtime.ts';

const ENTITY = {
  entityId: 'entity-a',
  actorId: null,
  kind: 'character',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  visible: true,
} as const;

const BOUNDS = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };

const WORLD: WorldState = {
  status: 'ready',
  streamStatus: 'live',
  worldId: 'world-1',
  bounds: BOUNDS,
  blockGrid: { origin: { x: -6, y: 0, z: -6 }, cellSize: 1 },
  blocks: [],
  entities: [ENTITY],
  controlledActorId: null,
  error: null,
  notice: null,
};

function makeLoadedModel(): LoadedModel {
  const scene = new Group();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  mesh.position.y = 0.5;
  scene.add(mesh);
  return {
    scene,
    animations: [new AnimationClip('Idle', 1, []), new AnimationClip('Walk', 1, [])],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('asset descriptor swaps are presentation-only', () => {
  it('never changes authoritative entity data when the descriptor changes', async () => {
    const loader: ModelLoader = () => Promise.resolve(makeLoadedModel());
    const bridge = createRenderBridge();

    // Snapshot the authoritative entity state before any rendering happens.
    const authoritative = JSON.parse(JSON.stringify(WORLD.entities)) as unknown;

    const catalogueA = {
      [asAppearanceId('appearance.character')]: { url: '/models/a.glb' },
    };
    const catalogueB = {
      [asAppearanceId('appearance.character')]: {
        url: '/models/b.glb',
        scale: { x: 2, y: 2, z: 2 },
      },
    };

    const runtimeA = createThreeRuntime({ bounds: BOUNDS, loadModel: loader, catalogue: catalogueA });
    runtimeA.apply(bridge.frameFor(WORLD));
    await flush();

    // The bridge read the entity; it did not mutate it.
    expect(WORLD.entities).toEqual(authoritative);
    const nodeA = runtimeA.inspect().nodes[0];
    expect(nodeA.model).toBe('loaded');
    // Catalogue A has no scale, so the 1-unit box tops out at 1 unit.
    expect(nodeA.visualTopY).toBeCloseTo(1, 6);

    // Swap to a DIFFERENT descriptor and render the same authoritative state.
    const bridgeB = createRenderBridge();
    const runtimeB = createThreeRuntime({ bounds: BOUNDS, loadModel: loader, catalogue: catalogueB });
    runtimeB.apply(bridgeB.frameFor(WORLD));
    await flush();

    // The authoritative entity is byte-identical: a descriptor swap changed only
    // the presentation (the same template at a different catalogue scale).
    expect(WORLD.entities).toEqual(authoritative);
    const nodeB = runtimeB.inspect().nodes[0];
    expect(nodeB.model).toBe('loaded');
    // Catalogue B scales the same template by 2, so it now tops out at 2 units.
    expect(nodeB.visualTopY).toBeCloseTo(2, 6);

    runtimeA.dispose();
    runtimeB.dispose();
  });
});

describe('AnimationMixer clip playback', () => {
  it('plays the catalogue clip for a bridge animation and returns to rest', async () => {
    const loader: ModelLoader = () => Promise.resolve(makeLoadedModel());
    const catalogue = {
      [asAppearanceId('appearance.character')]: {
        url: '/models/rig.glb',
        clips: { idle: 'Idle', walk: 'Walk' },
      },
    };
    const runtime = createThreeRuntime({ bounds: BOUNDS, loadModel: loader, catalogue });
    const bridge = createRenderBridge();

    runtime.apply(bridge.frameFor(WORLD));
    await flush();

    const nodeId = 'entity:entity-a' as NodeId;
    const loaded = runtime.inspect().nodes.find((node) => node.nodeId === nodeId);
    expect(loaded?.model).toBe('loaded');
    expect(loaded?.hasMixer).toBe(true);
    // Rests at the idle clip the catalogue named.
    expect(loaded?.mixerClip).toBe('Idle');

    // The bridge emits `walk` on a position change; here the equivalent
    // primitive is applied directly so the mixer mapping is what is exercised.
    runtime.apply([
      { type: 'animation.play', nodeId, animation: 'walk' as AnimationId, loop: true },
    ]);
    expect(runtime.inspect().nodes[0].mixerClip).toBe('Walk');

    runtime.apply([
      { type: 'animation.play', nodeId, animation: 'idle' as AnimationId, loop: true },
    ]);
    expect(runtime.inspect().nodes[0].mixerClip).toBe('Idle');

    runtime.dispose();
  });
});
