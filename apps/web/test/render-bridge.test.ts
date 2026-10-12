/**
 * Unit tests for the Render Bridge (node environment: no DOM, no Three.js).
 *
 * The bridge is a pure stateful mapper from Organizer `WorldState` to Render ISA
 * frames. These tests pin the tile/entity diff rules, the namespaced node ids,
 * the terrain/kind appearance catalogues with their fallbacks, and the
 * determinism of command order. They import the bridge directly and the ISA only
 * for its types, so no runtime dependency on the Organizer or Three.js is loaded.
 */

import { describe, expect, it } from 'vitest';

import type { RenderCommand, RenderFrame } from '@starvalley/render-protocol';

import type { WorldState } from '../src/organizer/index.ts';
import {
  BRIDGE_TERRAINS,
  FALLBACK_APPEARANCE,
  createRenderBridge,
} from '../src/render/bridge.ts';

type Entity = WorldState['entities'][number];
type Tile = WorldState['tiles'][number];

function makeEntity(overrides: Partial<Entity> & { entityId: string }): Entity {
  return {
    actorId: null,
    kind: 'character',
    x: 0,
    y: 0,
    visible: true,
    ...overrides,
  };
}

function makeTile(overrides: Partial<Tile> & { x: number; y: number }): Tile {
  return {
    terrain: 'grass',
    ...overrides,
  };
}

function makeState(
  entities: readonly Entity[],
  overrides: Partial<WorldState> = {},
): WorldState {
  return {
    status: 'ready',
    worldId: 'world-1',
    world: { width: 10, height: 8 },
    tiles: [],
    entities,
    controlledActorId: null,
    error: null,
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

describe('render bridge tiles', () => {
  it('emits one base-layer node.create per tile plus object-layer nodes on first sight', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', x: 5, y: 5 })], {
        tiles: [
          makeTile({ x: 0, y: 0 }),
          makeTile({ x: 1, y: 0 }),
          makeTile({ x: 0, y: 1, terrain: 'path' }),
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
      transform: { x: 0, y: 0 },
      visible: true,
    });
    expect(created[1]).toMatchObject({ nodeId: 'tile:1,0', layer: 'base' });
    expect(created[2]).toMatchObject({
      nodeId: 'tile:0,1',
      layer: 'base',
      appearance: 'appearance.terrain.path',
    });
    // Then the object layer, with its existing kind appearance.
    expect(created[3]).toMatchObject({
      nodeId: 'entity:entity-a',
      layer: 'object',
      appearance: 'appearance.character',
      transform: { x: 5, y: 5 },
    });
  });

  it('emits nothing when the tiles are unchanged', () => {
    const bridge = createRenderBridge();
    const tiles = [makeTile({ x: 0, y: 0 }), makeTile({ x: 1, y: 0, terrain: 'blocked' })];
    bridge.frameFor(makeState([], { tiles }));

    const frame = bridge.frameFor(makeState([], { tiles }));

    expect(frame).toEqual([]);
  });

  it('emits appearance.set (not a recreate) when a terrain changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([], { tiles: [makeTile({ x: 2, y: 3 })] }));

    const frame = bridge.frameFor(
      makeState([], { tiles: [makeTile({ x: 2, y: 3, terrain: 'blocked' })] }),
    );

    expect(frame).toEqual([
      { type: 'appearance.set', nodeId: 'tile:2,3', appearance: 'appearance.terrain.blocked' },
    ]);
  });

  it('emits node.destroy when a tile disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([], { tiles: [makeTile({ x: 0, y: 0 }), makeTile({ x: 1, y: 0 })] }),
    );

    const frame = bridge.frameFor(makeState([], { tiles: [makeTile({ x: 0, y: 0 })] }));

    expect(frame).toEqual([{ type: 'node.destroy', nodeId: 'tile:1,0' }]);
  });

  it('does not throw for an unknown terrain and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(
        makeState([], { tiles: [makeTile({ x: 4, y: 4, terrain: 'sand' })] }),
      );
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });
});

describe('render bridge entity diff rules', () => {
  it('emits node.create the first time an entity is seen', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    expect(frame).toHaveLength(1);
    const create = commandOfType(frame, 'node.create');
    expect(create.nodeId).toBe('entity:entity-a');
    expect(create.layer).toBe('object');
    expect(create.appearance).toBe('appearance.character');
    expect(create.transform).toEqual({ x: 3, y: 4 });
    expect(create.visible).toBe(true);
  });

  it('emits transform.setTarget with a positive duration when x/y change', () => {
    const bridge = createRenderBridge({ stepDurationMs: 120 });
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 4, y: 4 })]));

    const target = commandOfType(frame, 'transform.setTarget');
    expect(target.nodeId).toBe('entity:entity-a');
    expect(target.transform).toEqual({ x: 4, y: 4 });
    expect(target.durationMs).toBeGreaterThan(0);
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
    const state = makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]);
    bridge.frameFor(state);

    // A fresh state object with equal values is still "unchanged".
    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    expect(frame).toEqual([]);
  });
});

describe('render bridge terrain catalogue', () => {
  it('maps all four terrains to distinct non-fallback appearances', () => {
    const bridge = createRenderBridge();
    const terrains = ['grass', 'path', 'blocked', 'water'];

    const frame = bridge.frameFor(
      makeState([], {
        tiles: terrains.map((terrain, x) => makeTile({ x, y: 0, terrain })),
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
      const frame = bridge.frameFor(
        makeState([], { tiles: [makeTile({ x: 0, y: 0, terrain })] }),
      );
      expect(commandOfType(frame, 'node.create').appearance).not.toBe(FALLBACK_APPEARANCE);
    }
  });

  it('does not throw for an unknown terrain and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(
        makeState([], { tiles: [makeTile({ x: 4, y: 4, terrain: 'sand' })] }),
      );
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });
});

describe('render bridge animation driving state', () => {
  /** The `animation.play` animations emitted in a frame, in order. */
  function animations(frame: RenderFrame): string[] {
    return frame
      .filter(
        (command): command is Extract<RenderCommand, { type: 'animation.play' }> =>
          command.type === 'animation.play',
      )
      .map((command) => command.animation);
  }

  it('emits walk when a move starts and never emits a settle animation', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 5, y: 5 })]));

    const moveFrame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 6, y: 5 })]));
    expect(animations(moveFrame)).toEqual(['walk']);
    expect(moveFrame.some((command) => command.type === 'transform.setTarget')).toBe(true);

    // The runtime owns settling, so the bridge must NOT emit an `idle` on a
    // later frame that observes no position change. Two consecutive unchanged
    // frames prove the settle emission is gone, not merely deferred.
    const settleFrame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', x: 6, y: 5 })]),
    );
    expect(animations(settleFrame)).toEqual([]);
    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 6, y: 5 })]))),
    ).toEqual([]);
  });

  it('stays on walk across consecutive moves without a transitional idle', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 5, y: 5 })]));

    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 6, y: 5 })]))),
    ).toEqual(['walk']);
    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 7, y: 5 })]))),
    ).toEqual(['walk']);
    expect(
      animations(bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 7, y: 5 })]))),
    ).toEqual([]);
  });

  it('issues no animation.play when a move is blocked and the position does not change', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 5, y: 5 })]));

    // Walking into a wall: the authoritative position is unchanged, so there is
    // no move to start and no settle to emit. The actor cannot be left on a
    // walk animation that nothing ever ends.
    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 5, y: 5 })]));
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
    const state = makeState([makeEntity({ entityId: 'entity-a' })], {
      tiles: [makeTile({ x: 0, y: 0 })],
    });
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
    const tiles = [
      makeTile({ x: 1, y: 0 }),
      makeTile({ x: 0, y: 1 }),
      makeTile({ x: 0, y: 0 }),
    ];

    const forward = first.frameFor(makeState(entities, { tiles }));
    const reversed = second.frameFor(makeState([...entities].reverse(), { tiles: [...tiles].reverse() }));

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
          makeEntity({ entityId: 'entity-a', x: 0, y: 0 }),
          makeEntity({ entityId: 'entity-b', x: 0, y: 0 }),
          makeEntity({ entityId: 'entity-c', x: 0, y: 0 }),
        ],
        { tiles: [makeTile({ x: 0, y: 0 }), makeTile({ x: 1, y: 0 })] },
      ),
    );

    const frame = bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-c', x: 1, y: 0 }),
          makeEntity({ entityId: 'entity-a', x: 1, y: 0 }),
        ],
        // Tile (0,0) changes terrain; tile (1,0) disappears.
        { tiles: [makeTile({ x: 0, y: 0, terrain: 'path' })] },
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
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        tiles.push(makeTile({ x, y, terrain: (x + y) % 2 === 0 ? 'grass' : 'path' }));
      }
    }
    const entities = [makeEntity({ entityId: 'entity-a', x: 1, y: 1 })];

    const initial = bridge.frameFor(makeState(entities, { tiles }));
    expect(initial).toHaveLength(101);

    // Re-diff the SAME world with the tile list reversed. `byTilePosition`
    // normalises the order, so the diff is empty: the bridge's output is a pure
    // function of world state, not of the order the caller supplied it in.
    const reordered = bridge.frameFor(makeState(entities, { tiles: [...tiles].reverse() }));
    expect(reordered).toEqual([]);
  });
});

describe('render bridge world identity', () => {
  it('re-creates every node (a snap) and destroys the previous world\'s leftovers on a worldId change', () => {
    const bridge = createRenderBridge();

    // Previous world: tiles (0,0) and (5,5), entity-a at (3,4), plus old-only
    // entity-b.
    bridge.frameFor(
      makeState(
        [
          makeEntity({ entityId: 'entity-a', x: 3, y: 4 }),
          makeEntity({ entityId: 'entity-b', x: 7, y: 7 }),
        ],
        { worldId: 'world-1', tiles: [makeTile({ x: 0, y: 0 }), makeTile({ x: 5, y: 5 })] },
      ),
    );

    // Same size, same tile coordinates and same entity id, but a DIFFERENT
    // world: entity-a is at a new position and the old-only nodes are gone.
    // Without the worldId reset this would emit transform.setTarget for
    // entity-a (interpolating out of the old world) and no base-layer create.
    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', x: 4, y: 4 })], {
        worldId: 'world-2',
        tiles: [makeTile({ x: 0, y: 0 })],
      }),
    );

    expect(frame.some((command) => command.type === 'transform.setTarget')).toBe(false);
    expect(frame).toEqual([
      {
        type: 'node.create',
        layer: 'base',
        nodeId: 'tile:0,0',
        appearance: 'appearance.terrain.grass',
        transform: { x: 0, y: 0 },
        visible: true,
      },
      {
        type: 'node.create',
        layer: 'object',
        nodeId: 'entity:entity-a',
        appearance: 'appearance.character',
        transform: { x: 4, y: 4 },
        visible: true,
      },
      { type: 'node.destroy', nodeId: 'tile:5,5' },
      { type: 'node.destroy', nodeId: 'entity:entity-b' },
    ]);
  });

  it('does not treat an unchanged worldId as a world switch', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })], { worldId: 'world-1' }),
    );

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'entity-a', x: 4, y: 4 })], { worldId: 'world-1' }),
    );

    // Same world: a move is still an interpolation, not a snap.
    expect(commandOfType(frame, 'transform.setTarget').nodeId).toBe('entity:entity-a');
  });
});

describe('render bridge tile/entity id namespacing', () => {
  it('cannot collide a tile with an entity whose id looks like a coordinate', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: '1,2', x: 9, y: 9 })], {
        tiles: [makeTile({ x: 1, y: 2 })],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('tile:1,2');
    expect(ids).toContain('entity:1,2');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cannot collide a tile with an entity literally named tile:<x>,<y>', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(
      makeState([makeEntity({ entityId: 'tile:3,4', x: 9, y: 9 })], {
        tiles: [makeTile({ x: 3, y: 4 })],
      }),
    );

    const ids = frame.map((command) => command.nodeId);
    expect(ids).toContain('tile:3,4');
    expect(ids).toContain('entity:tile:3,4');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
