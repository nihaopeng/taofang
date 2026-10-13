import { describe, expect, it } from 'vitest';

import {
  isColliderState,
  isSurfaceState,
  isWorldSnapshot,
  parseActorId,
  parseColliderId,
  parseSurfaceId,
} from '@starvalley/protocol';
import type { ColliderState, GameCommand, SurfaceState } from '@starvalley/protocol';

import {
  BLOCKED_COLLIDER_HEIGHT,
  DEFAULT_ACTOR_HEIGHT,
  DEFAULT_ACTOR_RADIUS,
  DEFAULT_ACTOR_SPEED,
  DEFAULT_WORLD_MAP,
  DEMO_PLATFORM_HEIGHT,
  DEMO_RAMP_ANGLE_DEGREES,
  GRAVITY,
  LANDING_SNAP_TOLERANCE,
  MAX_STEP_DOWN,
  MAX_STEP_UP,
  MAX_WALKABLE_SLOPE_DEGREES,
  TREE_TRUNK_HEIGHT,
  WALKABILITY_BY_TERRAIN,
  WATER_COLLIDER_HEIGHT,
  actorBodyOverlapsCollider,
  cellCentre,
  createWorldManager,
  findSupportY,
  isSurfaceTraversable,
  resolveColliderPenetration,
  surfacePlaneY,
} from '../src/index.ts';

const ACTOR_ID = parseActorId('actor-1');

const ALL_GRASS_3 = ['ggg', 'ggg', 'ggg'] as const;
const ALL_GRASS_5 = ['ggggg', 'ggggg', 'ggggg', 'ggggg', 'ggggg'] as const;
const ALL_GRASS_7 = [
  'ggggggg',
  'ggggggg',
  'ggggggg',
  'ggggggg',
  'ggggggg',
  'ggggggg',
  'ggggggg',
] as const;

type Manager = ReturnType<typeof createWorldManager>;
type Position = { x: number; y: number; z: number };

function snapshotOf(manager: Manager) {
  return manager.getSnapshot({ actorId: ACTOR_ID });
}

function positionOf(manager: Manager): Position {
  return snapshotOf(manager).entities[0].transform.position;
}

function move(movement: { x: number; z: number }): GameCommand {
  return { type: 'actor.moveIntent', movement };
}

function moveTo(target: { x: number; z: number }): GameCommand {
  return { type: 'actor.moveTo', target: { x: target.x, y: 0, z: target.z } };
}

/** Drive `steps` fixed 50 ms ticks, returning the actor position after each. */
function stepN(manager: Manager, steps: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < steps; i += 1) {
    manager.step(50);
    out.push({ ...positionOf(manager) });
  }
  return out;
}

/** Author a flat, up-facing patch (axisU = +X, axisV = -Z: `cross.y > 0`). */
function flatSurface(input: {
  surfaceId: string;
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  y: number;
  walkable?: boolean;
  kind?: SurfaceState['kind'];
}): SurfaceState {
  return {
    surfaceId: parseSurfaceId(input.surfaceId),
    kind: input.kind ?? 'platform',
    center: { x: input.centerX, y: input.y, z: input.centerZ },
    axisU: { x: input.halfX, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: -input.halfZ },
    walkable: input.walkable ?? true,
  };
}

/** Author an arbitrary planar patch from explicit half-edge vectors. */
function planeSurface(input: {
  surfaceId: string;
  center: { x: number; y: number; z: number };
  axisU: { x: number; y: number; z: number };
  axisV: { x: number; y: number; z: number };
  kind?: SurfaceState['kind'];
  walkable?: boolean;
}): SurfaceState {
  return {
    surfaceId: parseSurfaceId(input.surfaceId),
    kind: input.kind ?? 'platform',
    center: input.center,
    axisU: input.axisU,
    axisV: input.axisV,
    walkable: input.walkable ?? true,
  };
}

/** Measure a surface's inclination from horizontal, in degrees (0 = flat). */
function surfaceAngleDegrees(surface: SurfaceState): number {
  const { axisU, axisV } = surface;
  const nx = axisU.y * axisV.z - axisU.z * axisV.y;
  const ny = axisU.z * axisV.x - axisU.x * axisV.z;
  const nz = axisU.x * axisV.y - axisU.y * axisV.x;
  const length = Math.hypot(nx, ny, nz);
  return (Math.acos(ny / length) * 180) / Math.PI;
}

/** Author an AABB collider. */
function box(input: {
  colliderId: string;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  kind?: ColliderState['kind'];
}): ColliderState {
  return {
    colliderId: parseColliderId(input.colliderId),
    kind: input.kind ?? 'wall',
    shape: { kind: 'aabb', min: input.min, max: input.max },
  };
}

/**
 * Walk the default actor from spawn up the authored demo ramp.
 *
 * Returns the positions sampled while holding north. The first entry is the
 * actor's position at the ramp base (before the north intent), followed by one
 * entry per north tick, so callers can measure per-step continuity from the
 * base. The caller bounds the step count.
 */
function climbDefaultDemo(manager: Manager, northSteps: number): Position[] {
  // East along the spawn row (clear of the trees).
  manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 3.5, z: 0.5 }) });
  stepN(manager, 40);
  // North to the ramp base at (3.5, -2).
  manager.submitIntent({ actorId: ACTOR_ID, command: moveTo({ x: 3.5, z: -2 }) });
  stepN(manager, 40);
  const atBase = { ...positionOf(manager) };
  // Hold north: climb the ramp onto the platform.
  manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
  return [atBase, ...stepN(manager, northSteps)];
}

describe('phase 14 authored world geometry', () => {
  it('emits one walkable ground surface per walkable cell and real-y colliders per unwalkable cell', () => {
    const snapshot = snapshotOf(createWorldManager());

    const groundSurfaces = snapshot.surfaces.filter((surface) => surface.kind === 'ground');
    const collidersById = new Map(
      snapshot.colliders.map((collider) => [String(collider.colliderId), collider]),
    );

    let walkableCells = 0;
    const terrainByChar = {
      g: 'grass',
      p: 'path',
      w: 'water',
      '#': 'blocked',
      T: 'grass',
    } as const;
    for (let z = 0; z < snapshot.grid.depth; z += 1) {
      for (let x = 0; x < snapshot.grid.width; x += 1) {
        const terrain = terrainByChar[DEFAULT_WORLD_MAP[z][x] as keyof typeof terrainByChar];
        const cell = cellCentre(snapshot.grid, { x, z });
        if (WALKABILITY_BY_TERRAIN[terrain]) {
          walkableCells += 1;
          const surface = groundSurfaces.find((s) => s.surfaceId === `surface-ground-${x}-${z}`);
          expect(surface).toBeDefined();
          expect(surface?.walkable).toBe(true);
          expect(surface?.center).toEqual(cell);
          continue;
        }
        const collider = collidersById.get(`collider-${terrain}-${x}-${z}`);
        expect(collider).toBeDefined();
        if (collider?.shape.kind === 'aabb') {
          expect(collider.shape.min.y).toBe(0);
          expect(collider.shape.max.y).toBeGreaterThan(collider.shape.min.y);
          expect(collider.shape.max.y).toBeLessThan(snapshot.bounds.max.y);
        }
      }
    }

    expect(groundSurfaces).toHaveLength(walkableCells);
    // 100 cells: 4 water + 2 blocked are unwalkable -> 94 ground surfaces, plus
    // the authored platform + ramp.
    expect(groundSurfaces).toHaveLength(94);
    expect(snapshot.surfaces).toHaveLength(96);
    expect(snapshot.colliders).toHaveLength(8);
  });

  it('gives water, blocked cells and trees finite real y ranges (never ground-to-sky)', () => {
    const snapshot = snapshotOf(createWorldManager());
    const byId = new Map(
      snapshot.colliders.map((collider) => [String(collider.colliderId), collider]),
    );

    const water = byId.get('collider-water-3-3');
    const blocked = byId.get('collider-blocked-2-8');
    const tree = byId.get('collider-tree-1');

    for (const collider of [water, blocked, tree]) {
      expect(collider).toBeDefined();
      expect(isColliderState(collider)).toBe(true);
      if (collider?.shape.kind === 'aabb') {
        expect(collider.shape.min.y).toBe(0);
        expect(collider.shape.max.y).toBeLessThan(snapshot.bounds.max.y);
      }
    }
    if (water?.shape.kind === 'aabb') {
      expect(water.shape.max.y).toBe(WATER_COLLIDER_HEIGHT);
      expect(water.kind).toBe('water');
    }
    if (blocked?.shape.kind === 'aabb') {
      expect(blocked.shape.max.y).toBe(BLOCKED_COLLIDER_HEIGHT);
    }
    if (tree?.shape.kind === 'aabb') {
      expect(tree.shape.max.y).toBe(TREE_TRUNK_HEIGHT);
      // Trunk footprint is narrower than a cell, not the whole prop column.
      expect(tree.shape.max.x - tree.shape.min.x).toBeCloseTo(0.8, 10);
    }
  });

  it('authors the demo platform + a comfortably walkable ramp, clear of spawn, water and trees', () => {
    const snapshot = snapshotOf(createWorldManager());
    const platform = snapshot.surfaces.find((s) => s.surfaceId === 'surface-platform');
    const ramp = snapshot.surfaces.find((s) => s.surfaceId === 'surface-ramp');

    const rampRun =
      DEMO_PLATFORM_HEIGHT / Math.tan((DEMO_RAMP_ANGLE_DEGREES * Math.PI) / 180);
    const platformSouthZ = -4;
    const rampSouthZ = platformSouthZ + rampRun;

    expect(platform).toEqual({
      surfaceId: 'surface-platform',
      kind: 'platform',
      center: { x: 3.5, y: DEMO_PLATFORM_HEIGHT, z: -4.5 },
      axisU: { x: 1.5, y: 0, z: 0 },
      axisV: { x: 0, y: 0, z: -0.5 },
      walkable: true,
    });
    expect(ramp).toEqual({
      surfaceId: 'surface-ramp',
      kind: 'ramp',
      center: { x: 3.5, y: DEMO_PLATFORM_HEIGHT / 2, z: platformSouthZ + rampRun / 2 },
      axisU: { x: 1.5, y: 0, z: 0 },
      axisV: { x: 0, y: DEMO_PLATFORM_HEIGHT / 2, z: -rampRun / 2 },
      walkable: true,
    });

    // The demo ramp is measurably well inside the traversal limit: the rule is
    // 45 degrees and this ramp is 30, so the margin is a full 15 degrees rather
    // than the epsilon-sized margin the old 45-degree demo sat on.
    const rampAngle = surfaceAngleDegrees(ramp!);
    expect(rampAngle).toBeCloseTo(DEMO_RAMP_ANGLE_DEGREES, 9);
    expect(MAX_WALKABLE_SLOPE_DEGREES - rampAngle).toBeGreaterThanOrEqual(10);
    expect(isSurfaceTraversable(ramp!)).toBe(true);
    // Not merely inside the limit by a floating-point epsilon: 30 < 45 hard.
    expect(DEMO_RAMP_ANGLE_DEGREES).toBeLessThan(MAX_WALKABLE_SLOPE_DEGREES);

    // The ramp meets the platform top at its north end and the ground at its
    // south end, so the actor's `y` can be continuous across the join with no
    // lip/step at the junction. (The exact patch boundary is probed just
    // inside it, and the parametric endpoints are checked directly, because
    // `surfacePlaneY` uses an inclusive `v ∈ [-1, 1]` test that floating point
    // can put a hair outside at an irrational boundary.)
    expect(surfacePlaneY(platform!, 3.5, -4.5)).toBe(DEMO_PLATFORM_HEIGHT);
    expect(ramp!.center.y + ramp!.axisV.y).toBeCloseTo(DEMO_PLATFORM_HEIGHT, 12);
    expect(ramp!.center.y - ramp!.axisV.y).toBeCloseTo(0, 12);
    // Probing just inside each end puts the plane within a tiny fraction of a
    // step of the endpoint — no lip at the junction and no floating lip at the
    // base.
    const nearTopY = surfacePlaneY(ramp!, 3.5, platformSouthZ + 1e-3)!;
    expect(nearTopY).toBeLessThanOrEqual(DEMO_PLATFORM_HEIGHT);
    expect(DEMO_PLATFORM_HEIGHT - nearTopY).toBeLessThan(1e-3);
    const nearBaseY = surfacePlaneY(ramp!, 3.5, rampSouthZ - 1e-3)!;
    expect(nearBaseY).toBeGreaterThanOrEqual(0);
    expect(nearBaseY).toBeLessThan(1e-3);

    // The demo does not overlap the spawn cell, the water cells or the trees.
    expect(surfacePlaneY(platform!, 0.5, 0.5)).toBeNull();
    expect(surfacePlaneY(ramp!, 0.5, 0.5)).toBeNull();
    expect(surfacePlaneY(platform!, -1.5, -1.5)).toBeNull();
    expect(surfacePlaneY(ramp!, 1.5, -0.5)).toBeNull();
    expect(surfacePlaneY(ramp!, -0.5, 2.5)).toBeNull();
  });

  it('emits surfaces/colliders sorted by id and Protocol-valid', () => {
    const snapshot = snapshotOf(createWorldManager());
    const surfaceIds = snapshot.surfaces.map((surface) => surface.surfaceId);
    const colliderIds = snapshot.colliders.map((collider) => collider.colliderId);

    expect(surfaceIds).toEqual([...surfaceIds].sort());
    expect(colliderIds).toEqual([...colliderIds].sort());
    expect(snapshot.surfaces.every(isSurfaceState)).toBe(true);
    expect(snapshot.colliders.every(isColliderState)).toBe(true);
    expect(isWorldSnapshot(snapshot)).toBe(true);
  });

  it('appends and validates Manager-owned surface/collider authoring deps', () => {
    const surface = flatSurface({
      surfaceId: 'surface-extra',
      centerX: 0.25,
      centerZ: 0.25,
      halfX: 0.2,
      halfZ: 0.2,
      y: 0.1,
    });
    const collider = box({
      colliderId: 'collider-extra',
      min: { x: -5, y: 0, z: -5 },
      max: { x: -4.9, y: 1, z: -4.9 },
    });
    const manager = createWorldManager({ surfaces: [surface], colliders: [collider] });
    const snapshot = snapshotOf(manager);

    expect(snapshot.surfaces.some((s) => s.surfaceId === 'surface-extra')).toBe(true);
    expect(snapshot.colliders.some((c) => c.colliderId === 'collider-extra')).toBe(true);
    expect(isWorldSnapshot(snapshot)).toBe(true);

    // Guard failures are construction errors, never silent authority.
    const badCollider = {
      colliderId: 'collider-bad',
      kind: 'wall',
      shape: { kind: 'aabb', min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 1, z: 1 } },
    } as unknown as ColliderState;
    expect(() => createWorldManager({ colliders: [badCollider] })).toThrow(RangeError);
    const badSurface = {
      ...surface,
      axisV: { x: 0, y: 0, z: surface.axisV.z < 0 ? 1 : -1 },
    } as unknown as SurfaceState;
    expect(() => createWorldManager({ surfaces: [badSurface] })).toThrow(RangeError);
  });

  it('keeps authority private: mutating a snapshot surface/collider does not corrupt later reads', () => {
    const manager = createWorldManager();
    const snapshot = snapshotOf(manager);
    const platform = snapshot.surfaces.find((s) => s.surfaceId === 'surface-platform');
    platform!.center.y = 999;
    platform!.walkable = false;
    snapshot.colliders[0].shape.min.y = 999;
    snapshot.surfaces.length = 0;

    const fresh = snapshotOf(manager);
    expect(fresh.surfaces.find((s) => s.surfaceId === 'surface-platform')?.center.y).toBe(
      DEMO_PLATFORM_HEIGHT,
    );
    expect(fresh.surfaces.find((s) => s.surfaceId === 'surface-platform')?.walkable).toBe(true);
    expect(fresh.colliders[0].shape.min.y).toBe(0);
  });

  it('omits the demo area on a map too small to hold it (custom maps stay untouched)', () => {
    const snapshot = snapshotOf(createWorldManager({ map: ALL_GRASS_3 }));
    expect(snapshot.surfaces.some((s) => s.surfaceId === 'surface-platform')).toBe(false);
    expect(snapshot.surfaces.some((s) => s.surfaceId === 'surface-ramp')).toBe(false);
  });
});

describe('phase 14 physics constants (Manager-owned, not on the wire)', () => {
  it('exposes named traversal/physics constants with defensible values', () => {
    expect(DEFAULT_ACTOR_RADIUS).toBe(0.35);
    expect(DEFAULT_ACTOR_HEIGHT).toBe(1.7);
    expect(MAX_STEP_UP).toBe(0.3);
    expect(MAX_STEP_DOWN).toBe(0.3);
    expect(MAX_WALKABLE_SLOPE_DEGREES).toBe(45);
    expect(GRAVITY).toBe(20);
    expect(LANDING_SNAP_TOLERANCE).toBe(0.05);
    expect(DEFAULT_ACTOR_SPEED).toBe(3);
  });
});

describe('phase 14 support query (pure, surfaces-only)', () => {
  it('is grid-independent: a surface at an arbitrary off-grid position supports the actor', () => {
    const offGrid = flatSurface({
      surfaceId: 'surface-off-grid',
      centerX: 0.73,
      centerZ: 0.17,
      halfX: 0.21,
      halfZ: 0.23,
      y: 0.25,
    });
    // No cell centre coincides with the patch and the patch crosses no cell axis
    // in a grid-aligned way — it is pure world-space geometry.
    expect(findSupportY([offGrid], 0.73, 0.17, 0)).toBe(0.25);
    expect(findSupportY([offGrid], 0.9, 0.17, 0)).toBe(0.25);
    // Outside the patch: no support.
    expect(findSupportY([offGrid], 1.2, 0.17, 0)).toBeNull();
  });

  it('never uses a walkable:false up-facing surface as support', () => {
    const forbidden = flatSurface({
      surfaceId: 'surface-forbidden',
      centerX: 0,
      centerZ: 0,
      halfX: 1,
      halfZ: 1,
      y: 0.25,
      walkable: false,
    });
    // Up-facing (the Protocol guard accepts it) but explicitly non-traversable.
    expect(isSurfaceState(forbidden)).toBe(true);
    expect(isSurfaceTraversable(forbidden)).toBe(false);
    expect(findSupportY([forbidden], 0, 0, 0)).toBeNull();
  });

  it('returns the highest reachable surface when several overlap the same (x, z)', () => {
    const lower = flatSurface({
      surfaceId: 'surface-lower',
      centerX: 0,
      centerZ: 0,
      halfX: 1,
      halfZ: 1,
      y: 0,
    });
    const upper = flatSurface({
      surfaceId: 'surface-upper',
      centerX: 0,
      centerZ: 0,
      halfX: 1,
      halfZ: 1,
      y: 2,
    });
    const surfaces = [upper, lower];

    expect(findSupportY(surfaces, 0, 0, 0)).toBe(0);
    expect(findSupportY(surfaces, 0, 0, 2)).toBe(2);
    // A surface more than MAX_STEP_UP above the feet is unreachable.
    expect(findSupportY([upper], 0, 0, 1)).toBeNull();
  });
});

describe('phase 14 movement engine', () => {
  it('criterion 1: flat ground still stands and preserves the existing behaviour', () => {
    const manager = createWorldManager();
    // Spawn and stand still: no event, y stays on the ground.
    expect(positionOf(manager)).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(manager.step(50).events).toEqual([]);
    expect(positionOf(manager).y).toBe(0);
    for (const position of stepN(manager, 5)) {
      expect(position.y).toBe(0);
    }

    // Horizontal movement keeps y exactly on the flat ground.
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    for (const position of stepN(manager, 5)) {
      expect(position.y).toBe(0);
    }
    expect(positionOf(manager)).toEqual({ x: 1.25, y: 0, z: 0.5 });
  });

  it('criterion 1: a water collider blocks a ground actor at its real y range', () => {
    const manager = createWorldManager({ map: ['gwg', 'ggg', 'ggg'] });
    const snapshot = snapshotOf(manager);
    const spawn = positionOf(manager);
    expect(snapshot.colliders.some((c) => c.kind === 'water')).toBe(true);

    // Water is directly north (-Z) of the spawn cell. A held north intent must
    // stop outside the water footprint and keep the actor on the ground.
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    stepN(manager, 30);

    const water = snapshot.colliders.find((c) => c.kind === 'water');
    expect(water?.shape.kind).toBe('aabb');
    if (water?.shape.kind === 'aabb') {
      expect(positionOf(manager).z).toBeGreaterThan(water.shape.max.z);
      expect(positionOf(manager).z).toBeLessThan(spawn.z);
    }
    expect(positionOf(manager).y).toBe(0);
  });

  it('criterion 2: the actor climbs the ramp with continuous, monotonic y and ends on the platform', () => {
    const manager = createWorldManager();
    // Clear of the demo, the ground under the platform is a separate surface.
    const surfaces = snapshotOf(manager).surfaces;
    const ramp = surfaces.find((surface) => surface.surfaceId === 'surface-ramp')!;
    expect(findSupportY(surfaces, 3.5, -4.5, 0)).toBe(0);
    expect(findSupportY(surfaces, 3.5, -4.5, 2)).toBe(2);

    const samples = climbDefaultDemo(manager, 14);

    // Stop on the platform (the 14th tick is z = -4.1 for the default layout).
    const final = positionOf(manager);
    expect(final.y).toBeCloseTo(DEMO_PLATFORM_HEIGHT, 10);
    expect(final.z).toBeLessThanOrEqual(-4);
    // The actor reaches the platform top EXACTLY (no lip/overshoot).
    expect(final.y).toBe(DEMO_PLATFORM_HEIGHT);

    // Monotonic non-decreasing while climbing, with no discontinuity larger than
    // one tick of ramp rise. The 30-degree ramp rises only `tan(30) * dx` per
    // tick, comfortably under the horizontal step and MAX_STEP_UP.
    const rampRisePerTick =
      ((DEFAULT_ACTOR_SPEED * 50) / 1000) *
      Math.tan((DEMO_RAMP_ANGLE_DEGREES * Math.PI) / 180);
    let previousY = samples[0].y;
    let maxDelta = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const delta = samples[i].y - previousY;
      expect(delta).toBeGreaterThanOrEqual(-1e-9);
      maxDelta = Math.max(maxDelta, Math.abs(delta));
      previousY = samples[i].y;
    }
    expect(maxDelta).toBeGreaterThan(0);
    expect(maxDelta).toBeLessThanOrEqual(rampRisePerTick + 1e-9);
    // The junction is continuous: the ramp plane at the platform edge equals the
    // platform top, and no tick jumps more than the allowed step.
    const nearTopY = surfacePlaneY(ramp, 3.5, -4 + 1e-3)!;
    expect(DEMO_PLATFORM_HEIGHT - nearTopY).toBeLessThan(1e-3);
    expect(ramp.center.y + ramp.axisV.y).toBeCloseTo(DEMO_PLATFORM_HEIGHT, 12);
    expect(maxDelta).toBeLessThanOrEqual(MAX_STEP_UP + 1e-9);

    // The whole climb is continuous (no teleport): every intermediate `y` lies
    // on the ramp plane, and the climb ends exactly on the platform.
    expect(previousY).toBe(DEMO_PLATFORM_HEIGHT);
    for (const sample of samples) {
      // On the ramp (not yet on the platform) `y` lies exactly on its plane.
      if (sample.z > -4 + 1e-9) {
        expect(sample.y).toBeCloseTo(surfacePlaneY(ramp, sample.x, sample.z)!, 9);
      } else {
        expect(sample.y).toBeCloseTo(DEMO_PLATFORM_HEIGHT, 10);
      }
    }
  });

  it('criterion 3: a step within MAX_STEP_UP is climbable and a taller step is not', () => {
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        flatSurface({
          surfaceId: 'surface-step-low',
          centerX: 1,
          centerZ: 0,
          halfX: 0.5,
          halfZ: 0.5,
          y: MAX_STEP_UP - 0.05,
        }),
        flatSurface({
          surfaceId: 'surface-step-high',
          centerX: 2.5,
          centerZ: 0,
          halfX: 0.5,
          halfZ: 0.5,
          y: MAX_STEP_UP * 2,
        }),
      ],
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    const samples = stepN(manager, 30);

    // The low step is climbed...
    const maxY = Math.max(...samples.map((sample) => sample.y));
    expect(maxY).toBeCloseTo(MAX_STEP_UP - 0.05, 10);
    // ...but the taller step is above MAX_STEP_UP from the ground and from the
    // low step, so the actor never reaches it.
    expect(maxY).toBeLessThan(MAX_STEP_UP * 2);
    expect(samples.every((sample) => sample.y < MAX_STEP_UP * 2 - 1e-9)).toBe(true);
  });

  it('criterion 4: a ground actor is blocked by a low wall', () => {
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      colliders: [
        box({
          colliderId: 'collider-low-wall',
          min: { x: 0.5, y: 0, z: -0.5 },
          max: { x: 1.5, y: 0.5, z: 0.5 },
        }),
      ],
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepN(manager, 30);

    expect(positionOf(manager).x).toBeCloseTo(0.5 - DEFAULT_ACTOR_RADIUS, 10);
    expect(positionOf(manager).y).toBe(0);
    expect(positionOf(manager).x).toBeLessThan(0.5);
  });

  it('criterion 4: an actor on a deck above the low wall is NOT blocked', () => {
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        // A ramp rising from (x=0.5, z=0) to the platform, then a deck over the wall.
        planeSurface({
          surfaceId: 'surface-deck-ramp',
          center: { x: 0.5, y: 1, z: -1 },
          axisU: { x: 1, y: 0, z: 0 },
          axisV: { x: 0, y: 1, z: -1 },
          kind: 'ramp',
        }),
        flatSurface({
          surfaceId: 'surface-deck',
          centerX: 0.5,
          centerZ: -2.5,
          halfX: 1,
          halfZ: 0.5,
          y: 2,
        }),
      ],
      colliders: [
        box({
          colliderId: 'collider-low-wall',
          min: { x: 0, y: 0, z: -2.8 },
          max: { x: 1, y: 0.5, z: -2.2 },
        }),
      ],
    });

    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    stepN(manager, 15);
    // On the deck, directly over the wall's XZ footprint.
    expect(positionOf(manager).y).toBeCloseTo(2, 10);
    expect(positionOf(manager).z).toBeLessThanOrEqual(-2.2);
    expect(positionOf(manager).z).toBeGreaterThanOrEqual(-2.8);

    const before = positionOf(manager);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepN(manager, 3);
    const after = positionOf(manager);

    // The deck actor's body [2, 3.7] does not overlap the wall [0, 0.5], so the
    // wall is not there to block it.
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeCloseTo(2, 10);
    expect(actorBodyOverlapsCollider(2, snapshotOf(manager).colliders[0])).toBe(false);
  });

  it('criterion 4: an actor whose head is below a deck slab passes UNDER it', () => {
    const slab = box({
      colliderId: 'collider-deck-slab',
      min: { x: 0.5, y: 1.8, z: -0.5 },
      max: { x: 1.5, y: 2, z: 0.5 },
      kind: 'structure',
    });
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        flatSurface({
          surfaceId: 'surface-deck-top',
          centerX: 1,
          centerZ: 0,
          halfX: 0.5,
          halfZ: 0.5,
          y: 2,
        }),
      ],
      colliders: [slab],
    });

    // The body top (1.7) is below the slab bottom (1.8): no vertical overlap.
    expect(actorBodyOverlapsCollider(0, slab)).toBe(false);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    stepN(manager, 15);

    // The actor walked clean under the slab: past its far edge, still on y = 0.
    expect(positionOf(manager).x).toBeGreaterThan(1.5);
    expect(positionOf(manager).y).toBe(0);
  });

  it('criterion 5: walking off the platform edge makes the actor fall and land on the lower surface', () => {
    const manager = createWorldManager();
    // Climb the demo ramp and stop on the platform.
    climbDefaultDemo(manager, 14);
    expect(positionOf(manager).y).toBeCloseTo(DEMO_PLATFORM_HEIGHT, 10);

    // Walk west off the platform edge (x < 2). The ground under it is a lower
    // support, so the actor must FALL rather than teleport down.
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: -1, z: 0 }) });
    const samples = stepN(manager, 30);

    let previousY = DEMO_PLATFORM_HEIGHT;
    let sawAirborne = false;
    for (const sample of samples) {
      expect(Number.isFinite(sample.y)).toBe(true);
      expect(sample.y).toBeGreaterThanOrEqual(0);
      // Never rises while walking off an edge.
      expect(sample.y).toBeLessThanOrEqual(previousY + 1e-9);
      if (sample.y < DEMO_PLATFORM_HEIGHT - 1e-9 && sample.y > 0) {
        sawAirborne = true;
      }
      previousY = sample.y;
    }
    expect(sawAirborne).toBe(true);
    // Landed and stayed landed: the last two samples are exactly on the ground.
    expect(samples[samples.length - 1].y).toBe(0);
    expect(samples[samples.length - 2].y).toBe(0);
  });

  it('criterion 5: with no surface at all the actor falls to the world floor and never hovers', () => {
    // The grid's ground covers x in [-2.5, 2.5]; the world floor is one unit
    // lower and the box extends to x = 3.5, so an actor walking east leaves all
    // support behind.
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      bounds: { min: { x: -3.5, y: -1, z: -3.5 }, max: { x: 3.5, y: 8, z: 3.5 } },
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    const samples = stepN(manager, 50);

    expect(samples.every((sample) => Number.isFinite(sample.y))).toBe(true);
    expect(positionOf(manager).y).toBe(-1);
    // Once landed it stays exactly on the floor.
    expect(samples[samples.length - 1].y).toBe(-1);
    expect(samples[samples.length - 2].y).toBe(-1);
  });

  it('criterion 6: a walkable surface at an arbitrary world position supports the actor', () => {
    // Patch centre (0.73, 0.17) matches no cell centre (0, 0), (1, 0), ... and
    // the patch does not line up with the grid at all — it is pure world geometry.
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        flatSurface({
          surfaceId: 'surface-off-grid',
          centerX: 0.73,
          centerZ: 0.17,
          halfX: 0.21,
          halfZ: 0.23,
          y: 0.25,
        }),
      ],
    });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    const samples = stepN(manager, 10);

    // The actor steps up onto the off-grid patch...
    expect(Math.max(...samples.map((sample) => sample.y))).toBeCloseTo(0.25, 10);
    // ...and leaves it again back to the flat ground.
    expect(positionOf(manager).y).toBe(0);
  });

  it('criterion 7: a walkable:false up-facing surface is never used as support', () => {
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        flatSurface({
          surfaceId: 'surface-non-walkable',
          centerX: 0.73,
          centerZ: 0.17,
          halfX: 0.21,
          halfZ: 0.23,
          y: 0.25,
          walkable: false,
        }),
      ],
    });
    // If it were walkable at 0.25 the actor would step onto it; it is not.
    expect(findSupportY(snapshotOf(manager).surfaces, 0.73, 0.17, 0)).toBe(0);
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 1, z: 0 }) });
    const samples = stepN(manager, 10);

    expect(samples.every((sample) => sample.y === 0)).toBe(true);
  });

  it('criterion 7b (negative): a walkable surface steeper than the slope limit is not traversable', () => {
    // A 60-degree ramp — steeper than MAX_WALKABLE_SLOPE_DEGREES (45). It is
    // marked `walkable: true`, so ONLY the slope rule can reject it. This is the
    // case that proves the traversal rule actually bites, as opposed to a
    // `walkable: false` surface (criterion 7).
    const rise = 1.2;
    const run = rise / Math.tan((60 * Math.PI) / 180);
    const tooSteep = planeSurface({
      surfaceId: 'surface-too-steep',
      // Low (v = -1) end meets the ground at z = -0.2; it rises northward.
      center: { x: 0, y: rise / 2, z: -0.2 - run / 2 },
      axisU: { x: 0.5, y: 0, z: 0 },
      axisV: { x: 0, y: rise / 2, z: -run / 2 },
      kind: 'ramp',
      walkable: true,
    });

    // Protocol-valid and explicitly walkable, yet rejected by the slope limit.
    expect(isSurfaceState(tooSteep)).toBe(true);
    expect(tooSteep.walkable).toBe(true);
    expect(isSurfaceTraversable(tooSteep)).toBe(false);
    expect(surfaceAngleDegrees(tooSteep)).toBeGreaterThan(MAX_WALKABLE_SLOPE_DEGREES);

    // Just north of the low end the plane is only 0.15 high, well within
    // MAX_STEP_UP — so the slope rule, not the step rule, is what rejects it.
    const nearBaseZ = -0.2 - run / 8;
    const planeY = surfacePlaneY(tooSteep, 0, nearBaseZ)!;
    expect(planeY).toBeGreaterThan(0);
    expect(planeY).toBeLessThanOrEqual(MAX_STEP_UP);
    expect(findSupportY([tooSteep], 0, nearBaseZ, 0)).toBeNull();

    // The actor walks straight north across the too-steep patch and is never
    // lifted: it stays on the flat ground underneath the whole way.
    const manager = createWorldManager({ map: ALL_GRASS_5, surfaces: [tooSteep] });
    manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
    const samples = stepN(manager, 25);
    expect(samples.every((sample) => sample.y === 0)).toBe(true);
  });

  it('criterion 8: stacked surfaces support the actor at each level', () => {
    const manager = createWorldManager({
      map: ALL_GRASS_5,
      surfaces: [
        flatSurface({
          surfaceId: 'surface-stack-lower',
          centerX: 0,
          centerZ: 0,
          halfX: 1,
          halfZ: 1,
          y: 0,
        }),
        flatSurface({
          surfaceId: 'surface-stack-upper',
          centerX: 0,
          centerZ: 0,
          halfX: 1,
          halfZ: 1,
          y: 2,
        }),
      ],
    });
    const surfaces = snapshotOf(manager).surfaces;

    // Same (x, z), two heights: the actor's feet choose the level.
    expect(findSupportY(surfaces, 0, 0, 0)).toBe(0);
    expect(findSupportY(surfaces, 0, 0, 2)).toBe(2);
    expect(positionOf(manager).y).toBe(0);
  });

  it('keeps step(0) a strict no-op and determinism across identical inputs', () => {
    const a = createWorldManager();
    const b = createWorldManager();
    a.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0.25, z: -0.5 }) });
    b.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0.25, z: -0.5 }) });

    expect(a.step(0).events).toEqual([]);
    for (const manager of [a, b]) {
      manager.step(33);
      manager.step(17);
    }
    expect(positionOf(a)).toEqual(positionOf(b));

    // A falling actor is deterministic too.
    const c = createWorldManager();
    const d = createWorldManager();
    for (const manager of [c, d]) {
      climbDefaultDemo(manager, 14);
      manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: -1, z: 0 }) });
      stepN(manager, 12);
    }
    expect(positionOf(c)).toEqual(positionOf(d));
  });
});

describe('phase 14c: landing depenetration and the rectangle seam guard', () => {
  // A bridge deck over a wide, shallow water volume, reached by a walkable
  // (~26.6 degree) approach ramp — the phase-14 scene. The water is WIDE in `x`
  // so that walking off the deck's narrow SIDE (`x` in `[-0.5, 0.5]`) lands the
  // actor near the water's `(x, z)` centre; the NEAREST escape face is then the
  // `-Z` face, which (for `minZ = -4`) is exactly one of the faces whose
  // floating-point push rounds a few ULPs INWARD. A narrow collider would let
  // the actor slide clear during the fall instead, hiding the bug. The drop puts
  // the feet at `y = 0` INSIDE the water, where the ordinary per-tick step is
  // smaller than the escape margin (the radius), so without a working
  // depenetration the vertical move is refused and the actor hovers forever.
  const WATER = { minX: -4, maxX: 4, minZ: -4, maxZ: -1.5 };

  function bridgeOverWater(): Manager {
    return createWorldManager({
      map: ALL_GRASS_7,
      // The default map bounds are ±4.5; a slightly wider box keeps the escape
      // position clear of the clamp so this test exercises depenetration only.
      bounds: { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } },
      surfaces: [
        flatSurface({
          surfaceId: 'surface-deck',
          centerX: 0,
          centerZ: -3,
          halfX: 0.5,
          halfZ: 1,
          y: 1,
          kind: 'bridge',
        }),
        planeSurface({
          surfaceId: 'surface-approach',
          center: { x: 0, y: 0.5, z: -1 },
          axisU: { x: 0.5, y: 0, z: 0 },
          axisV: { x: 0, y: 0.5, z: -1 },
          kind: 'ramp',
        }),
      ],
      colliders: [
        box({
          colliderId: 'collider-water-bridge',
          min: { x: WATER.minX, y: 0, z: WATER.minZ },
          max: { x: WATER.maxX, y: WATER_COLLIDER_HEIGHT, z: WATER.maxZ },
          kind: 'water',
        }),
      ],
    });
  }

  // Walk off the deck's narrow SIDE over the water footprint, in BOTH horizontal
  // directions. Both land near the centre and must escape through the `-Z` face
  // (the float-inward face). With the bug the depenetration returned `null` in
  // that direction, the vertical move was refused, and the actor hovered at
  // `y = 0.5` while sliding sideways — the reviewer's independent repro. Testing
  // a single direction (the original WEST walk escaped through a face that
  // rounded outward) hid the defect, so both are now exercised.
  it.each([
    { label: 'WEST', dir: { x: -1, z: 0 }, away: -1 },
    { label: 'EAST', dir: { x: 1, z: 0 }, away: 1 },
  ])(
    'criterion 9: walking off the deck $label depenetrates and is not wedged',
    ({ dir, away }) => {
      const manager = bridgeOverWater();

      // Climb the approach ramp north onto the deck.
      manager.submitIntent({ actorId: ACTOR_ID, command: move({ x: 0, z: -1 }) });
      stepN(manager, 20);
      expect(positionOf(manager).y).toBeCloseTo(1, 10);
      expect(positionOf(manager).z).toBeLessThanOrEqual(-2);

      // The water volume is x in [-1.5, 1.5], z in [-4, -2] with top y = 0.3.
      const waterCollider = snapshotOf(manager).colliders.find(
        (collider) => String(collider.colliderId) === 'collider-water-bridge',
      )!;
      expect(waterCollider).toBeDefined();

      manager.submitIntent({ actorId: ACTOR_ID, command: move(dir) });
      let previous = positionOf(manager);
      let maxHorizontalDelta = 0;
      let landed: Position | undefined;
      let sawNonFinite = false;
      for (let tick = 0; tick < 20; tick += 1) {
        manager.step(50);
        const p = positionOf(manager);
        if (![p.x, p.y, p.z].every((value) => Number.isFinite(value))) {
          sawNonFinite = true;
        }
        maxHorizontalDelta = Math.max(
          maxHorizontalDelta,
          Math.hypot(p.x - previous.x, p.z - previous.z),
        );
        // INVARIANT: whenever the body's y range overlaps the water volume, the
        // XZ circle must be outside it by at least the radius. Before the fix
        // the actor sat inside here forever on the +X/-Z side.
        if (actorBodyOverlapsCollider(p.y, waterCollider)) {
          const nearestX = Math.min(Math.max(p.x, WATER.minX), WATER.maxX);
          const nearestZ = Math.min(Math.max(p.z, WATER.minZ), WATER.maxZ);
          expect(Math.hypot(p.x - nearestX, p.z - nearestZ)).toBeGreaterThanOrEqual(
            DEFAULT_ACTOR_RADIUS - 1e-9,
          );
        }
        previous = p;
        if (p.y === 0) {
          landed = p;
          break;
        }
      }

      expect(sawNonFinite).toBe(false);
      expect(landed).toBeDefined();
      // Some tick's horizontal correction is far larger than one tick step
      // (0.15 world units): that is the depenetration push out of the water.
      const tickStep = DEFAULT_ACTOR_SPEED * 0.05;
      expect(maxHorizontalDelta).toBeGreaterThan(tickStep * 3);

      // NOT wedged: holding the SAME direction keeps moving the actor away.
      const before = positionOf(manager);
      const samples = stepN(manager, 5);
      const last = samples[samples.length - 1];
      expect(away * (last.x - before.x)).toBeGreaterThan(0.1);
      for (const sample of samples) {
        expect(Number.isFinite(sample.x)).toBe(true);
        expect(sample.y).toBe(0);
      }
    },
  );

  it('resolveColliderPenetration: inside, edge-overlap, clear, y-clear and bounds cases', () => {
    const bounds = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 5, z: 5 } };
    const colliders = [
      box({
        colliderId: 'collider-shallow',
        min: { x: -0.5, y: 0, z: -0.5 },
        max: { x: 0.5, y: WATER_COLLIDER_HEIGHT, z: 0.5 },
        kind: 'water',
      }),
    ];
    const resolve = (x: number, z: number, feetY = 0) =>
      resolveColliderPenetration({
        x,
        z,
        feetY,
        radius: DEFAULT_ACTOR_RADIUS,
        bounds,
        colliders,
      });

    // Already overlapping with the centre INSIDE the volume: pushed out through
    // the nearest face by at least the radius. The depenetration clearance
    // exceeds the radius by a tiny epsilon (so the strict re-test is stable in
    // every direction); the coordinate assertions tolerate that epsilon.
    const fromCentre = resolve(0, 0);
    expect(fromCentre).not.toBeNull();
    expect(fromCentre!.x).toBeLessThanOrEqual(-0.5 - DEFAULT_ACTOR_RADIUS);
    expect(fromCentre!.x).toBeCloseTo(-0.5 - DEFAULT_ACTOR_RADIUS, 8);
    expect(fromCentre!.z).toBe(0);

    // Already overlapping from just outside the east face: pushed to the
    // boundary + radius.
    const fromEdge = resolve(0.7, 0);
    expect(fromEdge).not.toBeNull();
    expect(fromEdge!.x).toBeGreaterThanOrEqual(0.5 + DEFAULT_ACTOR_RADIUS);
    expect(fromEdge!.x).toBeCloseTo(0.5 + DEFAULT_ACTOR_RADIUS, 8);
    expect(fromEdge!.z).toBe(0);

    // Already clear: returned unchanged.
    expect(resolve(2, 0)).toEqual({ x: 2, z: 0 });

    // The actor's body is clear of the collider's REAL y range: no
    // depenetration, even directly inside the footprint.
    expect(resolve(0, 0, 1)).toEqual({ x: 0, z: 0 });

    // The desired position is projected into the world box before testing.
    const clamped = resolve(9, 0);
    expect(clamped).not.toBeNull();
    expect(clamped!.x).toBeCloseTo(5 - DEFAULT_ACTOR_RADIUS, 10);
  });

  it('resolveColliderPenetration: escapes an embedded point in EVERY face/corner direction', () => {
    // The reviewer's repro: a single water collider well inside the world box.
    // A point embedded near the +X or -Z face used to return `null`, because the
    // push placed the centre exactly `radius` out and the strict re-test rounded
    // a few ULPs inward, so the relaxation never converged; only the directions
    // whose rounding happened to go outward escaped. This asserts the escape for
    // EVERY face, EVERY corner, the exact centre and points very near each face.
    const bounds = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 8, z: 6 } };
    const collider = box({
      colliderId: 'collider-water-matrix',
      min: { x: 2, y: 0, z: -4 },
      max: { x: 4, y: 0.3, z: -2 },
      kind: 'water',
    });
    const colliders = [collider];

    const nearestPoint = (x: number, z: number) => ({
      nearestX: Math.min(Math.max(x, 2), 4),
      nearestZ: Math.min(Math.max(z, -4), -2),
    });
    const distanceFromCollider = (x: number, z: number): number => {
      const { nearestX, nearestZ } = nearestPoint(x, z);
      return Math.hypot(x - nearestX, z - nearestZ);
    };
    const intersects = (x: number, z: number): boolean => {
      const { nearestX, nearestZ } = nearestPoint(x, z);
      const dx = x - nearestX;
      const dz = z - nearestZ;
      return dx * dx + dz * dz < DEFAULT_ACTOR_RADIUS * DEFAULT_ACTOR_RADIUS;
    };

    // Offsets from the collider centre (3, -3); half-extents are 1 in x and z.
    // The 0.95 offsets are embedded near each face/corner; the 0.999 offsets are
    // very near each face (the deepest overlap the relaxation must still solve).
    const directions = [
      { label: 'centre', dx: 0, dz: 0 },
      { label: '+X face (0.95)', dx: 0.95, dz: 0 },
      { label: '-X face (0.95)', dx: -0.95, dz: 0 },
      { label: '+Z face (0.95)', dx: 0, dz: 0.95 },
      { label: '-Z face (0.95)', dx: 0, dz: -0.95 },
      { label: 'corner ++ (0.95, 0.95)', dx: 0.95, dz: 0.95 },
      { label: 'corner +- (0.95, -0.95)', dx: 0.95, dz: -0.95 },
      { label: 'corner -+ (-0.95, 0.95)', dx: -0.95, dz: 0.95 },
      { label: 'corner -- (-0.95, -0.95)', dx: -0.95, dz: -0.95 },
      { label: '+X near (0.999)', dx: 0.999, dz: 0 },
      { label: '-X near (-0.999)', dx: -0.999, dz: 0 },
      { label: '+Z near (0.999)', dx: 0, dz: 0.999 },
      { label: '-Z near (-0.999)', dx: 0, dz: -0.999 },
    ];

    for (const { label, dx, dz } of directions) {
      const resolved = resolveColliderPenetration({
        x: 3 + dx,
        z: -3 + dz,
        feetY: 0,
        radius: DEFAULT_ACTOR_RADIUS,
        bounds,
        colliders,
      });
      expect(resolved, `${label}: must not be reported as wedged`).not.toBeNull();
      const { x, z } = resolved!;
      expect(intersects(x, z), `${label}: must be outside the collider`).toBe(false);
      expect(
        distanceFromCollider(x, z),
        `${label}: must clear by at least the full radius`,
      ).toBeGreaterThanOrEqual(DEFAULT_ACTOR_RADIUS);
    }
  });

  it('rejects a non-perpendicular (sheared) patch at the authoring seam', () => {
    // Protocol-valid and up-facing (`cross.y > 0`), but `axisU · axisV != 0`:
    // a sheared parallelogram the standard 3D transform cannot express, so the
    // bridge would silently mis-render it.
    const sheared = planeSurface({
      surfaceId: 'surface-sheared',
      center: { x: 0, y: 0.5, z: 0 },
      axisU: { x: 1, y: 0, z: 0 },
      axisV: { x: 0.5, y: 0, z: -1 },
    });
    expect(isSurfaceState(sheared)).toBe(true);

    let caught: unknown;
    try {
      createWorldManager({ map: ALL_GRASS_3, surfaces: [sheared] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toMatch(/perpendicular|rectangle/i);

    // A perpendicular patch (a normal ramp) is still accepted.
    const rectangle = planeSurface({
      surfaceId: 'surface-rectangle',
      center: { x: 0, y: 0.5, z: -1 },
      axisU: { x: 0.5, y: 0, z: 0 },
      axisV: { x: 0, y: 0.5, z: -1 },
    });
    expect(() => createWorldManager({ map: ALL_GRASS_3, surfaces: [rectangle] })).not.toThrow();
  });
});
