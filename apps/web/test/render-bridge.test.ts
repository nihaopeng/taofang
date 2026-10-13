/**
 * Unit tests for the Render Bridge (node environment: no DOM, no Three.js).
 *
 * The bridge is a pure stateful mapper from Organizer `WorldState` to Render ISA
 * frames. These tests pin the block/entity diff rules, the namespaced node ids,
 * the block/entity appearance catalogues with their fallbacks, the determinism of
 * command order, the chunk grouping of blocks, and — phase 7 — that real 3D world
 * transforms (position + rotation) are mapped through **unchanged**.
 *
 * They import the bridge directly and the ISA only for its types, so no runtime
 * dependency on the Organizer or Three.js is loaded.
 */

import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, cellToChunk } from '@starvalley/protocol';
import type { NodeId, RenderCommand, RenderFrame } from '@starvalley/render-protocol';

import type { BlockViewModel, WorldState } from '../src/organizer/index.ts';
import {
  BRIDGE_APPEARANCES,
  BRIDGE_BLOCK_KINDS,
  BRIDGE_CHUNK_SIZE,
  BRIDGE_ENTITY_KINDS,
  FALLBACK_APPEARANCE,
  blockCellOfNodeId,
  blockChunkOf,
  createRenderBridge,
  entityIdOfNodeId,
} from '../src/render/bridge.ts';

type Entity = WorldState['entities'][number];

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

const BLOCK_GRID = { origin: { x: 0, y: 0, z: 0 }, cellSize: 1 };

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

/** A block whose world `position` is the cell centre for the unit grid (origin 0). */
function makeBlock(
  x: number,
  y: number,
  z: number,
  kind = 'grass',
  orientation = 0,
): BlockViewModel {
  return {
    coord: { x, y, z },
    position: { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
    kind,
    orientation,
  };
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
    blockGrid: BLOCK_GRID,
    blocks: [],
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

describe('render bridge blocks', () => {
  it('emits one object-layer node.create per block at its world position with a block appearance', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })], {
        blocks: [
          makeBlock(0, 0, 0, 'grass'),
          makeBlock(1, 0, 0, 'path'),
          // A deliberately non-trivial world position: the bridge must pass it
          // through unchanged, never derive it from the cell.
          {
            coord: { x: 2, y: 1, z: 3 },
            position: { x: 12.5, y: 1.5, z: 3.25 },
            kind: 'stone',
            orientation: 0,
          },
        ],
      }),
    );

    const created = creates(frame);
    expect(created).toHaveLength(4);
    expect(created[0]).toMatchObject({
      nodeId: 'block:0,0,0',
      layer: 'object',
      appearance: 'appearance.block.grass',
      transform: {
        position: { x: 0.5, y: 0.5, z: 0.5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      visible: true,
    });
    expect(created[1]).toMatchObject({ nodeId: 'block:1,0,0', appearance: 'appearance.block.path' });
    expect(created[2]).toMatchObject({
      nodeId: 'block:2,1,3',
      appearance: 'appearance.block.stone',
      transform: expect.objectContaining({ position: { x: 12.5, y: 1.5, z: 3.25 } }),
    });
    // Then the entity node, with its existing kind appearance.
    expect(created[3]).toMatchObject({
      nodeId: 'entity:entity-a',
      layer: 'object',
      appearance: 'appearance.character',
      transform: expect.objectContaining({ position: { x: 5, y: 0, z: 5 } }),
    });
  });

  it('maps a block yaw-step orientation to a real rotation about +Y', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(makeState([], { blocks: [makeBlock(0, 0, 0, 'stairs', 90)] }));
    const create = commandOfType(frame, 'node.create');
    // 90 degrees about +Y is (0, sin45, 0, cos45).
    expect(create.transform.rotation.x).toBeCloseTo(0, 9);
    expect(create.transform.rotation.y).toBeCloseTo(Math.SQRT1_2, 9);
    expect(create.transform.rotation.z).toBeCloseTo(0, 9);
    expect(create.transform.rotation.w).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('emits nothing when the blocks are unchanged', () => {
    const bridge = createRenderBridge();
    const blocks = [makeBlock(0, 0, 0), makeBlock(1, 0, 0, 'stone')];
    bridge.frameFor(makeState([], { blocks }));

    const frame = bridge.frameFor(makeState([], { blocks }));

    expect(frame).toEqual([]);
  });

  it('emits appearance.set (not a recreate) when a block kind changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { blocks: [makeBlock(2, 0, 3)] }));

    const frame = bridge.frameFor(makeState([], { blocks: [makeBlock(2, 0, 3, 'stone')] }));

    expect(frame).toEqual([
      { type: 'appearance.set', nodeId: 'block:2,0,3', appearance: 'appearance.block.stone' },
    ]);
  });

  it('emits transform.set (not a recreate) when a block orientation changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { blocks: [makeBlock(2, 0, 3, 'stairs', 0)] }));

    const frame = bridge.frameFor(makeState([], { blocks: [makeBlock(2, 0, 3, 'stairs', 180)] }));

    const transform = commandOfType(frame, 'transform.set');
    expect(transform.nodeId).toBe('block:2,0,3');
    // 180 degrees about +Y is (0, 1, 0, 0).
    expect(transform.transform.rotation.y).toBeCloseTo(1, 9);
    expect(transform.transform.rotation.w).toBeCloseTo(0, 9);
  });

  it('emits node.destroy when a block disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { blocks: [makeBlock(0, 0, 0), makeBlock(1, 0, 0)] }));

    const frame = bridge.frameFor(makeState([], { blocks: [makeBlock(0, 0, 0)] }));

    expect(frame).toEqual([{ type: 'node.destroy', nodeId: 'block:1,0,0' }]);
  });

  it('never renders an air block', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(
      makeState([], { blocks: [makeBlock(0, 0, 0, 'air'), makeBlock(1, 0, 0, 'grass')] }),
    );
    // `air` is the absence of a block and must not produce a node; the real
    // block still does.
    expect(creates(frame).map((command) => command.nodeId)).toEqual(['block:1,0,0']);
  });

  it('does not throw for an unknown block kind and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(makeState([], { blocks: [makeBlock(4, 0, 4, 'lava')] }));
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });

  it('groups block commands by chunk, with each chunk contiguous in the frame', () => {
    const bridge = createRenderBridge();
    // Cells chosen so their chunks are (0,0,0), (1,0,0) and (0,1,0) with
    // CHUNK_SIZE 16. Chunk-major order is chunk.y, chunk.z, chunk.x.
    const frame = bridge.frameFor(
      makeState([], {
        blocks: [
          makeBlock(17, 0, 0), // chunk (1,0,0)
          makeBlock(0, 0, 17), // chunk (0,1,0)
          makeBlock(5, 0, 0), // chunk (0,0,0)
          makeBlock(0, 0, 0), // chunk (0,0,0)
        ],
      }),
    );

    const ids = creates(frame).map((command) => String(command.nodeId));
    expect(ids).toEqual(['block:0,0,0', 'block:5,0,0', 'block:17,0,0', 'block:0,0,17']);

    // Every chunk's blocks occupy one contiguous run of indices: the property a
    // future chunk-atomic (instanced / greedy-meshed) rebuild needs.
    const chunkIndex = new Map<string, number[]>();
    ids.forEach((id, index) => {
      const cell = blockCellOfNodeId(id as NodeId);
      if (cell === null) {
        throw new Error('expected a block node id');
      }
      const key = `${blockChunkOf(cell).x},${blockChunkOf(cell).y},${blockChunkOf(cell).z}`;
      const list = chunkIndex.get(key) ?? [];
      list.push(index);
      chunkIndex.set(key, list);
    });
    for (const indices of chunkIndex.values()) {
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).toBe(indices[i - 1] + 1);
      }
    }
  });

  it('pins the bridge chunk size to the frozen protocol constant', () => {
    // The bridge may not import the game protocol, so it mirrors `CHUNK_SIZE`.
    // This assertion is what makes that mirror safe: drift becomes a failure.
    expect(BRIDGE_CHUNK_SIZE).toBe(CHUNK_SIZE);
    expect(blockChunkOf({ x: 17, y: 0, z: 0 })).toEqual(cellToChunk({ x: 17, y: 0, z: 0 }));
    expect(blockChunkOf({ x: -1, y: -17, z: 31 })).toEqual(
      cellToChunk({ x: -1, y: -17, z: 31 }),
    );
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

describe('render bridge appearance catalogue', () => {
  it('maps every block kind to a distinct non-fallback appearance', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(
      makeState([], { blocks: BRIDGE_BLOCK_KINDS.map((kind, x) => makeBlock(x, 0, 0, kind)) }),
    );

    const appearances = creates(frame).map((command) => command.appearance);
    expect(appearances).toHaveLength(BRIDGE_BLOCK_KINDS.length);
    expect(new Set(appearances).size).toBe(BRIDGE_BLOCK_KINDS.length);
    for (const appearance of appearances) {
      expect(appearance).not.toBe(FALLBACK_APPEARANCE);
    }
  });

  it('maps every entity kind to a distinct non-fallback appearance', () => {
    const bridge = createRenderBridge();
    const frame = bridge.frameFor(
      makeState(BRIDGE_ENTITY_KINDS.map((kind, index) => makeEntity({ entityId: `entity-${index}`, kind }))),
    );

    const appearances = creates(frame).map((command) => command.appearance);
    expect(appearances).toHaveLength(BRIDGE_ENTITY_KINDS.length);
    expect(new Set(appearances).size).toBe(BRIDGE_ENTITY_KINDS.length);
    for (const appearance of appearances) {
      expect(appearance).not.toBe(FALLBACK_APPEARANCE);
    }
  });

  it('exposes BRIDGE_BLOCK_KINDS as every renderable block kind', () => {
    expect([...BRIDGE_BLOCK_KINDS].sort()).toEqual([
      'grass',
      'path',
      'ramp',
      'slab',
      'soil',
      'stairs',
      'stone',
      'water',
    ]);
    // `air` is absence and is intentionally not renderable.
    expect(BRIDGE_BLOCK_KINDS).not.toContain('air');
  });

  it('exposes BRIDGE_ENTITY_KINDS as the closed entity union', () => {
    expect([...BRIDGE_ENTITY_KINDS].sort()).toEqual([
      'building',
      'character',
      'chest',
      'rock',
      'tree',
    ]);
  });

  it('keeps BRIDGE_APPEARANCES a superset of every kind catalogue plus the fallback', () => {
    // A rename on either side must show up here rather than as a silent fallback.
    expect(new Set(BRIDGE_APPEARANCES).size).toBe(BRIDGE_APPEARANCES.length);
    expect(BRIDGE_APPEARANCES).toContain(FALLBACK_APPEARANCE);
    expect(BRIDGE_APPEARANCES).toContain('appearance.block.grass');
    expect(BRIDGE_APPEARANCES).toContain('appearance.character');
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
    // no move to start and no settle to emit.
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 5, y: 0, z: 5 } })]),
    );
    expect(frame).toEqual([]);
    expect(animations(frame)).toEqual([]);
  });
});

describe('render bridge fallback appearance', () => {
  it('does not throw for an unknown entity kind and uses the documented fallback', () => {
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
    const state = makeState([makeEntity({ entityId: 'entity-a' })], { blocks: [makeBlock(0, 0, 0)] });
    bridge.frameFor(state);

    bridge.reset();
    const frame = bridge.frameFor(state);

    const created = creates(frame);
    expect(created.map((command) => command.nodeId)).toEqual(['block:0,0,0', 'entity:entity-a']);
  });

  it('orders create commands deterministically regardless of input order', () => {
    const first = createRenderBridge();
    const second = createRenderBridge();

    const entities = [
      makeEntity({ entityId: 'entity-a' }),
      makeEntity({ entityId: 'entity-b' }),
      makeEntity({ entityId: 'entity-c' }),
    ];
    const blocks = [makeBlock(1, 0, 0), makeBlock(0, 0, 1), makeBlock(0, 0, 0)];

    const forward = first.frameFor(makeState(entities, { blocks }));
    const reversed = second.frameFor(
      makeState([...entities].reverse(), { blocks: [...blocks].reverse() }),
    );

    expect(forward).toEqual(reversed);
    expect(forward.map((command) => command.nodeId)).toEqual([
      'block:0,0,0',
      'block:1,0,0',
      'block:0,0,1',
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
        { blocks: [makeBlock(0, 0, 0), makeBlock(1, 0, 0)] },
      ),
    );

    const frame = bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-c', position: { x: 1, y: 0, z: 0 } }),
          makeEntity({ entityId: 'entity-a', position: { x: 1, y: 0, z: 0 } }),
        ],
        // Cell (0,0,0) changes kind; cell (1,0,0) disappears.
        { blocks: [makeBlock(0, 0, 0, 'path')] },
      ),
    );

    expect(frame.map((command) => `${command.type}:${command.nodeId}`)).toEqual([
      'transform.setTarget:entity:entity-a',
      'animation.play:entity:entity-a',
      'transform.setTarget:entity:entity-c',
      'animation.play:entity:entity-c',
      'appearance.set:block:0,0,0',
      'node.destroy:block:1,0,0',
      'node.destroy:entity:entity-b',
    ]);
  });

  it('is a pure function of world state at full-map scale, independent of block order', () => {
    const bridge = createRenderBridge();

    // A complete 10x10 ground layer, exercising the whole block list rather than
    // a token sample, plus one entity.
    const blocks: BlockViewModel[] = [];
    for (let z = 0; z < 10; z += 1) {
      for (let x = 0; x < 10; x += 1) {
        blocks.push(makeBlock(x, 0, z, (x + z) % 2 === 0 ? 'grass' : 'path'));
      }
    }
    const entities = [makeEntity({ entityId: 'entity-a', position: { x: 1, y: 0, z: 1 } })];

    const initial = bridge.frameFor(makeState(entities, { blocks }));
    expect(initial).toHaveLength(101);

    // Re-diff the SAME world with the block list reversed. `compareBlocksForRender`
    // normalises the order, so the diff is empty: the bridge's output is a pure
    // function of world state, not of the order the caller supplied it in.
    const reordered = bridge.frameFor(makeState(entities, { blocks: [...blocks].reverse() }));
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
        { worldId: 'world-1', blocks: [makeBlock(0, 0, 0), makeBlock(5, 0, 5)] },
      ),
    );

    // Same cell coordinates and same entity id, but a DIFFERENT world: entity-a
    // is at a new position and the old-only nodes are gone. Without the worldId
    // reset this would emit transform.setTarget for entity-a (interpolating out
    // of the old world) and no block create.
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', position: { x: 4, y: 0, z: 4 } })], {
        worldId: 'world-2',
        blocks: [makeBlock(0, 0, 0)],
      }),
    );

    expect(frame.some((command) => command.type === 'transform.setTarget')).toBe(false);
    expect(frame).toEqual([
      {
        type: 'node.create',
        layer: 'object',
        nodeId: 'block:0,0,0',
        appearance: 'appearance.block.grass',
        transform: {
          position: { x: 0.5, y: 0.5, z: 0.5 },
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
      { type: 'node.destroy', nodeId: 'block:5,0,5' },
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

describe('render bridge block/entity id namespacing', () => {
  it('cannot collide a block with an entity whose id looks like a coordinate', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: '1,2,3', position: { x: 9, y: 0, z: 9 } })], {
        blocks: [makeBlock(1, 2, 3)],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('block:1,2,3');
    expect(ids).toContain('entity:1,2,3');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cannot collide a block with an entity literally named block:<cell>', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'block:3,4,5', position: { x: 9, y: 0, z: 9 } })], {
        blocks: [makeBlock(3, 4, 5)],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('block:3,4,5');
    expect(ids).toContain('entity:block:3,4,5');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('bridge node id -> game identity mapping', () => {
  it('maps the namespaced node id of an entity back to its entity id', () => {
    // This is the direction the app actually uses: `runtime.pick()` hands back
    // an opaque `NodeId`, and the UI turns it into an entity intent through here.
    expect(entityIdOfNodeId('entity:entity-42' as NodeId)).toBe('entity-42');
  });

  it('is lossless for an entity id that itself looks like a block id', () => {
    // The `entity:` prefix is what disambiguates, so the mapping is lossless
    // even when an entity id contains a colon.
    expect(entityIdOfNodeId('entity:block:3,4,5' as NodeId)).toBe('block:3,4,5');
  });

  it('maps the namespaced node id of a block back to its absolute integer cell', () => {
    expect(blockCellOfNodeId('block:3,4,5' as NodeId)).toEqual({ x: 3, y: 4, z: 5 });
    expect(blockCellOfNodeId('block:-1,-2,-3' as NodeId)).toEqual({ x: -1, y: -2, z: -3 });
  });

  it('keeps entity, block and ground distinguishable at the pick site', () => {
    // An entity node -> an entity id and no cell; a block node -> a cell and no
    // entity id; a non-node pick (ground) is neither.
    expect(entityIdOfNodeId('entity:e1' as NodeId)).toBe('e1');
    expect(blockCellOfNodeId('entity:e1' as NodeId)).toBeNull();
    expect(blockCellOfNodeId('block:0,0,0' as NodeId)).toEqual({ x: 0, y: 0, z: 0 });
    expect(entityIdOfNodeId('block:0,0,0' as NodeId)).toBeNull();
    expect(entityIdOfNodeId('ground' as NodeId)).toBeNull();
    expect(blockCellOfNodeId('ground' as NodeId)).toBeNull();
  });

  it('rejects malformed block node ids', () => {
    expect(blockCellOfNodeId('block:' as NodeId)).toBeNull();
    expect(blockCellOfNodeId('block:1,2' as NodeId)).toBeNull();
    expect(blockCellOfNodeId('block:1,2,x' as NodeId)).toBeNull();
    expect(blockCellOfNodeId('block:1.5,2,3' as NodeId)).toBeNull();
    expect(entityIdOfNodeId('block:' as NodeId)).toBeNull();
  });
});
