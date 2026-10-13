import type { BlockGrid, BlockState, Vec3, WorldBounds } from '@starvalley/protocol';

import type { BlockReadPort } from './blocks.ts';
import {
  blockCellAabb,
  blockSolidTopOverRect,
  isSolidBlockKind,
} from './blocks.ts';
import type { EntityCollider } from './entities.ts';
import { MAX_STEP_HEIGHT } from './placement.ts';

/** Gravitational acceleration, in world units per second squared. */
export const GRAVITY = 20;

/**
 * Upward launch speed applied by a grounded `actor.jump`, in world units per
 * second. Chosen so the apex clears one full cube (`1.0` world unit) with a
 * little margin: `v^2 / (2g) ~= 1.3`.
 */
export const JUMP_SPEED = 7.2;

/** Landing snap tolerance, in world units. */
export const LANDING_SNAP_TOLERANCE = 0.05;

/** Maximum downward step the actor follows while grounded, in world units. */
export const MAX_STEP_DOWN = MAX_STEP_HEIGHT;

/** Numerical slack for collision tests (far below any gameplay distance). */
const CONTACT_EPSILON = 1e-9;

/** An entity collider positioned in the world (its base anchor). */
export interface MovementCollider {
  readonly collider: EntityCollider;
  /** The entity's base position (`Transform.position`). */
  readonly position: Vec3;
}

/** The continuous inputs to one deterministic movement resolution. */
export interface MovementInput {
  readonly grid: BlockGrid;
  readonly bounds: WorldBounds;
  /** Actor XZ half-extent (an AABB body for block/entity collision). */
  readonly radius: number;
  /** Actor body height, measured up from the feet. */
  readonly height: number;
  /** Current feet position. */
  readonly position: Vec3;
  /** Downward speed carried between ticks. */
  readonly verticalVelocity: number;
  /** Whether the actor was grounded on the previous tick. */
  readonly grounded: boolean;
  /** Desired horizontal displacement for this tick. */
  readonly displacement: { readonly x: number; readonly z: number };
  readonly blocks: BlockReadPort;
  /** Placeable/other entity colliders (never the actor's own). */
  readonly colliders: readonly MovementCollider[];
  readonly dtSeconds: number;
}

/** The outcome of one movement resolution. */
export interface MovementResult {
  readonly position: Vec3;
  readonly verticalVelocity: number;
  readonly grounded: boolean;
  readonly moved: boolean;
}

interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

function colliderAabb(collider: EntityCollider, position: Vec3): Aabb {
  switch (collider.type) {
    case 'aabb':
      return {
        min: {
          x: position.x - collider.halfExtents.x,
          y: position.y,
          z: position.z - collider.halfExtents.z,
        },
        max: {
          x: position.x + collider.halfExtents.x,
          y: position.y + 2 * collider.halfExtents.y,
          z: position.z + collider.halfExtents.z,
        },
      };
    case 'cylinder':
      return {
        min: { x: position.x - collider.radius, y: position.y, z: position.z - collider.radius },
        max: {
          x: position.x + collider.radius,
          y: position.y + collider.height,
          z: position.z + collider.radius,
        },
      };
    case 'capsule':
      return {
        min: { x: position.x - collider.radius, y: position.y, z: position.z - collider.radius },
        max: {
          x: position.x + collider.radius,
          y: position.y + collider.height,
          z: position.z + collider.radius,
        },
      };
    default: {
      const exhaustive: never = collider;
      throw new Error(`Unhandled EntityCollider: ${String(exhaustive)}`);
    }
  }
}

function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x < b.max.x - CONTACT_EPSILON &&
    a.max.x > b.min.x + CONTACT_EPSILON &&
    a.min.y < b.max.y - CONTACT_EPSILON &&
    a.max.y > b.min.y + CONTACT_EPSILON &&
    a.min.z < b.max.z - CONTACT_EPSILON &&
    a.max.z > b.min.z + CONTACT_EPSILON
  );
}

/**
 * Does a solid block overlap the actor AABB? The block's collision SHAPE (not
 * its kind) decides the geometry: `blockSolidTopOverRect` gives the shape's
 * highest solid top over the XZ intersection, and all shapes are
 * bottom-anchored.
 */
function blockOverlapsActor(
  block: BlockState,
  grid: BlockGrid,
  actor: Aabb,
): boolean {
  if (!isSolidBlockKind(block.kind)) {
    return false;
  }
  const cell = blockCellAabb(block, grid);
  const rx0 = Math.max(actor.min.x, cell.min.x);
  const rx1 = Math.min(actor.max.x, cell.max.x);
  const rz0 = Math.max(actor.min.z, cell.min.z);
  const rz1 = Math.min(actor.max.z, cell.max.z);
  if (rx1 - rx0 <= CONTACT_EPSILON || rz1 - rz0 <= CONTACT_EPSILON) {
    return false;
  }
  if (actor.min.y >= cell.max.y - CONTACT_EPSILON) {
    return false;
  }
  if (actor.max.y <= cell.min.y + CONTACT_EPSILON) {
    return false;
  }
  const top = blockSolidTopOverRect(block, grid, rx0, rx1, rz0, rz1);
  if (top === null) {
    return false;
  }
  return actor.min.y < top - CONTACT_EPSILON && actor.max.y > cell.min.y + CONTACT_EPSILON;
}

function circleIntersectsAabb(cx: number, cz: number, radius: number, box: Aabb): boolean {
  const nearestX = Math.min(Math.max(cx, box.min.x), box.max.x);
  const nearestZ = Math.min(Math.max(cz, box.min.z), box.max.z);
  const dx = cx - nearestX;
  const dz = cz - nearestZ;
  return dx * dx + dz * dz < radius * radius;
}

function colliderOverlapsActor(
  collider: EntityCollider,
  position: Vec3,
  actor: Aabb,
): boolean {
  const box = colliderAabb(collider, position);
  if (!aabbOverlap(actor, box)) {
    return false;
  }
  switch (collider.type) {
    case 'aabb':
      return true;
    case 'cylinder':
    case 'capsule': {
      // Vertical cylinder test in XZ against the actor's rectangle. A capsule
      // is approximated by its enclosing cylinder; the content uses no capsule,
      // and the approximation is conservative (never lets the actor inside).
      const cx = position.x;
      const cz = position.z;
      return circleIntersectsAabb(cx, cz, collider.radius, actor);
    }
    default: {
      const exhaustive: never = collider;
      throw new Error(`Unhandled EntityCollider: ${String(exhaustive)}`);
    }
  }
}

function actorAabb(x: number, z: number, feetY: number, radius: number, height: number): Aabb {
  return {
    min: { x: x - radius, y: feetY, z: z - radius },
    max: { x: x + radius, y: feetY + height, z: z + radius },
  };
}

function clampXZ(
  x: number,
  z: number,
  radius: number,
  bounds: WorldBounds,
): { readonly x: number; readonly z: number } {
  return {
    x: Math.min(Math.max(x, bounds.min.x + radius), bounds.max.x - radius),
    z: Math.min(Math.max(z, bounds.min.z + radius), bounds.max.z - radius),
  };
}

/** Can the actor AABB occupy `(x, z, feetY)` without overlapping anything? */
export function actorCanOccupy(
  grid: BlockGrid,
  bounds: WorldBounds,
  blocks: BlockReadPort,
  colliders: readonly MovementCollider[],
  x: number,
  z: number,
  feetY: number,
  radius: number,
  height: number,
): boolean {
  if (
    x - radius < bounds.min.x + CONTACT_EPSILON ||
    x + radius > bounds.max.x - CONTACT_EPSILON ||
    z - radius < bounds.min.z + CONTACT_EPSILON ||
    z + radius > bounds.max.z - CONTACT_EPSILON
  ) {
    return false;
  }
  const actor = actorAabb(x, z, feetY, radius, height);
  const nearby = blocks.queryAabb(actor.min, actor.max);
  for (const block of nearby) {
    if (blockOverlapsActor(block, grid, actor)) {
      return false;
    }
  }
  for (const entry of colliders) {
    if (colliderOverlapsActor(entry.collider, entry.position, actor)) {
      return false;
    }
  }
  return true;
}

/**
 * The highest solid support top under the actor footprint at `(x, z)` that is
 * at or below `maxY`, or `null`.
 *
 * The whole footprint rectangle is considered, and each block contributes the
 * maximum of its shape top over the XZ intersection. This is the shape-agnostic
 * support query (cube top, slab top, stair step, ramp height field).
 */
export function supportTopUnderActor(
  grid: BlockGrid,
  bounds: WorldBounds,
  blocks: BlockReadPort,
  x: number,
  z: number,
  maxY: number,
  radius: number,
): number | null {
  const min: Vec3 = { x: x - radius, y: bounds.min.y, z: z - radius };
  const max: Vec3 = { x: x + radius, y: maxY, z: z + radius };
  const nearby = blocks.queryAabb(min, max);
  let best: number | null = null;
  for (const block of nearby) {
    if (!isSolidBlockKind(block.kind)) {
      continue;
    }
    const cell = blockCellAabb(block, grid);
    const rx0 = Math.max(min.x, cell.min.x);
    const rx1 = Math.min(max.x, cell.max.x);
    const rz0 = Math.max(min.z, cell.min.z);
    const rz1 = Math.min(max.z, cell.max.z);
    if (rx1 - rx0 <= CONTACT_EPSILON || rz1 - rz0 <= CONTACT_EPSILON) {
      continue;
    }
    const top = blockSolidTopOverRect(block, grid, rx0, rx1, rz0, rz1);
    if (top === null || top > maxY + CONTACT_EPSILON) {
      continue;
    }
    if (best === null || top > best) {
      best = top;
    }
  }
  return best;
}

function pushOutOfBox(
  x: number,
  z: number,
  radius: number,
  box: Aabb,
): { readonly x: number; readonly z: number } {
  const overlapX = Math.min(x + radius, box.max.x) - Math.max(x - radius, box.min.x);
  const overlapZ = Math.min(z + radius, box.max.z) - Math.max(z - radius, box.min.z);
  if (overlapX <= overlapZ) {
    const centreX = (box.min.x + box.max.x) / 2;
    return x < centreX
      ? { x: box.min.x - radius - CONTACT_EPSILON, z }
      : { x: box.max.x + radius + CONTACT_EPSILON, z };
  }
  const centreZ = (box.min.z + box.max.z) / 2;
  return z < centreZ
    ? { x, z: box.min.z - radius - CONTACT_EPSILON }
    : { x, z: box.max.z + radius + CONTACT_EPSILON };
}

/**
 * Recover a legal position when the actor is inside a solid (e.g. a block was
 * placed on it). Bounded, deterministic relaxation that pushes out of the first
 * overlapping volume along its least-penetration axis. Returns `null` when no
 * escape exists within the pass budget.
 */
export function depenetrateActor(
  grid: BlockGrid,
  bounds: WorldBounds,
  blocks: BlockReadPort,
  colliders: readonly MovementCollider[],
  x: number,
  z: number,
  feetY: number,
  radius: number,
  height: number,
): { readonly x: number; readonly z: number } | null {
  let currentX = clampXZ(x, z, radius, bounds).x;
  let currentZ = clampXZ(x, z, radius, bounds).z;
  for (let pass = 0; pass < colliders.length + 8; pass += 1) {
    const actor = actorAabb(currentX, currentZ, feetY, radius, height);
    let pushed = false;
    for (const block of blocks.queryAabb(actor.min, actor.max)) {
      if (!blockOverlapsActor(block, grid, actor)) {
        continue;
      }
      const next = pushOutOfBox(currentX, currentZ, radius, blockCellAabb(block, grid));
      const clamped = clampXZ(next.x, next.z, radius, bounds);
      currentX = clamped.x;
      currentZ = clamped.z;
      pushed = true;
      break;
    }
    if (pushed) {
      continue;
    }
    for (const entry of colliders) {
      if (!colliderOverlapsActor(entry.collider, entry.position, actor)) {
        continue;
      }
      const next = pushOutOfBox(currentX, currentZ, radius, colliderAabb(entry.collider, entry.position));
      const clamped = clampXZ(next.x, next.z, radius, bounds);
      currentX = clamped.x;
      currentZ = clamped.z;
      pushed = true;
      break;
    }
    if (!pushed) {
      return { x: currentX, z: currentZ };
    }
  }
  return actorCanOccupy(grid, bounds, blocks, colliders, currentX, currentZ, feetY, radius, height)
    ? { x: currentX, z: currentZ }
    : null;
}

/**
 * Resolve one deterministic movement tick.
 *
 * Horizontal motion is axis-separated (slide along a wall) with an AUTO-STEP
 * retry: if an axis is blocked, the actor is lifted to the support under the
 * destination when that step is at most {@link MAX_STEP_HEIGHT}. Vertical
 * motion is the support query plus gravity, with an exact landing snap. It is
 * pure and deterministic, never produces `NaN`, never lets the actor into a
 * collider, and depenetrates a wedged actor.
 */
export function stepMovement(input: MovementInput): MovementResult {
  const {
    grid,
    bounds,
    radius,
    height,
    blocks,
    colliders,
    dtSeconds,
  } = input;

  const startX = input.position.x;
  const startY = input.position.y;
  const startZ = input.position.z;

  const clampedStart = clampXZ(startX, startZ, radius, bounds);
  let x = Number.isFinite(clampedStart.x) ? clampedStart.x : 0;
  let z = Number.isFinite(clampedStart.z) ? clampedStart.z : 0;
  let feetY = Number.isFinite(startY) ? startY : bounds.min.y;

  if (!actorCanOccupy(grid, bounds, blocks, colliders, x, z, feetY, radius, height)) {
    const escaped = depenetrateActor(
      grid,
      bounds,
      blocks,
      colliders,
      x,
      z,
      feetY,
      radius,
      height,
    );
    if (escaped !== null) {
      x = escaped.x;
      z = escaped.z;
    }
  }

  const tryAxis = (
    targetX: number,
    targetZ: number,
  ): { readonly x: number; readonly z: number; readonly feetY: number } | null => {
    const clamped = clampXZ(targetX, targetZ, radius, bounds);
    if (actorCanOccupy(grid, bounds, blocks, colliders, clamped.x, clamped.z, feetY, radius, height)) {
      return { x: clamped.x, z: clamped.z, feetY };
    }
    const stepTop = supportTopUnderActor(
      grid,
      bounds,
      blocks,
      clamped.x,
      clamped.z,
      feetY + MAX_STEP_HEIGHT,
      radius,
    );
    if (
      stepTop !== null &&
      stepTop > feetY + CONTACT_EPSILON &&
      stepTop <= feetY + MAX_STEP_HEIGHT + CONTACT_EPSILON &&
      actorCanOccupy(grid, bounds, blocks, colliders, clamped.x, clamped.z, stepTop, radius, height)
    ) {
      return { x: clamped.x, z: clamped.z, feetY: stepTop };
    }
    return null;
  };

  if (input.displacement.x !== 0) {
    const resolved = tryAxis(x + input.displacement.x, z);
    if (resolved !== null) {
      x = resolved.x;
      z = resolved.z;
      feetY = resolved.feetY;
    }
  }
  if (input.displacement.z !== 0) {
    const resolved = tryAxis(x, z + input.displacement.z);
    if (resolved !== null) {
      x = resolved.x;
      z = resolved.z;
      feetY = resolved.feetY;
    }
  }

  const support = supportTopUnderActor(
    grid,
    bounds,
    blocks,
    x,
    z,
    feetY + MAX_STEP_HEIGHT,
    radius,
  );

  let nextFeet: number;
  let nextVerticalVelocity: number;
  let grounded: boolean;
  const movingUpward = input.verticalVelocity < 0;
  const airborne = !input.grounded || movingUpward;
  if (!airborne && support !== null && feetY - support <= MAX_STEP_DOWN + CONTACT_EPSILON) {
    nextFeet = support;
    nextVerticalVelocity = 0;
    grounded = true;
  } else {
    nextVerticalVelocity = input.verticalVelocity + GRAVITY * dtSeconds;
    const candidate = feetY - nextVerticalVelocity * dtSeconds;
    const landing = supportTopUnderActor(grid, bounds, blocks, x, z, feetY, radius);
    if (landing !== null && candidate <= landing + LANDING_SNAP_TOLERANCE) {
      nextFeet = landing;
      nextVerticalVelocity = 0;
      grounded = true;
    } else {
      nextFeet = candidate;
      grounded = false;
    }
    if (nextFeet <= bounds.min.y) {
      nextFeet = bounds.min.y;
      nextVerticalVelocity = 0;
      grounded = true;
    }
  }

  const moved =
    Math.abs(x - startX) > CONTACT_EPSILON ||
    Math.abs(z - startZ) > CONTACT_EPSILON ||
    Math.abs(nextFeet - startY) > CONTACT_EPSILON;

  return {
    position: { x, y: nextFeet, z },
    verticalVelocity: nextVerticalVelocity,
    grounded,
    moved,
  };
}
