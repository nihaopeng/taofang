import { describe, expect, it } from 'vitest';

import {
  isGameEventBatch,
  isTransformChangedEvent,
  isWorldSnapshot,
  parseActorId,
  parseEntityId,
  parseWorldId,
} from '@starvalley/protocol';
import type {
  CellCoord,
  GameCommand,
  GridSpec,
  MoveToCommand,
  WorldSnapshot,
} from '@starvalley/protocol';
import { QUAT_IDENTITY, yawFromQuat } from '@starvalley/math';

import {
  BLOCKING_BY_ENTITY_KIND,
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  DEFAULT_WORLD_MAP,
  INTERACTABLE_BY_ENTITY_KIND,
  INTERACTION_RANGE,
  InteractionRejectedError,
  TICK_RATE_HZ,
  UnknownActorError,
  UnknownEntityError,
  WALKABILITY_BY_TERRAIN,
  cellCentre,
  cellOf,
  createWorldManager,
  distanceXZ,
} from '../src/index.ts';

const START = new Date('2025-01-02T03:04:05.000Z');

const ACTOR_ID = parseActorId('actor-1');
const ENTITY_ID = parseEntityId('entity-1');
const WORLD_ID = parseWorldId('world-1');

const BLOCK_NORTH_3 = ['g#g', 'ggg', 'ggg'] as const;
const PROP_NORTH_3 = ['gTg', 'ggg', 'ggg'] as const;
const ALL_GRASS_3 = ['ggg', 'ggg', 'ggg'] as const;
const ALL_GRASS_5 = ['ggggg', 'ggggg', 'ggggg', 'ggggg', 'ggggg'] as const;

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

/** Build a movement-intent command; a command deliberately carries no actor field. */
function move(movement: { x: number; z: number }): GameCommand {
  return { type: 'actor.moveIntent', movement };
}

/** Build a world-space steering goal command. */
function moveTo(target: { x: number; y: number; z: number }): MoveToCommand {
  return { type: 'actor.moveTo', target };
}

/** Build an interaction command against an entity id. */
function interact(targetEntityId: ReturnType<typeof parseEntityId>): GameCommand {
  return { type: 'actor.interact', targetEntityId };
}

function snapshotOf(manager: ReturnType<typeof createWorldManager>): WorldSnapshot {
  return manager.getSnapshot({ actorId: ACTOR_ID });
}

/** The controlled actor entity, which is always delivered first. */
function actorOf(manager: ReturnType<typeof createWorldManager>) {
  return snapshotOf(manager).entities[0];
}

function positionOf(manager: ReturnType<typeof createWorldManager>) {
  return actorOf(manager).transform.position;
}

/** Row-major tile lookup, deriving the row stride from the snapshot itself. */
function tileAt(snapshot: WorldSnapshot, x: number, z: number) {
  return snapshot.tiles[z * snapshot.grid.width + x];
}

/** Drive `steps` fixed 50 ms ticks. */
function run(manager: ReturnType<typeof createWorldManager>, steps: number): void {
  for (let i = 0; i < steps; i += 1) {
    manager.step(50);
  }
}

describe('frozen constants', () => {
  it('exposes the 20 Hz tick rate, speed and radius', () => {
    expect(TICK_RATE_HZ).toBe(20);
    expect(DEFAULT_ACTOR_SPEED).toBe(3);
    expect(DEFAULT_ACTOR_RADIUS).toBe(0.35);
  });

  it('keeps the walkability rule (it builds colliders): grass/path walkable, blocked/water not', () => {
    expect(WALKABILITY_BY_TERRAIN).toEqual({
      grass: true,
      path: true,
      blocked: false,
      water: false,
    });
  });

  it('keeps the blocking rule (it gives props colliders): trees block, characters do not', () => {
    expect(BLOCKING_BY_ENTITY_KIND).toEqual({ character: false, tree: true });
  });
});

describe('DEFAULT_WORLD_MAP', () => {
  it('is a 10x10 ASCII layout containing the full legend', () => {
    expect(DEFAULT_WORLD_MAP).toHaveLength(10);
    for (const row of DEFAULT_WORLD_MAP) {
      expect(row).toHaveLength(10);
    }
    const characters = new Set(DEFAULT_WORLD_MAP.join('').split(''));
    for (const character of ['g', 'p', '#', 'w', 'T']) {
      expect(characters).toContain(character);
    }
  });

  it('has a walkable, unoccupied centre cell', () => {
    expect(DEFAULT_WORLD_MAP[5][5]).toBe('g');
  });
});

describe('grid and bounds derivation', () => {
  it('derives the grid from the map with an explicit, world-origin-independent origin', () => {
    const snapshot = snapshotOf(createWorldManager());

    expect(snapshot.grid).toEqual({ origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 });
    // cell(0,0) is deliberately NOT bound to the world origin.
    expect(snapshot.grid.origin).not.toEqual({ x: 0, y: 0, z: 0 });
  });

  it('defaults bounds to a separate world box comfortably containing the grid (y 0..8)', () => {
    const snapshot = snapshotOf(createWorldManager());

    expect(snapshot.bounds).toEqual({ min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } });
    // Bounds comfortably contain the grid in XZ.
    expect(snapshot.bounds.min.x).toBeLessThan(snapshot.grid.origin.x);
    expect(snapshot.bounds.min.z).toBeLessThan(snapshot.grid.origin.z);
    expect(snapshot.bounds.max.x).toBeGreaterThan(
      snapshot.grid.origin.x + snapshot.grid.width * snapshot.grid.cellSize,
    );
    expect(snapshot.bounds.max.z).toBeGreaterThan(
      snapshot.grid.origin.z + snapshot.grid.depth * snapshot.grid.cellSize,
    );
  });

  it('honours explicit grid origin and cellSize overrides', () => {
    const snapshot = snapshotOf(
      createWorldManager({ map: ALL_GRASS_3, grid: { origin: { x: 10, y: 0, z: -4 }, cellSize: 2 } }),
    );

    expect(snapshot.grid).toEqual({ origin: { x: 10, y: 0, z: -4 }, width: 3, depth: 3, cellSize: 2 });
    // The default bounds track the overridden grid.
    expect(snapshot.bounds.min).toEqual({ x: 8, y: 0, z: -6 });
    expect(snapshot.bounds.max).toEqual({ x: 18, y: 8, z: 4 });
  });

  it('honours an explicit bounds override', () => {
    const bounds = { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 4, z: 2 } };
    const snapshot = snapshotOf(createWorldManager({ map: ALL_GRASS_3, bounds }));

    expect(snapshot.bounds).toEqual(bounds);
  });

  it('is Protocol-valid', () => {
    expect(isWorldSnapshot(snapshotOf(createWorldManager()))).toBe(true);
  });
});

describe('tiles', () => {
  it('has exactly one { cell, terrain } tile per grid cell, row-major', () => {
    const snapshot = snapshotOf(createWorldManager());

    expect(snapshot.tiles).toHaveLength(snapshot.grid.width * snapshot.grid.depth);
    for (const tile of snapshot.tiles) {
      expect(Object.keys(tile).sort()).toEqual(['cell', 'terrain']);
    }

    for (let z = 0; z < snapshot.grid.depth; z += 1) {
      for (let x = 0; x < snapshot.grid.width; x += 1) {
        const tile = tileAt(snapshot, x, z);
        expect(tile.cell).toEqual({ x, z });
        expect(tile.terrain).toBe(
          DEFAULT_WORLD_MAP[z][x] === 'T'
            ? 'grass'
            : DEFAULT_WORLD_MAP[z][x] === '#'
              ? 'blocked'
              : DEFAULT_WORLD_MAP[z][x] === 'p'
                ? 'path'
                : DEFAULT_WORLD_MAP[z][x] === 'w'
                  ? 'water'
                  : 'grass',
        );
      }
    }
  });

  it('decodes the four terrain kinds on a custom map', () => {
    const snapshot = snapshotOf(createWorldManager({ map: ['g#p', 'ppg', '#gg'] }));

    expect(tileAt(snapshot, 0, 0).terrain).toBe('grass');
    expect(tileAt(snapshot, 1, 0).terrain).toBe('blocked');
    expect(tileAt(snapshot, 2, 0).terrain).toBe('path');
    expect(tileAt(snapshot, 0, 1).terrain).toBe('path');
    expect(tileAt(snapshot, 0, 2).terrain).toBe('blocked');
    expect(tileAt(snapshot, 2, 2).terrain).toBe('grass');
  });
});

describe('cellCentre / cellOf', () => {
  const defaultGrid: GridSpec = { origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 };

  it('matches the frozen formula for several cells including (0,0) and negatives', () => {
    expect(cellCentre(defaultGrid, { x: 0, z: 0 })).toEqual({ x: -4.5, y: 0, z: -4.5 });
    expect(cellCentre(defaultGrid, { x: 9, z: 9 })).toEqual({ x: 4.5, y: 0, z: 4.5 });
    expect(cellCentre(defaultGrid, { x: -1, z: -2 })).toEqual({ x: -5.5, y: 0, z: -6.5 });
    expect(cellCentre(defaultGrid, { x: 3, z: -4 })).toEqual({ x: -1.5, y: 0, z: -8.5 });
  });

  it('uses the cell centre (origin + 0.5*cellSize), never the origin itself', () => {
    const centre = cellCentre(defaultGrid, { x: 0, z: 0 });
    expect(centre.x).toBe(defaultGrid.origin.x + 0.5 * defaultGrid.cellSize);
    expect(centre.z).toBe(defaultGrid.origin.z + 0.5 * defaultGrid.cellSize);
    expect(centre.y).toBe(defaultGrid.origin.y);
  });

  it('respects a fractional/free cellSize and non-zero origin', () => {
    const grid: GridSpec = { origin: { x: 10, y: 2, z: -4 }, width: 4, depth: 3, cellSize: 2 };
    expect(cellCentre(grid, { x: 1, z: 2 })).toEqual({ x: 13, y: 2, z: 1 });
  });

  it('cellOf inverts cellCentre for many cells, including negatives', () => {
    const cells: CellCoord[] = [
      { x: 0, z: 0 },
      { x: 5, z: 5 },
      { x: 9, z: 0 },
      { x: 0, z: 9 },
      { x: -1, z: -2 },
      { x: -7, z: 3 },
    ];
    for (const cell of cells) {
      expect(cellOf(defaultGrid, cellCentre(defaultGrid, cell))).toEqual(cell);
    }
  });

  it('cellOf is the WORLD rule: it maps any position and does not clamp to the grid', () => {
    expect(cellOf(defaultGrid, { x: -4.6, y: 0, z: -4.6 })).toEqual({ x: 0, z: 0 });
    expect(cellOf(defaultGrid, { x: 100, y: 0, z: 100 })).toEqual({ x: 105, z: 105 });
  });

  it('is exposed by the manager grid as well', () => {
    const snapshot = snapshotOf(createWorldManager());
    expect(cellOf(snapshot.grid, { x: 0.5, y: 0, z: 0.5 })).toEqual({ x: 5, z: 5 });
  });
});

describe('spawn', () => {
  it("spawns at the centre cell's world centre (origin + 0.5*cellSize)", () => {
    const manager = createWorldManager();
    const snapshot = snapshotOf(manager);
    const centre = cellCentre(snapshot.grid, { x: 5, z: 5 });

    expect(centre).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(positionOf(manager)).toEqual(centre);
    expect(actorOf(manager).transform.rotation).toEqual(QUAT_IDENTITY);
  });

  it('starts facing +Z (yaw 0) and on the ground', () => {
    const manager = createWorldManager();
    expect(yawFromQuat(actorOf(manager).transform.rotation)).toBeCloseTo(0, 10);
    expect(positionOf(manager).y).toBe(0);
  });

  it('puts tree props at their cells world centres', () => {
    const snapshot = snapshotOf(createWorldManager());
    const trees = snapshot.entities.filter((entity) => entity.kind === 'tree');

    expect(trees).toHaveLength(2);
    expect(trees[0].entityId).toBe(parseEntityId('tree-1'));
    expect(trees[0].transform.position).toEqual(cellCentre(snapshot.grid, { x: 6, z: 4 }));
    expect(trees[1].transform.position).toEqual(cellCentre(snapshot.grid, { x: 4, z: 7 }));
    expect(trees[0].actorId).toBeNull();
  });
});

describe('continuous movement', () => {
  it('step(50) at speed 3 moves 0.15 world units', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });

    manager.step(50);

    expect(positionOf(manager).x).toBeCloseTo(0.5, 10);
    expect(positionOf(manager).z).toBeCloseTo(0.65, 10);
  });

  it('two steps move twice as far', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });

    manager.step(50);
    const afterOne = positionOf(manager).z - 0.5;
    manager.step(50);
    const afterTwo = positionOf(manager).z - 0.5;

    expect(afterOne).toBeCloseTo(0.15, 10);
    expect(afterTwo).toBeCloseTo(0.3, 10);
    expect(afterTwo).toBeCloseTo(2 * afterOne, 10);
  });

  it('is deterministic for a given dtMs and intent', () => {
    const a = createWorldManager();
    const b = createWorldManager();
    for (const manager of [a, b]) {
      manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0.25, z: -0.5 }) });
      manager.step(33);
      manager.step(17);
    }
    expect(positionOf(a)).toEqual(positionOf(b));
  });

  it('respects the speed configuration (dt and speed multiply linearly)', () => {
    const slower = createWorldManager({ actorSpeed: 1.5 });
    slower.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    slower.step(100);
    expect(positionOf(slower).x).toBeCloseTo(0.65, 10); // 0.5 + 1.5 * 0.1
  });

  it('a diagonal intent is clamped to unit magnitude, so it is not faster than a cardinal one', () => {
    const manager = createWorldManager();
    // |(1,1)| = sqrt(2) > 1: the manager defensively clamps it.
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 1 }) });
    manager.step(50);

    const start = { x: 0.5, z: 0.5 };
    const dx = positionOf(manager).x - start.x;
    const dz = positionOf(manager).z - start.z;
    const distance = Math.hypot(dx, dz);

    expect(distance).toBeCloseTo(0.15, 10);
    expect(distance).toBeLessThanOrEqual(0.15 + 1e-9);
    // Both components moved (a genuine diagonal, just scaled down).
    expect(dx).toBeCloseTo(0.15 / Math.SQRT2, 10);
    expect(dz).toBeCloseTo(0.15 / Math.SQRT2, 10);
  });

  it('an analog (sub-unit) intent moves proportionally less far', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -0.5 }) });
    manager.step(50);

    expect(positionOf(manager).z).toBeCloseTo(0.5 - 0.075, 10);
  });

  it('step(0) is a strict no-op', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });

    const result = manager.step(0);

    expect(result.events).toEqual([]);
    expect(positionOf(manager)).toEqual({ x: 0.5, y: 0, z: 0.5 });
  });

  it('emits exactly one transform.changed per moving step, carrying 3D position and heading', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });

    const result = manager.step(50);

    expect(result.serverTime).toBe(START.toISOString());
    expect(result.events).toHaveLength(1);
    expect(isTransformChangedEvent(result.events[0])).toBe(true);
    expect(isGameEventBatch(result)).toBe(true);
    const [event] = result.events;
    if (event.type === 'transform.changed') {
      expect(event.entityId).toBe(ENTITY_ID);
      expect(event.transform.position).toEqual({ x: 0.65, y: 0, z: 0.5 });
      expect(yawFromQuat(event.transform.rotation)).toBeCloseTo(Math.PI / 2, 10);
    }
  });

  it.each([
    { movement: { x: 0, z: -1 }, to: { x: 0.5, y: 0, z: 0.35 }, yaw: Math.PI },
    { movement: { x: 0, z: 1 }, to: { x: 0.5, y: 0, z: 0.65 }, yaw: 0 },
    { movement: { x: 1, z: 0 }, to: { x: 0.65, y: 0, z: 0.5 }, yaw: Math.PI / 2 },
    { movement: { x: -1, z: 0 }, to: { x: 0.35, y: 0, z: 0.5 }, yaw: -Math.PI / 2 },
  ])(
    'sets the authoritative yaw for cardinal movement $movement',
    ({ movement, to, yaw }) => {
      const manager = createWorldManager();
      manager.submitIntent({ actorId: ACTOR_ID, command: move(movement) });
      const result = manager.step(50);

      const [event] = result.events;
      expect(event.type).toBe('transform.changed');
      if (event.type === 'transform.changed') {
        expect(event.transform.position).toEqual(to);
        expect(yawFromQuat(event.transform.rotation)).toBeCloseTo(yaw, 10);
      }
      expect(positionOf(manager)).toEqual(to);
    },
  );

  it('keeps the last heading when the intent is zero', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    manager.step(50);
    const heading = actorOf(manager).transform.rotation;

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 0 }) });
    manager.step(50);

    expect(actorOf(manager).transform.rotation).toEqual(heading);
  });
});

describe('level-triggered intent', () => {
  it('persists across steps until replaced', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });

    manager.step(50);
    expect(positionOf(manager).z).toBeCloseTo(0.65, 10);
    // No new submitIntent: the stored intent is applied again.
    manager.step(50);
    expect(positionOf(manager).z).toBeCloseTo(0.8, 10);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    manager.step(50);
    expect(positionOf(manager).x).toBeCloseTo(0.65, 10);
    expect(positionOf(manager).z).toBeCloseTo(0.8, 10);
  });

  it('a zero intent stops the actor and emits nothing', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });
    manager.step(50);
    const stopped = positionOf(manager);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 0 }) });
    const result = manager.step(50);

    expect(result).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(stopped);
  });

  it('submitIntent changes no world state and returns an empty batch', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ clock: clock.now });
    const before = snapshotOf(manager);

    const result = manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 1 }) });

    expect(result).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(before.entities[0].transform.position);
  });
});

describe('world-space collision', () => {
  it('stops the actor outside a blocked cell and never enters it', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: BLOCK_NORTH_3, clock: clock.now });
    const grid = snapshotOf(manager).grid;
    expect(tileAt(snapshotOf(manager), 1, 0).terrain).toBe('blocked');

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    run(manager, 30);

    const position = positionOf(manager);
    expect(position.z).toBeCloseTo(-0.15, 10);
    expect(position.z).toBeGreaterThan(-0.5); // outside the blocked cell's AABB
    expect(cellOf(grid, position).z).toBe(1); // never enters blocked cell z = 0
  });

  it('emits no event when movement is fully blocked, and the wall stays solid', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: BLOCK_NORTH_3, clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    manager.step(50);
    const stopped = positionOf(manager);

    const blocked = manager.step(50);

    expect(blocked).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(stopped);
  });

  it('slides a diagonal intent along the wall, keeping the free axis', () => {
    const manager = createWorldManager({ map: BLOCK_NORTH_3 });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: -1 }) });

    manager.step(50);
    const afterOne = positionOf(manager);
    manager.step(50);
    const afterTwo = positionOf(manager);

    // The free axis (X) keeps moving; the blocked axis (Z) stalls at the wall.
    expect(afterTwo.x).toBeGreaterThan(afterOne.x);
    expect(afterTwo.z).toBeCloseTo(afterOne.z, 10);
    expect(afterTwo.z).toBeGreaterThan(-0.5);
  });

  it('a blocking prop blocks movement into its footprint', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: PROP_NORTH_3, clock: clock.now });
    expect(snapshotOf(manager).entities.some((entity) => entity.kind === 'tree')).toBe(true);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    run(manager, 30);

    const position = positionOf(manager);
    expect(position.z).toBeCloseTo(-0.15, 10);
    expect(position.z).toBeGreaterThan(-0.6); // outside the tree footprint
  });

  it('clamps the actor inside the world bounds', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    const bounds = snapshotOf(manager).bounds;

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    run(manager, 100);

    expect(positionOf(manager).x).toBeCloseTo(bounds.max.x - DEFAULT_ACTOR_RADIUS, 10);
    // Fully clamped: further steps emit nothing.
    expect(manager.step(50).events).toEqual([]);
  });

  it('honours an explicit bounds override for clamping', () => {
    const bounds = { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 4, z: 2 } };
    const manager = createWorldManager({ map: ALL_GRASS_3, bounds });

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });
    run(manager, 100);

    expect(positionOf(manager).z).toBeCloseTo(2 - DEFAULT_ACTOR_RADIUS, 10);
  });

  it('never clamps the actor into a collider when bounds cut into an unwalkable cell', () => {
    // `bounds.min.x` is chosen so the clamp line (`bounds.min.x + actorRadius`)
    // sits only 0.25 from the blocked cell's left face - i.e. WITHIN the actor
    // radius. The blocked cell is `(1, 0)`: with the default 3x3 origin `-1.5`
    // its AABB is x[-0.5, 0.5], z[-1.5, -0.5], while the clamp line is x=-0.75.
    // The actor slides left past the cell (its z stays just clear), reaches the
    // clamp line, then descends: the unclamped candidate at x=-0.85 is clear of
    // the collider, but clamping it back to x=-0.75 projects it into the
    // collider's rounded corner. Before the fix the resolution only tested the
    // unclamped endpoint, so this happened. The test asserts the INVARIANT after
    // every tick rather than one magic stop position.
    const map = ['g#g', 'ggg', 'ggg'];
    const bounds = { min: { x: -1.1, y: 0, z: -3.1 }, max: { x: 2.7, y: 4, z: 2.7 } };
    const manager = createWorldManager({ map, bounds });
    const grid = snapshotOf(manager).grid;

    // Colliders are private; rebuild them from the frozen collision rules. This
    // map has no trees, so only unwalkable cells generate colliders.
    const colliders = snapshotOf(manager)
      .tiles.filter((tile) => !WALKABILITY_BY_TERRAIN[tile.terrain])
      .map((tile) => {
        const centre = cellCentre(grid, tile.cell);
        return {
          minX: centre.x - grid.cellSize / 2,
          maxX: centre.x + grid.cellSize / 2,
          minZ: centre.z - grid.cellSize / 2,
          maxZ: centre.z + grid.cellSize / 2,
        };
      });
    expect(colliders).toHaveLength(1);

    const overlapsAnyCollider = (position: { x: number; z: number }): boolean =>
      colliders.some((box) => {
        const nearestX = Math.min(Math.max(position.x, box.minX), box.maxX);
        const nearestZ = Math.min(Math.max(position.z, box.minZ), box.maxZ);
        const dx = position.x - nearestX;
        const dz = position.z - nearestZ;
        return dx * dx + dz * dz < DEFAULT_ACTOR_RADIUS * DEFAULT_ACTOR_RADIUS;
      });

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: -1, z: -1 }) });
    for (let tick = 0; tick < 200; tick += 1) {
      manager.step(50);
      expect(overlapsAnyCollider(positionOf(manager))).toBe(false);
    }
  });
});

describe('UnknownActorError', () => {
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

  it('submitIntent throws for a non-matching actorId and populates actorId', () => {
    const manager = createWorldManager();
    const ghost = parseActorId('ghost');

    let caught: unknown;
    try {
      manager.submitIntent({ actorId: ghost, command: move({ x: 1, z: 0 }) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownActorError);
    expect((caught as UnknownActorError).actorId).toBe('ghost');
  });

  it('accepts a configured custom actorId', () => {
    const customActorId = parseActorId('farmer-7');
    const manager = createWorldManager({ actorId: customActorId });

    expect(() => manager.getSnapshot({ actorId: ACTOR_ID })).toThrow(UnknownActorError);
    expect(() =>
      manager.submitIntent({ actorId: customActorId, command: move({ x: 1, z: 0 }) }),
    ).not.toThrow();
    expect(manager.getSnapshot({ actorId: customActorId }).worldId).toBe(WORLD_ID);
  });
});

describe('construction validation', () => {
  it.each([
    ['empty map', []],
    ['empty row', ['']],
    ['ragged map (short second row)', ['gg', 'ggg']],
    ['ragged map (long second row)', ['ggg', 'gg']],
    ['unknown character', ['ggg', 'gxg', 'ggg']],
  ])('throws RangeError for an %s', (_label, map) => {
    expect(() => createWorldManager({ map })).toThrow(RangeError);
  });

  it('throws RangeError when the centre cell is not walkable', () => {
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

  it('throws RangeError when a blocking prop occupies the centre cell', () => {
    let caught: unknown;
    try {
      createWorldManager({ map: ['ggg', 'gTg', 'ggg'] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    const message = (caught as RangeError).message;
    expect(message).toContain('(1, 1)');
    expect(message).toMatch(/blocking/i);
  });

  it.each([
    ['speed zero', { actorSpeed: 0 }],
    ['speed negative', { actorSpeed: -1 }],
    ['radius zero', { actorRadius: 0 }],
    ['radius negative', { actorRadius: -0.5 }],
    ['cellSize zero', { grid: { cellSize: 0 } }],
    ['cellSize negative', { grid: { cellSize: -2 } }],
    ['non-finite origin', { grid: { origin: { x: Number.NaN, y: 0, z: 0 } } }],
  ])('throws RangeError for %s', (_label, deps) => {
    expect(() => createWorldManager(deps)).toThrow(RangeError);
  });

  it('throws RangeError for inverted bounds (any axis)', () => {
    expect(() =>
      createWorldManager({ map: ALL_GRASS_3, bounds: { min: { x: 1, y: 0, z: 0 }, max: { x: -1, y: 1, z: 1 } } }),
    ).toThrow(RangeError);
    expect(() =>
      createWorldManager({ map: ALL_GRASS_3, bounds: { min: { x: 0, y: 5, z: 0 }, max: { x: 1, y: 1, z: 1 } } }),
    ).toThrow(RangeError);
    expect(() =>
      createWorldManager({ map: ALL_GRASS_3, bounds: { min: { x: 0, y: 0, z: 5 }, max: { x: 1, y: 1, z: 1 } } }),
    ).toThrow(RangeError);
  });
});

describe('defensive copies', () => {
  it('mutating a snapshot grid/bounds/tile does not affect later reads', () => {
    const manager = createWorldManager();

    const snapshot = snapshotOf(manager);
    snapshot.grid.origin.x = 999;
    snapshot.grid.width = 999;
    snapshot.bounds.min.z = 999;
    snapshot.tiles[0].cell.x = 999;
    snapshot.tiles[0].terrain = 'blocked';
    snapshot.tiles.push({ cell: { x: -1, z: -1 }, terrain: 'blocked' });
    snapshot.tiles.length = 0;

    const fresh = snapshotOf(manager);
    expect(fresh.grid).toEqual({ origin: { x: -5, y: 0, z: -5 }, width: 10, depth: 10, cellSize: 1 });
    expect(fresh.bounds).toEqual({ min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } });
    expect(fresh.tiles).toHaveLength(100);
    expect(tileAt(fresh, 0, 0)).toEqual({ cell: { x: 0, z: 0 }, terrain: 'grass' });
  });

  it('mutating a snapshot entity or its nested transform does not corrupt authority', () => {
    const manager = createWorldManager();

    const snapshot = snapshotOf(manager);
    snapshot.entities[0].transform.position.x = 999;
    snapshot.entities[0].transform.rotation = { x: 1, y: 1, z: 1, w: 1 };
    snapshot.entities[1].transform.position.z = 999;
    snapshot.entities.push({ ...snapshot.entities[0] });
    snapshot.entities.length = 0;

    const fresh = snapshotOf(manager);
    expect(fresh.entities).toHaveLength(3);
    expect(fresh.entities[0].transform.position).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(fresh.entities[0].transform.rotation).toEqual(QUAT_IDENTITY);
    expect(fresh.entities[1].transform.position).toEqual(cellCentre(fresh.grid, { x: 6, z: 4 }));
  });

  it('returns fresh arrays and nested objects each read', () => {
    const manager = createWorldManager();
    const first = snapshotOf(manager);
    const second = snapshotOf(manager);

    expect(first.tiles).not.toBe(second.tiles);
    expect(first.tiles[0]).not.toBe(second.tiles[0]);
    expect(first.grid).not.toBe(second.grid);
    expect(first.grid.origin).not.toBe(second.grid.origin);
    expect(first.bounds.min).not.toBe(second.bounds.min);
    expect(first.entities).not.toBe(second.entities);
    for (let i = 0; i < first.entities.length; i += 1) {
      expect(first.entities[i]).not.toBe(second.entities[i]);
      expect(first.entities[i].transform.position).not.toBe(second.entities[i].transform.position);
      expect(first.entities[i].transform.rotation).not.toBe(second.entities[i].transform.rotation);
    }
  });

  it('mutating a step event does not corrupt authoritative state', () => {
    const manager = createWorldManager();
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });

    const result = manager.step(50);
    const [event] = result.events;
    if (event.type === 'transform.changed') {
      event.transform.position.x = -50;
      event.transform.rotation.x = 5;
    }
    result.events.push({
      type: 'transform.changed',
      entityId: ENTITY_ID,
      transform: { position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });

    expect(positionOf(manager)).toEqual({ x: 0.65, y: 0, z: 0.5 });

    const next = manager.step(50);
    const [nextEvent] = next.events;
    if (nextEvent.type === 'transform.changed') {
      expect(nextEvent.transform.position).toEqual({ x: 0.8, y: 0, z: 0.5 });
    }
  });
});

describe('manager instances', () => {
  it('are independent', () => {
    const a = createWorldManager();
    const b = createWorldManager({ map: ALL_GRASS_3 });

    a.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    run(a, 3);
    b.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });
    run(b, 2);

    expect(positionOf(a).x).toBeCloseTo(0.95, 10);
    expect(positionOf(b).z).toBeCloseTo(0.3, 10);
    expect(snapshotOf(a).grid.width).toBe(10);
    expect(snapshotOf(b).grid.width).toBe(3);
  });
});

describe('moveTo steering', () => {
  it('walks toward the goal and arrives EXACTLY on it', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    const target = { x: 0.8, y: 0, z: 0.8 };
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo(target) });

    run(manager, 20);

    expect(positionOf(manager)).toEqual(target);
  });

  it('is a steering goal, not a teleport (multiple ticks to arrive)', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: 2 }) });

    manager.step(50);

    expect(positionOf(manager).z).toBeCloseTo(0.15, 10);
    expect(positionOf(manager).z).not.toBe(2);
  });

  it('steers toward a goal longer than the world and stops at the bounds', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    const bounds = snapshotOf(manager).bounds;
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 100, y: 0, z: 0 }) });

    run(manager, 200);

    expect(positionOf(manager).x).toBeCloseTo(bounds.max.x - DEFAULT_ACTOR_RADIUS, 10);
    // Goal consumed at the clamp: further ticks emit nothing.
    expect(manager.step(50).events).toEqual([]);
  });

  it('ignores the goal y (movement and range are XZ)', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 999, z: 0.5 }) });

    run(manager, 20);

    expect(positionOf(manager)).toEqual({ x: 0, y: 0, z: 0.5 });
  });

  it('emits one transform.changed while moving and nothing once the goal is consumed', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: ALL_GRASS_5, clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: 0.15 }) });

    const moving = manager.step(50);
    expect(moving.events).toHaveLength(1);
    expect(moving.events[0].type).toBe('transform.changed');

    // Arrived exactly this tick: the mode was consumed.
    expect(manager.step(50)).toEqual({ events: [], serverTime: START.toISOString() });
  });

  it('copies the goal so mutating the command afterwards cannot change authority', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    const command = moveTo({ x: 0, y: 0, z: 2 });
    manager.submitIntent({ actorId: ACTOR_ID, command });

    command.target.z = 999;
    run(manager, 30);

    expect(positionOf(manager)).toEqual({ x: 0, y: 0, z: 2 });
  });

  it('does not reject an out-of-bounds/unwalkable goal (it steers and stops)', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    expect(() =>
      manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 100, y: 0, z: 100 }) }),
    ).not.toThrow();
  });
});

describe('moveTo blocked / arrival rules', () => {
  it('stops and CLEARS the mode when an obstacle blocks the goal (further ticks emit nothing)', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: BLOCK_NORTH_3, clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: -3 }) });

    run(manager, 30);

    const stopped = positionOf(manager);
    expect(stopped.z).toBeCloseTo(-0.15, 10);
    expect(stopped.z).toBeGreaterThan(-0.5); // outside the blocked cell's AABB

    // The mode was cleared, so an unreachable goal does not stay pending.
    expect(manager.step(50)).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(stopped);
  });

  it('a moveTo into a blocking prop stops outside its footprint', () => {
    const manager = createWorldManager({ map: PROP_NORTH_3 });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: -3 }) });

    run(manager, 30);

    const stopped = positionOf(manager);
    expect(stopped.z).toBeCloseTo(-0.15, 10);
    expect(manager.step(50).events).toEqual([]);
  });
});

describe('one movement mode per actor', () => {
  it('a direction intent replaces a pending moveTo goal', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: 5 }) });
    manager.step(50); // walks +Z
    const afterGoal = positionOf(manager);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    manager.step(50);

    expect(positionOf(manager).x).toBeGreaterThan(afterGoal.x);
    expect(positionOf(manager).z).toBeCloseTo(afterGoal.z, 10);
  });

  it('a moveTo goal replaces a held direction intent', () => {
    const manager = createWorldManager({ map: ALL_GRASS_5 });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });
    manager.step(50);
    const afterDirection = positionOf(manager);

    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: 5 }) });
    manager.step(50);

    expect(positionOf(manager).z).toBeGreaterThan(afterDirection.z);
  });

  it('a { x: 0, z: 0 } direction clears a pending moveTo goal', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: ALL_GRASS_5, clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 0, y: 0, z: 5 }) });
    const stopped = positionOf(manager);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 0 }) });
    const result = manager.step(50);

    expect(result).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(stopped);
  });

  it('a { x: 0, z: 0 } direction clears a held direction', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: ALL_GRASS_5, clock: clock.now });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    manager.step(50);
    const stopped = positionOf(manager);

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 0 }) });
    const result = manager.step(50);

    expect(result).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(stopped);
  });

  it('movement-command submits return an empty batch and change no world state', () => {
    const clock = fakeClock(START);
    const manager = createWorldManager({ map: ALL_GRASS_5, clock: clock.now });
    const before = positionOf(manager);

    const goal = manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 1, y: 0, z: 1 }) });
    const direction = manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });

    expect(goal).toEqual({ events: [], serverTime: START.toISOString() });
    expect(direction).toEqual({ events: [], serverTime: START.toISOString() });
    expect(positionOf(manager)).toEqual(before);
  });
});

describe('interaction', () => {
  it('keeps the interactable-by-kind rule (tree true, character false)', () => {
    expect(INTERACTABLE_BY_ENTITY_KIND).toEqual({ character: false, tree: true });
  });

  it('exposes a 1.5-unit interaction range', () => {
    expect(INTERACTION_RANGE).toBe(1.5);
  });

  it.each([
    { label: 'east', map: ['ggg', 'ggT', 'ggg'], yaw: Math.PI / 2 },
    { label: 'west', map: ['ggg', 'Tgg', 'ggg'], yaw: -Math.PI / 2 },
    { label: 'north (-Z)', map: ['gTg', 'ggg', 'ggg'], yaw: Math.PI },
    { label: 'south (+Z)', map: ['ggg', 'ggg', 'gTg'], yaw: 0 },
  ])(
    'accepted on a tree in range: stops movement and faces $label',
    ({ map, yaw }) => {
      const clock = fakeClock(START);
      const manager = createWorldManager({ map, clock: clock.now });
      // Arm a held movement mode so the stop is observable.
      manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: 1 }) });
      const stopped = positionOf(manager);

      const result = manager.submitIntent({
        actorId: ACTOR_ID,
        command: interact(parseEntityId('tree-1')),
      });

      expect(result.serverTime).toBe(START.toISOString());
      expect(result.events).toHaveLength(1);
      const [event] = result.events;
      expect(event.type).toBe('transform.changed');
      if (event.type === 'transform.changed') {
        expect(event.entityId).toBe(ENTITY_ID);
        // Position unchanged: interaction only turns and stops.
        expect(event.transform.position).toEqual(stopped);
        expect(yawFromQuat(event.transform.rotation)).toBeCloseTo(yaw, 10);
      }
      // Stopped: the pending movement mode was cleared.
      expect(manager.step(50)).toEqual({ events: [], serverTime: START.toISOString() });
    },
  );

  it('rejects an out-of-range tree with reason out-of-range', () => {
    const manager = createWorldManager({
      map: ['ggggg', 'ggggg', 'ggggT', 'ggggg', 'ggggg'],
    });

    let caught: unknown;
    try {
      manager.submitIntent({ actorId: ACTOR_ID, command: interact(parseEntityId('tree-1')) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InteractionRejectedError);
    const error = caught as InteractionRejectedError;
    expect(error.name).toBe('InteractionRejectedError');
    expect(error.reason).toBe('out-of-range');
    expect(error.entityId).toBe(parseEntityId('tree-1'));
  });

  it("rejects the actor's own character entity with reason not-interactable", () => {
    const manager = createWorldManager();

    let caught: unknown;
    try {
      manager.submitIntent({ actorId: ACTOR_ID, command: interact(ENTITY_ID) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InteractionRejectedError);
    const error = caught as InteractionRejectedError;
    expect(error.reason).toBe('not-interactable');
    expect(error.entityId).toBe(ENTITY_ID);
  });

  it('throws UnknownEntityError carrying the id for an unknown target', () => {
    const manager = createWorldManager();
    const ghost = parseEntityId('ghost');

    let caught: unknown;
    try {
      manager.submitIntent({ actorId: ACTOR_ID, command: interact(ghost) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownEntityError);
    const error = caught as UnknownEntityError;
    expect(error.name).toBe('UnknownEntityError');
    expect(error.entityId).toBe(ghost);
  });

  it('measures INTERACTION_RANGE in XZ, ignoring height', () => {
    // A target directly overhead is still within reach: `y` does not count.
    const inRangeXZButHighY = distanceXZ({ x: 0, y: 0, z: 0 }, { x: 1, y: 999, z: 0 });
    expect(inRangeXZButHighY).toBeCloseTo(1, 10);
    expect(inRangeXZButHighY).toBeLessThanOrEqual(INTERACTION_RANGE);
    // Out of range in XZ stays out of range regardless of height.
    expect(distanceXZ({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 })).toBeCloseTo(2, 10);
  });

  it('rejects an unknown actor before resolving the target', () => {
    const manager = createWorldManager();
    expect(() =>
      manager.submitIntent({
        actorId: parseActorId('ghost'),
        command: interact(ENTITY_ID),
      }),
    ).toThrow(UnknownActorError);
  });
});
