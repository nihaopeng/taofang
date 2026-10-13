/**
 * Unit tests for the Render Bridge (node environment: no DOM, no Three.js).
 *
 * The bridge is a pure stateful mapper from Organizer `WorldState` to Render ISA
 * frames. These tests pin the tile/entity diff rules, the namespaced node ids,
 * the terrain/kind appearance catalogues with their fallbacks, the determinism of
 * command order, and — phase 7 — that real 3D world transforms (position +
 * rotation) are mapped through **unchanged**.
 *
 * They import the bridge directly and the ISA only for its types, so no runtime
 * dependency on the Organizer or Three.js is loaded.
 */

import { describe, expect, it } from 'vitest';

import type { NodeId, RenderCommand, RenderFrame } from '@starvalley/render-protocol';

import type { WorldState } from '../src/organizer/index.ts';
import {
  BRIDGE_SURFACES,
  BRIDGE_TERRAINS,
  FALLBACK_APPEARANCE,
  createRenderBridge,
  entityIdOfNodeId,
} from '../src/render/bridge.ts';

type Entity = WorldState['entities'][number];
type Tile = WorldState['tiles'][number];

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

function makeEntity(overrides: Partial<Entity> & { entityId: string }): Entity {
  return {
    actorId: null,
    kind: 'character',
    position: { x: 0, y: 0, z: 0 },
    rotation: { ...IDENTITY_ROTATION },
    visible: true,
    ...overrides,
  };
}

function makeTile(
  cellX: number,
  cellZ: number,
  terrain = 'grass',
  position: { x: number; y: number; z: number } = { x: cellX, y: 0, z: cellZ },
): Tile {
  return { cellX, cellZ, terrain, position };
}

function makeState(
  entities: readonly Entity[],
  overrides: Partial<WorldState> = {},
): WorldState {
  return {
    status: 'ready',
    streamStatus: 'live',
    worldId: 'world-1',
    bounds: null,
    grid: null,
    tiles: [],
    surfaces: [],
    colliders: [],
    entities,
    controlledActorId: null,
    error: null,
    notice: null,
    ...overrides,
  };
}

/** Narrow the frame to one command type, failing loudly when it is absent. */
function commandOfType<T extends RenderCommand['type']>(
  frame: RenderFrame,
  type: T,
): Extract<RenderCommand, { type: T }> {
  const found = frame.find((command) => command.type === type);
  if (found === undefined) {
    throw new Error(`a ${type} command in the frame`);
  }
  return found as Extract<RenderCommand, { type: T }>;
}

/** Every `node.create` in the frame, in emitted order. */
function creates(frame: RenderFrame): Extract<RenderCommand, { type: 'node.create' }>[] {
  return frame.filter(
    (command): command is Extract<RenderCommand, { type: 'node.create' }> =>
      command.type === 'node.create',
  );
}

/** The `animation.play` animations emitted in a frame, in order. */
function animations(frame: RenderFrame): string[] {
  return frame
    .filter(
      (command): command is Extract<RenderCommand, { type: 'animation.play' }> =>
        command.type === 'animation.play',
    )
    .map((command) => command.animation);
}

describe('render bridge tiles', () => {
  it('emits one base-layer node.create per tile at its world position plus object-layer nodes', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })], {
        tiles: [
          makeTile(0, 0),
          makeTile(1, 0),
          // A deliberately non-trivial world position: the bridge must pass it
          // through unchanged, never derive it from the cell.
          makeTile(0, 1, 'path', { x: 12.5, y: 0.5, z: -3.25 }),
        ],
      }),
    );

    const created = creates(frame);
    expect(created).toHaveLength(4);
    // Base layer first, in row-major order, with terrain-derived appearances.
    expect(created[0]).toMatchObject({
      nodeId: 'tile:0,0',
      layer: 'base',
      appearance: 'appearance.terrain.grass',
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      visible: true,
    });
    expect(created[1]).toMatchObject({ nodeId: 'tile:1,0', layer: 'base' });
    expect(created[2]).toMatchObject({
      nodeId: 'tile:0,1',
      layer: 'base',
      appearance: 'appearance.terrain.path',
      transform: expect.objectContaining({ position: { x: 12.5, y: 0.5, z: -3.25 } }),
    });
    // Then the object layer, with its existing kind appearance.
    expect(created[3]).toMatchObject({
      nodeId: 'entity:entity-a',
      layer: 'object',
      appearance: 'appearance.character',
      transform: expect.objectContaining({ position: { x: 5, y: 0, z: 5 } }),
    });
  });

  it('emits nothing when the tiles are unchanged', () => {
    const bridge = createRenderBridge();
    const tiles = [makeTile(0, 0), makeTile(1, 0, 'blocked')];
    bridge.frameFor(makeState([], { tiles }));

    const frame = bridge.frameFor(makeState([], { tiles }));

    expect(frame).toEqual([]);
  });

  it('emits appearance.set (not a recreate) when a terrain changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { tiles: [makeTile(2, 3)] }));

    const frame = bridge.frameFor(makeState([], { tiles: [makeTile(2, 3, 'blocked')] }));

    expect(frame).toEqual([
      { type: 'appearance.set', nodeId: 'tile:2,3', appearance: 'appearance.terrain.blocked' },
    ]);
  });

  it('emits node.destroy when a tile disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { tiles: [makeTile(0, 0), makeTile(1, 0)] }));

    const frame = bridge.frameFor(makeState([], { tiles: [makeTile(0, 0)] }));

    expect(frame).toEqual([{ type: 'node.destroy', nodeId: 'tile:1,0' }]);
  });

  it('does not throw for an unknown terrain and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(makeState([], { tiles: [makeTile(4, 4, 'sand')] }));
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });
});

describe('render bridge entity diff rules', () => {
  it('emits node.create the first time an entity is seen, with its 3D transform', () => {
    const bridge = createRenderBridge();

    const rotation = { x: 0, y: 0.7071068, z: 0, w: 0.7071068 };
    const frame = bridge.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-a', position: { x: 3, y: 1, z: 4 }, rotation }),
      ]),
    );

    expect(frame).toHaveLength(1);
    const create = commandOfType(frame, 'node.create');
    expect(create.nodeId).toBe('entity:entity-a');
    expect(create.layer).toBe('object');
    expect(create.appearance).toBe('appearance.character');
    expect(create.transform).toEqual({
      position: { x: 3, y: 1, z: 4 },
      rotation,
      scale: { x: 1, y: 1, z: 1 },
    });
    expect(create.visible).toBe(true);
  });

  it('maps a changed 3D position through unchanged with a default 50 ms interpolation', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 3, y: 0, z: 4 } })]));

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 4, y: 0.5, z: 4 } })]),
    );

    const target = commandOfType(frame, 'transform.setTarget');
    expect(target.nodeId).toBe('entity:entity-a');
    expect(target.transform.position).toEqual({ x: 4, y: 0.5, z: 4 });
    // Close to the authoritative 20 Hz tick period.
    expect(target.durationMs).toBe(50);
  });

  it('applies an authoritative heading turn with no walk when only the rotation changed', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([
        makeEntity({
          entityId: 'entity-a',
          position: { x: 3, y: 0, z: 4 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        }),
      ]),
    );

    const frame = bridge.frameFor(
      makeState([
        makeEntity({
          entityId: 'entity-a',
          position: { x: 3, y: 0, z: 4 },
          rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
        }),
      ]),
    );

    const target = commandOfType(frame, 'transform.setTarget');
    expect(target.transform.rotation).toEqual({ x: 0, y: 0.7071068, z: 0, w: 0.7071068 });
    // Turning in place is not a step: walk is driven by position changes only.
    expect(animations(frame)).toEqual([]);
  });

  it('emits visibility.set when visible changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', visible: true })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', visible: false })]));

    const visibility = commandOfType(frame, 'visibility.set');
    expect(visibility.nodeId).toBe('entity:entity-a');
    expect(visibility.visible).toBe(false);
  });

  it('emits appearance.set when kind changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'character' })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'tree' })]));

    const appearance = commandOfType(frame, 'appearance.set');
    expect(appearance.nodeId).toBe('entity:entity-a');
    expect(appearance.appearance).toBe('appearance.tree');
  });

  it('emits node.destroy when an entity disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-a' }),
        makeEntity({ entityId: 'entity-b' }),
      ]),
    );

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a' })]));

    expect(frame).toHaveLength(1);
    const destroy = commandOfType(frame, 'node.destroy');
    expect(destroy.nodeId).toBe('entity:entity-b');
  });

  it('emits an empty frame when nothing changed', () => {
    const bridge = createRenderBridge();
    const state = makeState([makeEntity({ entityId: 'entity-a', position: { x: 3, y: 0, z: 4 } })]);
    bridge.frameFor(state);

    // A fresh state object with equal values is still "unchanged".
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 3, y: 0, z: 4 } })]),
    );

    expect(frame).toEqual([]);
  });
});

describe('render bridge terrain catalogue', () => {
  it('maps all four terrains to distinct non-fallback appearances', () => {
    const bridge = createRenderBridge();
    const terrains = ['grass', 'path', 'blocked', 'water'];

    const frame = bridge.frameFor(
      makeState([], {
        tiles: terrains.map((terrain, x) => makeTile(x, 0, terrain)),
      }),
    );

    const appearances = creates(frame).map((command) => command.appearance);
    expect(appearances).toHaveLength(4);
    expect(new Set(appearances).size).toBe(4);
    for (const appearance of appearances) {
      expect(appearance).not.toBe(FALLBACK_APPEARANCE);
    }
  });

  it('exposes BRIDGE_TERRAINS as every terrain key it renders non-fallback', () => {
    // A terrain the real server can send that is missing here would silently
    // fall through to the fallback look. This is the client-side half of the
    // cross-module coverage assertion Main owns.
    expect([...BRIDGE_TERRAINS].sort()).toEqual(['blocked', 'grass', 'path', 'water']);

    for (const terrain of BRIDGE_TERRAINS) {
      // A fresh bridge sees each terrain for the first time, so it emits
      // node.create rather than an appearance.set.
      const bridge = createRenderBridge();
      const frame = bridge.frameFor(makeState([], { tiles: [makeTile(0, 0, terrain)] }));
      expect(commandOfType(frame, 'node.create').appearance).not.toBe(FALLBACK_APPEARANCE);
    }
  });
});

describe('render bridge world geometry (phase 14)', () => {
  type Surface = WorldState['surfaces'][number];
  type Collider = WorldState['colliders'][number];
  type PlainVec3 = { x: number; y: number; z: number };

  function makeSurface(overrides: Partial<Surface> & { surfaceId: string }): Surface {
    return {
      kind: 'platform',
      center: { x: 0, y: 0, z: 0 },
      axisU: { x: 1, y: 0, z: 0 },
      axisV: { x: 0, y: 0, z: -1 },
      walkable: true,
      ...overrides,
    };
  }

  /** The real demo platform geometry the Manager authors (default 10x10 map). */
  const PLATFORM = makeSurface({
    surfaceId: 'surface-platform',
    kind: 'platform',
    center: { x: 3.5, y: 2, z: -4.5 },
    axisU: { x: 1.5, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: -0.5 },
  });

  /** The real demo ramp geometry: `axisV` gains a real `y` component (tilted). */
  const RAMP = makeSurface({
    surfaceId: 'surface-ramp',
    kind: 'ramp',
    center: { x: 3.5, y: 1, z: -2.267949192431123 },
    axisU: { x: 1.5, y: 0, z: 0 },
    axisV: { x: 0, y: 1, z: -1.7320508075688772 },
  });

  const COLLIDER: Collider = {
    colliderId: 'collider-1',
    kind: 'wall',
    shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 1 } },
  };

  function surfaceCreates(frame: RenderFrame): Extract<RenderCommand, { type: 'node.create' }>[] {
    return creates(frame).filter((command) => String(command.nodeId).startsWith('surface:'));
  }

  function cross(a: PlainVec3, b: PlainVec3): PlainVec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  /** Apply a quaternion to a vector (the standard `v + 2w(q x v) + 2q x (q x v)`). */
  function applyQuat(q: { x: number; y: number; z: number; w: number }, v: PlainVec3): PlainVec3 {
    const qv = { x: q.x, y: q.y, z: q.z };
    const t = cross(qv, v);
    const t2 = { x: t.x * 2, y: t.y * 2, z: t.z * 2 };
    const t3 = cross(qv, t2);
    return { x: v.x + q.w * t2.x + t3.x, y: v.y + q.w * t2.y + t3.y, z: v.z + q.w * t2.z + t3.z };
  }

  /**
   * Map the local top-face corners `(±0.5, 0, ±0.5)` through the emitted
   * transform. This is exactly what the runtime slab does: scale, rotate,
   * translate. It is the ground truth for "the top face IS the surface plane".
   */
  function topFaceCorners(transform: {
    position: PlainVec3;
    rotation: { x: number; y: number; z: number; w: number };
    scale: PlainVec3;
  }): PlainVec3[] {
    const locals: PlainVec3[] = [
      { x: -0.5, y: 0, z: -0.5 },
      { x: 0.5, y: 0, z: -0.5 },
      { x: -0.5, y: 0, z: 0.5 },
      { x: 0.5, y: 0, z: 0.5 },
    ];
    return locals.map((local) => {
      const scaled = {
        x: local.x * transform.scale.x,
        y: local.y * transform.scale.y,
        z: local.z * transform.scale.z,
      };
      const rotated = applyQuat(transform.rotation, scaled);
      return {
        x: transform.position.x + rotated.x,
        y: transform.position.y + rotated.y,
        z: transform.position.z + rotated.z,
      };
    });
  }

  /** The patch's real four corners: `center ± axisU ± axisV`. */
  function patchCorners(surface: Surface): PlainVec3[] {
    const corners: PlainVec3[] = [];
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        corners.push({
          x: surface.center.x + su * surface.axisU.x + sv * surface.axisV.x,
          y: surface.center.y + su * surface.axisU.y + sv * surface.axisV.y,
          z: surface.center.z + su * surface.axisU.z + sv * surface.axisV.z,
        });
      }
    }
    return corners;
  }

  it('renders NO node for a ground surface, so tiles and ground surfaces never double-draw', () => {
    const bridge = createRenderBridge();
    const tiles = [makeTile(0, 0), makeTile(1, 0)];
    // Ground surfaces cover exactly the same cells as the tiles.
    const groundSurfaces = [
      makeSurface({
        surfaceId: 'surface-ground-0-0',
        kind: 'ground',
        center: { x: 0, y: 0, z: 0 },
      }),
      makeSurface({
        surfaceId: 'surface-ground-1-0',
        kind: 'ground',
        center: { x: 1, y: 0, z: 0 },
      }),
    ];

    const frame = bridge.frameFor(makeState([], { tiles, surfaces: groundSurfaces }));
    const created = creates(frame);

    // Exactly one visual per cell, and it is the tile (base layer). No ground
    // surface produced a node, so the same ground cannot be drawn twice.
    expect(created).toHaveLength(2);
    expect(created.every((command) => command.layer === 'base')).toBe(true);
    expect(created.every((command) => String(command.nodeId).startsWith('tile:'))).toBe(true);
    expect(created.some((command) => String(command.nodeId).startsWith('surface:'))).toBe(false);
    expect(frame.some((command) => command.type === 'node.destroy')).toBe(false);
  });

  it('emits nothing at all for ground surfaces alone (no tiles, no geometry)', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(
      makeState([], { surfaces: [makeSurface({ surfaceId: 'surface-ground-0-0', kind: 'ground' })] }),
    );
    expect(frame).toEqual([]);
  });

  it('renders a flat platform as an object node whose top face is the surface plane', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(makeState([], { surfaces: [PLATFORM] }));

    const [create] = surfaceCreates(frame);
    expect(create).toBeDefined();
    expect(create.nodeId).toBe('surface:surface-platform');
    expect(create.layer).toBe('object');
    expect(create.appearance).toBe('appearance.surface.platform');
    expect(create.visible).toBe(true);
    expect(create.transform.position).toEqual({ x: 3.5, y: 2, z: -4.5 });
    // Full edges are 2*|axisU| x 2*|axisV|; local Y (thickness) is unscaled.
    expect(create.transform.scale).toEqual({ x: 3, y: 1, z: 1 });
    // A flat patch's normal is +Y and its in-plane axes are X/Z, so the emitted
    // rotation is the identity quaternion.
    expect(create.transform.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });

    const actual = topFaceCorners(create.transform).map((corner) => ({
      ...corner,
      x: Number(corner.x.toFixed(9)),
      y: Number(corner.y.toFixed(9)),
      z: Number(corner.z.toFixed(9)),
    }));
    for (const expected of patchCorners(PLATFORM)) {
      const match = actual.find(
        (corner) =>
          Math.abs(corner.x - expected.x) < 1e-9 &&
          Math.abs(corner.y - expected.y) < 1e-9 &&
          Math.abs(corner.z - expected.z) < 1e-9,
      );
      expect(match).toBeDefined();
    }
  });

  it('renders a tilted ramp with a non-identity rotation whose top face is still the surface plane', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(makeState([], { surfaces: [RAMP] }));

    const [create] = surfaceCreates(frame);
    expect(create.appearance).toBe('appearance.surface.ramp');
    // |axisU| = 1.5, |axisV| = hypot(1, 1.732...) = 2, so full edges 3 x 4.
    expect(create.transform.scale.x).toBeCloseTo(3, 9);
    expect(create.transform.scale.y).toBe(1);
    expect(create.transform.scale.z).toBeCloseTo(4, 9);
    // A tilted patch must NOT be an identity rotation.
    expect(create.transform.rotation).not.toEqual({ x: 0, y: 0, z: 0, w: 1 });

    const actual = topFaceCorners(create.transform);
    for (const expected of patchCorners(RAMP)) {
      const match = actual.find(
        (corner) =>
          Math.abs(corner.x - expected.x) < 1e-9 &&
          Math.abs(corner.y - expected.y) < 1e-9 &&
          Math.abs(corner.z - expected.z) < 1e-9,
      );
      expect(match).toBeDefined();
    }
  });

  it('maps every non-ground surface kind to a distinct non-fallback appearance', () => {
    expect([...BRIDGE_SURFACES].sort()).toEqual(['bridge', 'platform', 'ramp']);
    const bridge = createRenderBridge();
    const surfaces = BRIDGE_SURFACES.map((kind, index) =>
      makeSurface({ surfaceId: `surface-${index}`, kind }),
    );

    const frame = bridge.frameFor(makeState([], { surfaces }));
    const appearances = surfaceCreates(frame).map((command) => command.appearance);
    expect(appearances).toHaveLength(3);
    expect(new Set(appearances).size).toBe(3);
    expect(appearances).not.toContain(FALLBACK_APPEARANCE);
  });

  it('keeps colliders invisible: they emit nothing and changing one is a no-op', () => {
    const bridge = createRenderBridge();

    expect(bridge.frameFor(makeState([], { colliders: [COLLIDER] }))).toEqual([]);
    expect(
      bridge.frameFor(
        makeState([], {
          colliders: [{ ...COLLIDER, shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 2 } } }],
        }),
      ),
    ).toEqual([]);
  });

  it('is a no-op for a ground surface metadata change but diffs real surface geometry', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { surfaces: [PLATFORM] }));

    // A changed platform kind swaps appearance in place (no recreate).
    const kindFrame = bridge.frameFor(
      makeState([], { surfaces: [{ ...PLATFORM, kind: 'bridge' }] }),
    );
    expect(kindFrame).toEqual([
      {
        type: 'appearance.set',
        nodeId: 'surface:surface-platform',
        appearance: 'appearance.surface.bridge',
      },
    ]);

    // A moved/reshaped surface emits `transform.set` (geometry is static, so the
    // bridge still diffs it rather than leaving a stale node).
    const moved = makeSurface({
      ...PLATFORM,
      center: { x: 3.5, y: 2.5, z: -4.5 },
    });
    const geometryFrame = bridge.frameFor(makeState([], { surfaces: [moved] }));
    const transform = commandOfType(geometryFrame, 'transform.set');
    expect(transform.nodeId).toBe('surface:surface-platform');
    expect(transform.transform.position).toEqual({ x: 3.5, y: 2.5, z: -4.5 });
  });

  it('destroys a surface node when the surface disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { surfaces: [PLATFORM, RAMP] }));

    const frame = bridge.frameFor(makeState([], { surfaces: [PLATFORM] }));

    expect(frame).toEqual([{ type: 'node.destroy', nodeId: 'surface:surface-ramp' }]);
  });

  it('is a no-op when a ground surface is removed (it never had a node)', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([], { surfaces: [makeSurface({ surfaceId: 'surface-ground-0-0', kind: 'ground' })] }),
    );

    const frame = bridge.frameFor(makeState([], { surfaces: [] }));
    expect(frame).toEqual([]);
  });

  it('re-creates surfaces on a world switch and destroys the previous world leftovers', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { worldId: 'world-1', surfaces: [PLATFORM, RAMP] }));

    const frame = bridge.frameFor(
      makeState([], { worldId: 'world-2', surfaces: [PLATFORM] }),
    );

    // The new world's platform is re-created (a snap), the old ramp destroyed.
    expect(surfaceCreates(frame).map((command) => command.nodeId)).toEqual([
      'surface:surface-platform',
    ]);
    expect(frame).toContainEqual({ type: 'node.destroy', nodeId: 'surface:surface-ramp' });
  });

  it('namespaces surface node ids so a picked surface is never mistaken for an entity', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(makeState([], { surfaces: [PLATFORM] }));
    expect(surfaceCreates(frame)[0].nodeId).toBe('surface:surface-platform');

    // `pick()` returns the opaque `NodeId`; the bridge's entity mapping must
    // reject a surface node exactly like a tile node.
    expect(entityIdOfNodeId('surface:surface-platform' as NodeId)).toBeNull();
    expect(entityIdOfNodeId('tile:0,0' as NodeId)).toBeNull();
  });
});

describe('render bridge animation driving state', () => {
  it('emits walk when a move starts and never emits a settle animation', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })]));

    const moveFrame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 6, y: 0, z: 5 } })]),
    );
    expect(animations(moveFrame)).toEqual(['walk']);
    expect(moveFrame.some((command) => command.type === 'transform.setTarget')).toBe(true);

    // The runtime owns settling, so the bridge must NOT emit an `idle` on a
    // later frame that observes no position change. Two consecutive unchanged
    // frames prove the settle emission is gone, not merely deferred.
    const settleFrame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 6, y: 0, z: 5 } })]),
    );
    expect(animations(settleFrame)).toEqual([]);
    expect(
      animations(
        bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 6, y: 0, z: 5 } })])),
      ),
    ).toEqual([]);
  });

  it('stays on walk across consecutive moves without a transitional idle', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })]));

    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 6, y: 0, z: 5 } })]))),
    ).toEqual(['walk']);
    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 7, y: 0, z: 5 } })]))),
    ).toEqual(['walk']);
    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 7, y: 0, z: 5 } })]))),
    ).toEqual([]);
  });

  it('issues no animation.play when a move is blocked and nothing changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })]));

    // Walking into a wall: the authoritative position is unchanged, so there is
    // no move to start and no settle to emit. The actor cannot be left on a
    // walk animation that nothing ever ends.
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })]),
    );
    expect(frame).toEqual([]);
    expect(animations(frame)).toEqual([]);
  });
});

describe('render bridge fallback appearance', () => {
  it('does not throw for an unknown kind and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });

  it('keeps the node alive (no destroy) when only the kind is unknown', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));

    expect(frame).toEqual([]);
  });
});

describe('render bridge reset and determinism', () => {
  it('re-emits node.create after reset', () => {
    const bridge = createRenderBridge();
    const state = makeState([makeEntity({ entityId: 'entity-a' })], { tiles: [makeTile(0, 0)] });
    bridge.frameFor(state);

    bridge.reset();
    const frame = bridge.frameFor(state);

    const created = creates(frame);
    expect(created.map((command) => command.nodeId)).toEqual(['tile:0,0', 'entity:entity-a']);
  });

  it('orders create commands deterministically regardless of input order', () => {
    const first = createRenderBridge();
    const second = createRenderBridge();

    const entities = [
      makeEntity({ entityId: 'entity-a' }),
      makeEntity({ entityId: 'entity-b' }),
      makeEntity({ entityId: 'entity-c' }),
    ];
    const tiles = [makeTile(1, 0), makeTile(0, 1), makeTile(0, 0)];

    const forward = first.frameFor(makeState(entities, { tiles }));
    const reversed = second.frameFor(
      makeState([...entities].reverse(), { tiles: [...tiles].reverse() }),
    );

    expect(forward).toEqual(reversed);
    expect(forward.map((command) => command.nodeId)).toEqual([
      'tile:0,0',
      'tile:1,0',
      'tile:0,1',
      'entity:entity-a',
      'entity:entity-b',
      'entity:entity-c',
    ]);
  });

  it('orders mixed updates and destroys deterministically', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-a', position: { x: 0, y: 0, z: 0 } }),
          makeEntity({ entityId: 'entity-b', position: { x: 0, y: 0, z: 0 } }),
          makeEntity({ entityId: 'entity-c', position: { x: 0, y: 0, z: 0 } }),
        ],
        { tiles: [makeTile(0, 0), makeTile(1, 0)] },
      ),
    );

    const frame = bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-c', position: { x: 1, y: 0, z: 0 } }),
          makeEntity({ entityId: 'entity-a', position: { x: 1, y: 0, z: 0 } }),
        ],
        // Tile (0,0) changes terrain; tile (1,0) disappears.
        { tiles: [makeTile(0, 0, 'path')] },
      ),
    );

    expect(frame.map((command) => `${command.type}:${command.nodeId}`)).toEqual([
      'transform.setTarget:entity:entity-a',
      'animation.play:entity:entity-a',
      'transform.setTarget:entity:entity-c',
      'animation.play:entity:entity-c',
      'appearance.set:tile:0,0',
      'node.destroy:tile:1,0',
      'node.destroy:entity:entity-b',
    ]);
  });

  it('is a pure function of world state at full-map scale, independent of tile order', () => {
    const bridge = createRenderBridge();

    // A complete 10x10 map, exercising the whole tile list rather than a token
    // sample, plus one entity.
    const tiles: Tile[] = [];
    for (let cellZ = 0; cellZ < 10; cellZ += 1) {
      for (let cellX = 0; cellX < 10; cellX += 1) {
        tiles.push(makeTile(cellX, cellZ, (cellX + cellZ) % 2 === 0 ? 'grass' : 'path'));
      }
    }
    const entities = [makeEntity({ entityId: 'entity-a', position: { x: 1, y: 0, z: 1 } })];

    const initial = bridge.frameFor(makeState(entities, { tiles }));
    expect(initial).toHaveLength(101);

    // Re-diff the SAME world with the tile list reversed. `byCell` normalises the
    // order, so the diff is empty: the bridge's output is a pure function of
    // world state, not of the order the caller supplied it in.
    const reordered = bridge.frameFor(makeState(entities, { tiles: [...tiles].reverse() }));
    expect(reordered).toEqual([]);
  });
});

describe('render bridge world identity', () => {
  it('re-creates every node (a snap) and destroys the previous world leftovers on a worldId change', () => {
    const bridge = createRenderBridge();

    bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-a', position: { x: 3, y: 0, z: 4 } }),
          makeEntity({ entityId: 'entity-b', position: { x: 7, y: 0, z: 7 } }),
        ],
        { worldId: 'world-1', tiles: [makeTile(0, 0), makeTile(5, 5)] },
      ),
    );

    // Same cell coordinates and same entity id, but a DIFFERENT world: entity-a
    // is at a new position and the old-only nodes are gone. Without the worldId
    // reset this would emit transform.setTarget for entity-a (interpolating out
    // of the old world) and no base-layer create.
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 4, y: 0, z: 4 } })], {
        worldId: 'world-2',
        tiles: [makeTile(0, 0)],
      }),
    );

    expect(frame.some((command) => command.type === 'transform.setTarget')).toBe(false);
    expect(frame).toEqual([
      {
        type: 'node.create',
        layer: 'base',
        nodeId: 'tile:0,0',
        appearance: 'appearance.terrain.grass',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        visible: true,
      },
      {
        type: 'node.create',
        layer: 'object',
        nodeId: 'entity:entity-a',
        appearance: 'appearance.character',
        transform: {
          position: { x: 4, y: 0, z: 4 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        visible: true,
      },
      { type: 'node.destroy', nodeId: 'tile:5,5' },
      { type: 'node.destroy', nodeId: 'entity:entity-b' },
    ]);
  });

  it('does not treat an unchanged worldId as a world switch', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 3, y: 0, z: 4 } })], {
        worldId: 'world-1',
      }),
    );

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 4, y: 0, z: 4 } })], {
        worldId: 'world-1',
      }),
    );

    // Same world: a move is still an interpolation, not a snap.
    expect(commandOfType(frame, 'transform.setTarget').nodeId).toBe('entity:entity-a');
  });
});

describe('render bridge tile/entity id namespacing', () => {
  it('cannot collide a tile with an entity whose id looks like a coordinate', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: '1,2', position: { x: 9, y: 0, z: 9 } })], {
        tiles: [makeTile(1, 2)],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('tile:1,2');
    expect(ids).toContain('entity:1,2');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cannot collide a tile with an entity literally named tile:<cellX>,<cellZ>', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'tile:3,4', position: { x: 9, y: 0, z: 9 } })], {
        tiles: [makeTile(3, 4)],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('tile:3,4');
    expect(ids).toContain('entity:tile:3,4');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bridge node id -> entityId mapping', () => {
  it('maps the namespaced node id of an entity back to its entity id', () => {
    // This is the direction the app actually uses: `runtime.pick()` hands back
    // an opaque `NodeId`, and the UI turns it into an entity intent through here.
    expect(entityIdOfNodeId('entity:entity-42' as NodeId)).toBe('entity-42');
  });

  it('is lossless for an entity id that itself looks like a tile id', () => {
    // The `entity:` prefix is what disambiguates, so the mapping is lossless
    // even when an entity id contains a colon.
    expect(entityIdOfNodeId('entity:tile:3,4' as NodeId)).toBe('tile:3,4');
  });

  it('maps a non-entity node id to null', () => {
    expect(entityIdOfNodeId('tile:0,0' as NodeId)).toBeNull();
    expect(entityIdOfNodeId('ground' as NodeId)).toBeNull();
    expect(entityIdOfNodeId('entity:' as NodeId)).toBeNull();
  });
});
