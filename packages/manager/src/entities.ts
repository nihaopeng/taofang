import type {
  BlockOrientation,
  EntityKind,
  FootprintExtents,
  Vec3,
} from '@starvalley/protocol';

/**
 * Server-only collider primitive for an entity, anchored at the entity's
 * committed base position (`Transform.position`, which sits on the support top
 * face).
 *
 * The three variants are the complete boundary; the solver implements all of
 * them even though the current content uses only `aabb` and `cylinder`.
 *
 * - `aabb { halfExtents }`: an axis-aligned box. Horizontally centred on the
 *   transform; vertically it spans `[position.y, position.y + 2 *
 *   halfExtents.y]`. `halfExtents.y` is a HALF-height.
 * - `cylinder { radius, height }`: a vertical cylinder centred horizontally on
 *   the transform, spanning `[position.y, position.y + height]`.
 * - `capsule { radius, height }`: a vertical capsule centred horizontally on
 *   the transform; `height` is the TOTAL height including the two hemispherical
 *   caps, so the straight segment spans `[position.y + radius, position.y +
 *   height - radius]`.
 *
 * Colliders come from this definition ONLY. They are never derived from a
 * model, mesh, or asset.
 */
export type EntityCollider =
  | { readonly type: 'aabb'; readonly halfExtents: Vec3 }
  | { readonly type: 'cylinder'; readonly radius: number; readonly height: number }
  | { readonly type: 'capsule'; readonly radius: number; readonly height: number };

/**
 * How a placeable entity maps onto the integer block grid.
 *
 * `footprint` is measured in WHOLE cells on the two horizontal axes (it may be
 * mixed-parity). `height` is in world units and drives the vertical occupancy
 * extrusion. `allowedYawSteps` is the closed set of quarter turns the entity may
 * be rotated to.
 */
export interface EntityPlacementDefinition {
  readonly footprint: FootprintExtents;
  readonly height: number;
  readonly allowedYawSteps: readonly BlockOrientation[];
}

/** Server-only gameplay definition for an entity kind. Never crosses the wire. */
export interface EntityDefinition {
  readonly kind: EntityKind;
  readonly collider: EntityCollider;
  /** Present only for grid-placeable kinds; dynamic actors omit it. */
  readonly placement?: EntityPlacementDefinition;
}

/** Actor body radius, in world units (the XZ half-extent of its cylinder). */
export const DEFAULT_ACTOR_RADIUS = 0.35;

/** Actor body height, in world units, measured up from the feet. */
export const DEFAULT_ACTOR_HEIGHT = 1.8;

/** Trunk collider radius for a tree, in world units. */
export const TREE_TRUNK_RADIUS = 0.4;

/** Trunk collider height for a tree, in world units. */
export const TREE_TRUNK_HEIGHT = 2.5;

const ALL_YAW_STEPS: readonly BlockOrientation[] = [0, 90, 180, 270];

/**
 * Total server-side registry: every `EntityKind` has exactly one definition.
 *
 * `character` is the dynamic actor: a cylinder body, not placeable (no
 * `placement`). `tree` is a trunk-only cylinder. `rock`, `chest` and `building`
 * are AABB placeables; `building` is the multi-cell (2x2) footprint that
 * exercises rotation. Adding a kind is a compile error here until its collider
 * (and placement, if any) is decided.
 */
export const ENTITY_DEFINITIONS: Readonly<Record<EntityKind, EntityDefinition>> = {
  character: {
    kind: 'character',
    collider: { type: 'cylinder', radius: DEFAULT_ACTOR_RADIUS, height: DEFAULT_ACTOR_HEIGHT },
  },
  tree: {
    kind: 'tree',
    collider: { type: 'cylinder', radius: TREE_TRUNK_RADIUS, height: TREE_TRUNK_HEIGHT },
    placement: {
      footprint: { x: 1, z: 1 },
      height: TREE_TRUNK_HEIGHT,
      allowedYawSteps: [0],
    },
  },
  rock: {
    kind: 'rock',
    collider: { type: 'aabb', halfExtents: { x: 0.45, y: 0.3, z: 0.45 } },
    placement: {
      footprint: { x: 1, z: 1 },
      height: 0.6,
      allowedYawSteps: ALL_YAW_STEPS,
    },
  },
  chest: {
    kind: 'chest',
    collider: { type: 'aabb', halfExtents: { x: 0.4, y: 0.35, z: 0.4 } },
    placement: {
      footprint: { x: 1, z: 1 },
      height: 0.7,
      allowedYawSteps: ALL_YAW_STEPS,
    },
  },
  building: {
    kind: 'building',
    collider: { type: 'aabb', halfExtents: { x: 1, y: 1.5, z: 1 } },
    placement: {
      footprint: { x: 2, z: 2 },
      height: 3,
      allowedYawSteps: ALL_YAW_STEPS,
    },
  },
};

/** The definition for an entity kind. Total; never `undefined`. */
export function entityDefinition(kind: EntityKind): EntityDefinition {
  return ENTITY_DEFINITIONS[kind];
}

/** Does a kind have a placement definition (i.e. is it grid-placeable)? */
export function isPlaceableKind(kind: EntityKind): boolean {
  return ENTITY_DEFINITIONS[kind].placement !== undefined;
}
