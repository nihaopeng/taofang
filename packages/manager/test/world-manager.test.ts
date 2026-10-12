import { describe, expect, it } from 'vitest';

import {
  isSubmitCommandResponse,
  isTransformChangedEvent,
  isWorldSnapshot,
  parseActorId,
  parseEntityId,
  parseWorldId,
} from '@starvalley/protocol';
import type { ActorId, GameCommand, MoveDirection, WorldSnapshot } from '@starvalley/protocol';

import {
  BLOCKING_BY_ENTITY_KIND,
  DEFAULT_WORLD_MAP,
  UnknownActorError,
  WALKABILITY_BY_TERRAIN,
  createWorldManager,
} from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

/** The default known actor/entity/world ids, produced through the protocol parsers (branded). */
const ACTOR_ID = parseActorId('actor-1');
const ENTITY_ID = parseEntityId('entity-1');
const WORLD_ID = parseWorldId('world-1');

const ALL_GRASS_3 = ['ggg', 'ggg', 'ggg'] as const;
const ALL_GRASS_4 = ['gggg', 'gggg', 'gggg', 'gggg'] as const;

/** Deterministic, mutable clock for exercising time-dependent semantics. */
function fakeClock(start: Date) {
  let current = start;
  return {
    now: (): Date => current,
    advance: (milliseconds: number): void => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

/** Build a `GameCommand`; a command deliberately carries no actor field. */
function actorMove(direction: MoveDirection): GameCommand {
  return { type: 'actor.move', direction };
}

/** Row-major tile lookup, deriving the row stride from the snapshot itself. */
function tileAt(snapshot: WorldSnapshot, x: number, y: number): WorldSnapshot['tiles'][number] {
  return snapshot.tiles[y * snapshot.size.width + x];
}

function entityTransform(manager: ReturnType<typeof createWorldManager>): { x: number; y: number } {
  return manager.getSnapshot({ actorId: ACTOR_ID }).entities[0].transform;
}

describe('DEFAULT_WORLD_MAP', () => {
  it('is a 10x10 ASCII layout containing the full legend', () => {
    expect(DEFAULT_WORLD_MAP).toHaveLength(10);
    for (const row of DEFAULT_WORLD_MAP) {
      expect(row).toHaveLength(10);
    }

    const characters = new Set(DEFAULT_WORLD_MAP.join('').split(''));
    expect(characters).toContain('g');
    expect(characters).toContain('p');
    expect(characters).toContain('#');
    expect(characters).toContain('w');
    expect(characters).toContain('T');
  });

  it('has exactly the frozen water, tree and blocked coordinates', () => {
    const at = (x: number, y: number): string => DEFAULT_WORLD_MAP[y][x];
    expect(at(3, 3)).toBe('w');
    expect(at(4, 3)).toBe('w');
    expect(at(3, 4)).toBe('w');
    expect(at(4, 4)).toBe('w');
    expect(at(6, 4)).toBe('T');
    expect(at(4, 7)).toBe('T');
    expect(at(2, 8)).toBe('#');
    expect(at(3, 8)).toBe('#');
    // The presenter's occlusion demo: walkable grass north/south of the tree.
    expect(at(6, 3)).toBe('g');
    expect(at(6, 5)).toBe('g');
  });

  it('has a walkable, unoccupied centre tile', () => {
    const centre = DEFAULT_WORLD_MAP[5][5];
    expect(centre).toBe('g');
  });
});

describe('WALKABILITY_BY_TERRAIN', () => {
  it('is the server-side collision rule: grass/path walkable, blocked/water not', () => {
    expect(WALKABILITY_BY_TERRAIN).toEqual({
      grass: true,
      path: true,
      blocked: false,
      water: false,
    });
    expect(WALKABILITY_BY_TERRAIN.water).toBe(false);
  });
});

describe('BLOCKING_BY_ENTITY_KIND', () => {
  it('is the second authoritative rule: trees block, characters do not', () => {
    expect(BLOCKING_BY_ENTITY_KIND).toEqual({ character: false, tree: true });
    expect(BLOCKING_BY_ENTITY_KIND.tree).toBe(true);
    expect(BLOCKING_BY_ENTITY_KIND.character).toBe(false);
  });
});

describe('getSnapshot shape', () => {
  it('exposes exactly worldId/size/tiles/entities/controlledActorId/serverTime', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(Object.keys(snapshot).sort()).toEqual(
      ['controlledActorId', 'entities', 'serverTime', 'size', 'tiles', 'worldId'].sort(),
    );
    expect(snapshot.worldId).toBe(WORLD_ID);
    expect(snapshot.worldId).toBe(parseWorldId('world-1'));
  });

  it('has one tile per cell, sized from the map, with exactly transform/terrain each', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.size).toEqual({ width: 10, height: 10 });
    expect(snapshot.tiles).toHaveLength(snapshot.size.width * snapshot.size.height);

    for (const tile of snapshot.tiles) {
      expect(Object.keys(tile).sort()).toEqual(['terrain', 'transform']);
      expect(Object.keys(tile.transform).sort()).toEqual(['x', 'y']);
    }
  });

  it('maps terrain characters to terrain kinds row-major (all three kinds)', () => {
    const map = ['g#p', 'ppg', '#gg'];
    const manager = createWorldManager({ map });
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.size).toEqual({ width: 3, height: 3 });
    expect(snapshot.tiles).toHaveLength(9);

    // Spot-check each of the three kinds at coordinates read straight off the map.
    expect(tileAt(snapshot, 0, 0)).toEqual({ transform: { x: 0, y: 0 }, terrain: 'grass' });
    expect(tileAt(snapshot, 1, 0).terrain).toBe('blocked');
    expect(tileAt(snapshot, 2, 0).terrain).toBe('path');
    expect(tileAt(snapshot, 0, 1).terrain).toBe('path');
    expect(tileAt(snapshot, 0, 2).terrain).toBe('blocked');
    expect(tileAt(snapshot, 2, 2).terrain).toBe('grass');

    // Row-major ordering: index = y * width + x; transform matches that coordinate.
    for (let y = 0; y < snapshot.size.height; y += 1) {
      for (let x = 0; x < snapshot.size.width; x += 1) {
        const tile = tileAt(snapshot, x, y);
        expect(tile.transform).toEqual({ x, y });
        expect(tile.terrain).toBe(
          map[y][x] === '#' ? 'blocked' : map[y][x] === 'p' ? 'path' : 'grass',
        );
      }
    }
  });

  it('decodes all four terrain kinds from the default map (water at (3,3))', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(tileAt(snapshot, 0, 0).terrain).toBe('grass');
    expect(tileAt(snapshot, 1, 1).terrain).toBe('path');
    expect(tileAt(snapshot, 2, 8).terrain).toBe('blocked');
    expect(tileAt(snapshot, 3, 3).terrain).toBe('water');
    expect(tileAt(snapshot, 4, 3).terrain).toBe('water');
    expect(tileAt(snapshot, 3, 4).terrain).toBe('water');
    expect(tileAt(snapshot, 4, 4).terrain).toBe('water');
  });

  it('snapshot is Protocol-valid', () => {
    const manager = createWorldManager();
    expect(isWorldSnapshot(manager.getSnapshot({ actorId: ACTOR_ID }))).toBe(true);
  });
});

describe('actor spawn', () => {
  it('spawns on the walkable centre tile and equals the map centre', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.entities[0].transform).toEqual({ x: 5, y: 5 });
    expect(tileAt(snapshot, 5, 5).terrain).toBe('grass');
    expect(WALKABILITY_BY_TERRAIN[tileAt(snapshot, 5, 5).terrain]).toBe(true);
  });

  it('uses the branded ActorId/EntityId parsers for the default identity', () => {
    const manager = createWorldManager();
    const [entity] = manager.getSnapshot({ actorId: ACTOR_ID }).entities;

    expect(entity.actorId).toBe(ACTOR_ID);
    expect(entity.actorId).toBe(parseActorId('actor-1'));
    expect(entity.entityId).toBe(ENTITY_ID);
    expect(entity.entityId).toBe(parseEntityId('entity-1'));
  });

  it('entity has exactly entityId/actorId/kind/transform/visible', () => {
    const manager = createWorldManager();
    const [entity] = manager.getSnapshot({ actorId: ACTOR_ID }).entities;

    expect(Object.keys(entity).sort()).toEqual(
      ['actorId', 'entityId', 'kind', 'transform', 'visible'].sort(),
    );
    expect(entity.kind).toBe('character');
  });

  it('honours a custom actorId and entityId', () => {
    const customActorId = parseActorId('farmer-42');
    const customEntityId = parseEntityId('entity-42');
    const manager = createWorldManager({ actorId: customActorId, entityId: customEntityId });

    const snapshot = manager.getSnapshot({ actorId: customActorId });
    expect(snapshot.entities[0]).toEqual({
      entityId: 'entity-42',
      actorId: 'farmer-42',
      kind: 'character',
      transform: { x: 5, y: 5 },
      visible: true,
    });
    expect(snapshot.controlledActorId).toBe(customActorId);
  });
});

describe('entity collection', () => {
  it('contains the controlled actor plus exactly one entity per tree, in row-major order', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.entities).toHaveLength(3);

    const [actor, tree1, tree2] = snapshot.entities;
    expect(actor).toEqual({
      entityId: 'entity-1',
      actorId: 'actor-1',
      kind: 'character',
      transform: { x: 5, y: 5 },
      visible: true,
    });
    expect(actor.actorId).toBe(snapshot.controlledActorId);

    expect(tree1).toEqual({
      entityId: 'tree-1',
      actorId: null,
      kind: 'tree',
      transform: { x: 6, y: 4 },
      visible: true,
    });
    expect(tree2).toEqual({
      entityId: 'tree-2',
      actorId: null,
      kind: 'tree',
      transform: { x: 4, y: 7 },
      visible: true,
    });
  });

  it('assigns tree ids through parseEntityId (branded, no cast)', () => {
    const manager = createWorldManager();
    const trees = manager
      .getSnapshot({ actorId: ACTOR_ID })
      .entities.filter((entity) => entity.kind === 'tree');

    expect(trees.map((tree) => tree.entityId)).toEqual([
      parseEntityId('tree-1'),
      parseEntityId('tree-2'),
    ]);
  });

  it('the T cells carry grass terrain (trees stand on walkable ground)', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(tileAt(snapshot, 6, 4)).toEqual({
      transform: { x: 6, y: 4 },
      terrain: 'grass',
    });
    expect(tileAt(snapshot, 4, 7)).toEqual({
      transform: { x: 4, y: 7 },
      terrain: 'grass',
    });
    expect(WALKABILITY_BY_TERRAIN[tileAt(snapshot, 6, 4).terrain]).toBe(true);
  });

  it('delivers props whole in the snapshot (no entity.spawned event)', () => {
    const manager = createWorldManager();
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.entities.filter((entity) => entity.kind === 'tree')).toHaveLength(2);
    expect(isWorldSnapshot(snapshot)).toBe(true);
  });
});

describe('construction validation', () => {
  it('throws RangeError when the map centre is not walkable', () => {
    expect(() => createWorldManager({ map: ['ggg', 'g#g', 'ggg'] })).toThrow(RangeError);
    expect(() => createWorldManager({ map: ['ggggg', 'ggggg', 'gg#gg', 'ggggg', 'ggggg'] })).toThrow(
      RangeError,
    );

    // The failure names the centre coordinate and the broken rule (walkability).
    let caught: unknown;
    try {
      createWorldManager({ map: ['ggg', 'g#g', 'ggg'] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    const message = (caught as RangeError).message;
    expect(message).toContain('(1, 1)');
    expect(message).toMatch(/walkable/i);
  });

  it('throws RangeError when a blocking entity occupies the map centre', () => {
    // A `T` centre has WALKABLE grass terrain but a blocking tree: walkability
    // alone would let the actor spawn on a tile it can never legally re-enter.
    const map = ['ggg', 'gTg', 'ggg'];

    let caught: unknown;
    try {
      createWorldManager({ map });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    const message = (caught as RangeError).message;
    expect(message).toContain('(1, 1)');
    expect(message).toMatch(/blocking/i);
  });

  it.each([
    ['empty map', []],
    ['empty row', ['']],
    ['ragged map (short second row)', ['gg', 'ggg']],
    ['ragged map (long second row)', ['ggg', 'gg']],
    ['unknown character', ['ggg', 'gxg', 'ggg']],
    ['unknown character in first row', ['gx', 'gg']],
  ])('throws RangeError for an %s', (_label, map) => {
    expect(() => createWorldManager({ map })).toThrow(RangeError);
  });

  it('accepts the new water and tree legend characters', () => {
    const water = createWorldManager({ map: ['wgg', 'ggg', 'ggg'] });
    expect(tileAt(water.getSnapshot({ actorId: ACTOR_ID }), 0, 0).terrain).toBe('water');

    const tree = createWorldManager({ map: ['Tgg', 'ggg', 'ggg'] });
    const treeSnapshot = tree.getSnapshot({ actorId: ACTOR_ID });
    expect(tileAt(treeSnapshot, 0, 0).terrain).toBe('grass');
    expect(treeSnapshot.entities).toHaveLength(2);
    expect(treeSnapshot.entities[1]).toEqual({
      entityId: 'tree-1',
      actorId: null,
      kind: 'tree',
      transform: { x: 0, y: 0 },
      visible: true,
    });
  });

  it('derives size from the map, so the two can never disagree', () => {
    const manager = createWorldManager({ map: ALL_GRASS_3 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 3, height: 3 });
  });

  it('honours a custom worldId', () => {
    const worldId = parseWorldId('farm-7');
    const manager = createWorldManager({ worldId });
    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(snapshot.worldId).toBe(worldId);
    expect(snapshot.worldId).toBe('farm-7');
    expect(isWorldSnapshot(snapshot)).toBe(true);
  });
});

describe('movement in each direction', () => {
  const cases: Array<{ direction: MoveDirection; to: { x: number; y: number } }> = [
    { direction: 'north', to: { x: 5, y: 4 } },
    { direction: 'south', to: { x: 5, y: 6 } },
    { direction: 'east', to: { x: 6, y: 5 } },
    { direction: 'west', to: { x: 4, y: 5 } },
  ];

  it.each(cases)(
    '$direction emits exactly one transform.changed event carrying the NEW transform',
    ({ direction, to }) => {
      const clock = fakeClock(START);
      const manager = createWorldManager({ clock: clock.now });

      const result = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove(direction) });

      expect(result).toEqual({
        events: [{ type: 'transform.changed', entityId: ENTITY_ID, transform: to }],
        serverTime: START.toISOString(),
      });
      expect(result.events).toHaveLength(1);
      expect(isTransformChangedEvent(result.events[0])).toBe(true);
      expect(isSubmitCommandResponse(result)).toBe(true);
      expect(entityTransform(manager)).toEqual(to);
    },
  );

  it('walking onto a path tile succeeds (walkable but visually different)', () => {
    const manager = createWorldManager({ map: ['gpg', 'ggg', 'ggg'] });

    const result = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });

    expect(result.events).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 1, y: 0 });

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(tileAt(snapshot, 1, 1).terrain).toBe('grass'); // started on grass
    expect(tileAt(snapshot, 1, 0).terrain).toBe('path'); // stepped onto path
    expect(WALKABILITY_BY_TERRAIN[tileAt(snapshot, 1, 0).terrain]).toBe(true);
  });
});

describe('collision refusal', () => {
  it('refuses a step into a blocked tile, then remains usable', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: ['g#g', 'ggg', 'ggg'], clock: clock.now });
    const before = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(before.entities[0].transform).toEqual({ x: 1, y: 1 });
    expect(tileAt(before, 1, 0).terrain).toBe('blocked');

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });

    expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
    expect(entityTransform(manager)).toEqual({ x: 1, y: 1 });
    // The whole world state is untouched, not just the actor transform.
    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual(before);

    // Recoverable: a legal move still works and emits exactly one event.
    const recovered = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    expect(recovered.events).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 2, y: 1 });
  });

  it('refuses a step into a blocked tile diagonally adjacent to the path', () => {
    const manager = createWorldManager({ map: ['gpg', 'ggg', 'gp#'] });
    // Walk onto the path first, then try to step into the blocked corner.
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') }).events).toHaveLength(
      1,
    ); // (1,1) -> (1,2) 'p'
    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    expect(refused.events).toEqual([]); // (2,2) is '#'
    expect(entityTransform(manager)).toEqual({ x: 1, y: 2 });
  });

  it.each([
    { direction: 'west' as MoveDirection, edge: { x: 0, y: 1 }, back: 'east' as MoveDirection },
    { direction: 'east' as MoveDirection, edge: { x: 2, y: 1 }, back: 'west' as MoveDirection },
    { direction: 'north' as MoveDirection, edge: { x: 1, y: 0 }, back: 'south' as MoveDirection },
    { direction: 'south' as MoveDirection, edge: { x: 1, y: 2 }, back: 'north' as MoveDirection },
  ])(
    'refuses an out-of-bounds $direction step at the edge and leaves state untouched',
    ({ direction, edge, back }) => {
      const clock = fakeClock(START);
      const manager = createWorldManager({ map: ALL_GRASS_3, clock: clock.now });

      // Step once to reach the edge, then attempt to leave the world.
      expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove(direction) }).events).toHaveLength(1);
      expect(entityTransform(manager)).toEqual(edge);

      const before = manager.getSnapshot({ actorId: ACTOR_ID });
      const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove(direction) });

      expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
      expect(entityTransform(manager)).toEqual(edge);
      expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual(before);

      // Recoverable.
      expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove(back) }).events).toHaveLength(1);
    },
  );

  it('does not throw for an out-of-bounds step and reports an empty event list', () => {
    const manager = createWorldManager({ map: ['g'] });
    expect(() =>
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }),
    ).not.toThrow();
    expect(manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events).toEqual([]);
  });
});

describe('entity blocking (second authoritative rule)', () => {
  it('refuses a step south from (6,3) into the tree at (6,4), then recovers', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    // Walk to (6,3): (5,5) -> (5,4) -> (5,3) -> (6,3), all walkable grass.
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events,
    ).toHaveLength(1);
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events,
    ).toHaveLength(1);
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') }).events,
    ).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 6, y: 3 });

    // (6,4) is walkable grass terrain, but occupied by the tree -> refused.
    const before = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(tileAt(before, 6, 4).terrain).toBe('grass');
    expect(WALKABILITY_BY_TERRAIN[tileAt(before, 6, 4).terrain]).toBe(true);

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') });

    expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
    expect(entityTransform(manager)).toEqual({ x: 6, y: 3 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual(before);

    // Recoverable: a legal step still works and emits exactly one event.
    const recovered = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    expect(recovered.events).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 7, y: 3 });
  });

  it('refuses a step north from (6,5) into the same tree, then recovers', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    // Walk to (6,5): (5,5) -> (6,5), walkable grass.
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') }).events,
    ).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 6, y: 5 });

    const before = manager.getSnapshot({ actorId: ACTOR_ID });
    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });

    expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
    expect(entityTransform(manager)).toEqual({ x: 6, y: 5 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual(before);

    const recovered = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('south') });
    expect(recovered.events).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 6, y: 6 });
  });

  it('treats blocking as per-tile occupancy: the actor stands at (6,3) and (6,5)', () => {
    const north = createWorldManager();
    // (6,3): (5,5) -> (5,4) -> (5,3) -> (6,3)
    north.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });
    north.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });
    north.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    expect(entityTransform(north)).toEqual({ x: 6, y: 3 });

    const south = createWorldManager();
    // (6,5): (5,5) -> (6,5)
    south.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    expect(entityTransform(south)).toEqual({ x: 6, y: 5 });
  });

  it('refuses water exactly like blocked terrain', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    // Walk to (5,3), adjacent to the water at (4,3).
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events,
    ).toHaveLength(1);
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).events,
    ).toHaveLength(1);
    expect(entityTransform(manager)).toEqual({ x: 5, y: 3 });

    const before = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(tileAt(before, 4, 3).terrain).toBe('water');
    expect(WALKABILITY_BY_TERRAIN[tileAt(before, 4, 3).terrain]).toBe(false);

    const refused = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') });
    expect(refused).toEqual({ events: [], serverTime: START.toISOString() });
    expect(entityTransform(manager)).toEqual({ x: 5, y: 3 });
    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual(before);
  });
});

describe('UnknownActorError', () => {
  it('submitCommand throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.submitCommand({ actorId: ghost, command: actorMove('north') });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownActorError);
    const error = caught as UnknownActorError;
    expect(error.name).toBe('UnknownActorError');
    expect(error.actorId).toBe('ghost');
  });

  it('getSnapshot throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.getSnapshot({ actorId: ghost });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownActorError);
    const error = caught as UnknownActorError;
    expect(error.name).toBe('UnknownActorError');
    expect(error.actorId).toBe(ghost);
  });

  it('accepts the configured actorId even when overridden', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    expect(() =>
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }),
    ).toThrow(UnknownActorError);
    expect(() => manager.getSnapshot({ actorId: ACTOR_ID })).toThrow(UnknownActorError);
    expect(
      manager.submitCommand({ actorId: customActorId, command: actorMove('north') }).events,
    ).toHaveLength(1);
  });
});

describe('typed-input actor scoping', () => {
  it('uses the ActorId from the typed input, not the command', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    const result = manager.submitCommand({ actorId: customActorId, command: actorMove('east') });
    const [event] = result.events;
    expect(event.type).toBe('transform.changed');

    const snapshot = manager.getSnapshot({ actorId: customActorId });
    expect(snapshot.controlledActorId).toBe(customActorId);
    expect(snapshot.entities[0].actorId).toBe(customActorId);
    const entityActorId: ActorId | null = snapshot.entities[0].actorId;
    expect(entityActorId).toBe(customActorId);
  });

  it('a command carries only type + direction, never an actor field', () => {
    const command = actorMove('north');
    expect(Object.keys(command).sort()).toEqual(['direction', 'type']);
  });
});

describe('serverTime', () => {
  it('is deterministic from an injected clock and reflects the call time', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });

    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:05.000Z');

    clock.advance(1_000);
    expect(
      manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') }).serverTime,
    ).toBe('2025-01-02T03:04:06.000Z');

    // A refused step (out of bounds) still stamps the call time.
    const edgeManager = createWorldManager({ map: ['g'], clock: clock.now });
    const refused = edgeManager.submitCommand({ actorId: ACTOR_ID, command: actorMove('north') });
    expect(refused.events).toEqual([]);
    expect(refused.serverTime).toBe('2025-01-02T03:04:06.000Z');

    clock.advance(1_000);
    expect(manager.getSnapshot({ actorId: ACTOR_ID }).serverTime).toBe('2025-01-02T03:04:07.000Z');
  });
});

describe('defensive copies', () => {
  it('mutating a returned tiles array or a tile transform does not affect later reads', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    snapshot.tiles[0].transform.x = 999;
    snapshot.tiles[0].transform.y = 999;
    snapshot.tiles[0].terrain = 'blocked';
    snapshot.tiles.push({ transform: { x: -1, y: -1 }, terrain: 'blocked' });
    snapshot.tiles.length = 0;

    const fresh = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(fresh.tiles).toHaveLength(100);
    expect(tileAt(fresh, 0, 0)).toEqual({ transform: { x: 0, y: 0 }, terrain: 'grass' });
  });

  it('returns fresh tile arrays and nested objects each read', () => {
    const manager = createWorldManager();
    const first = manager.getSnapshot({ actorId: ACTOR_ID });
    const second = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(first.tiles).not.toBe(second.tiles);
    expect(first.tiles[0]).not.toBe(second.tiles[0]);
    expect(first.tiles[0].transform).not.toBe(second.tiles[0].transform);
    expect(first.entities[0].transform).not.toBe(second.entities[0].transform);
  });

  it('mutating a snapshot entity does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    snapshot.entities[0].transform.x = 999;
    snapshot.entities[0].transform.y = 999;
    snapshot.entities[0].actorId = parseActorId('hacked');
    snapshot.entities.push({ ...snapshot.entities[0] });
    snapshot.size.width = 999;
    snapshot.controlledActorId = parseActorId('hacked');

    expect(manager.getSnapshot({ actorId: ACTOR_ID })).toEqual({
      worldId: WORLD_ID,
      size: { width: 10, height: 10 },
      tiles: expect.any(Array),
      entities: [
        {
          entityId: 'entity-1',
          actorId: 'actor-1',
          kind: 'character',
          transform: { x: 5, y: 5 },
          visible: true,
        },
        {
          entityId: 'tree-1',
          actorId: null,
          kind: 'tree',
          transform: { x: 6, y: 4 },
          visible: true,
        },
        {
          entityId: 'tree-2',
          actorId: null,
          kind: 'tree',
          transform: { x: 4, y: 7 },
          visible: true,
        },
      ],
      controlledActorId: 'actor-1',
      serverTime: expect.any(String),
    });
  });

  it('mutating the entities array or a tree transform does not affect later reads', () => {
    const manager = createWorldManager();

    const snapshot = manager.getSnapshot({ actorId: ACTOR_ID });
    snapshot.entities[1].transform.x = 999;
    snapshot.entities[1].transform.y = 999;
    snapshot.entities[1].actorId = parseActorId('hacked');
    snapshot.entities.push({ ...snapshot.entities[0] });
    snapshot.entities.length = 0;

    const fresh = manager.getSnapshot({ actorId: ACTOR_ID });
    expect(fresh.entities).toHaveLength(3);
    expect(fresh.entities[1]).toEqual({
      entityId: 'tree-1',
      actorId: null,
      kind: 'tree',
      transform: { x: 6, y: 4 },
      visible: true,
    });
    expect(fresh.entities[2].transform).toEqual({ x: 4, y: 7 });
  });

  it('returns fresh entities arrays and fresh nested entity transforms each read', () => {
    const manager = createWorldManager();
    const first = manager.getSnapshot({ actorId: ACTOR_ID });
    const second = manager.getSnapshot({ actorId: ACTOR_ID });

    expect(first.entities).not.toBe(second.entities);
    first.entities.forEach((entity, index) => {
      expect(entity).not.toBe(second.entities[index]);
      expect(entity.transform).not.toBe(second.entities[index].transform);
    });
  });

  it('mutating a submitCommand result does not corrupt authoritative state', () => {
    const manager = createWorldManager();

    const result = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const [event] = result.events;
    if (event.type === 'transform.changed') {
      event.transform.x = -50;
      event.transform.y = -50;
    }
    result.events.push({ type: 'transform.changed', entityId: ENTITY_ID, transform: { x: 1, y: 1 } });

    expect(entityTransform(manager)).toEqual({ x: 6, y: 5 });

    const next = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const [nextEvent] = next.events;
    expect(nextEvent.type).toBe('transform.changed');
    if (nextEvent.type === 'transform.changed') {
      expect(nextEvent.transform).toEqual({ x: 7, y: 5 });
    }
  });

  it('returns a fresh events array per command call', () => {
    const manager = createWorldManager();
    const first = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    const second = manager.submitCommand({ actorId: ACTOR_ID, command: actorMove('west') });

    expect(first.events).not.toBe(second.events);
    expect(first.events[0]).not.toBe(second.events[0]);
  });
});

describe('manager instances', () => {
  it('are independent', () => {
    const a = createWorldManager();
    const b = createWorldManager({ map: ALL_GRASS_4 });

    a.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });
    a.submitCommand({ actorId: ACTOR_ID, command: actorMove('east') });

    expect(entityTransform(a)).toEqual({ x: 7, y: 5 });
    expect(entityTransform(b)).toEqual({ x: 2, y: 2 });
    expect(a.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 10, height: 10 });
    expect(b.getSnapshot({ actorId: ACTOR_ID }).size).toEqual({ width: 4, height: 4 });
  });
});
