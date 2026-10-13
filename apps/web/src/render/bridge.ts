/**
 * The Render Bridge: Organizer world state -> Render ISA frames.
 *
 * This module is pure and framework-free. It maps *client application state*
 * (the Organizer's `WorldState`) into the in-process Render ISA, and it owns the
 * only piece of knowledge a stateless mapper cannot have: which render nodes
 * currently exist. That lets it emit a **diff** (create/update/destroy) instead
 * of replaying the whole scene on every state change.
 *
 * Boundaries (enforced by `eslint.config.js`):
 * - No `three`: the bridge decides *what* the scene should contain, never *how*
 *   a particular runtime draws it.
 * - No game protocol, no backend, no UI components: it consumes only the
 *   Organizer barrel and the render ISA types.
 * - No clock: `frameFor` is a pure function of `(state, previously-known nodes)`
 *   so it is deterministic and unit-testable without timers.
 * - No gameplay rule. A block/entity/view-model `kind` is an opaque string here:
 *   mapping it to an appearance is presentation, but whether a cell is
 *   load-bearing, occupied, permitted or walkable is an authoritative Manager
 *   rule the client must never infer.
 *
 * Phase 15: the block-spatial kernel
 * ----------------------------------
 * The v9 snapshot is `{ blockGrid, blocks (sparse), entities, ... }`. The
 * bridge maps:
 *
 * - **blocks** -> object-layer nodes using the STANDARD 3D `RenderTransform`
 *   (position + rotation + scale). There is **no** new ISA primitive and no
 *   cell -> scene mapping: the Organizer already derives each block's world-space
 *   centre with the frozen `cellCentre` rule, and the bridge passes that through
 *   unchanged. The block's yaw-step `orientation` becomes a rotation about `+Y`.
 * - **entities** -> object-layer nodes at their authoritative continuous
 *   transform (position + quaternion), exactly as in phase 7.
 *
 * `tiles` / `surfaces` / `colliders` / `grid` were removed by the block-spatial
 * kernel; there is no ground-surface special case and no collider visual. Block
 * nodes are the world geometry now.
 *
 * Node identity (namespacing)
 * ---------------------------
 * A render `NodeId` is derived from game identity, but the two are deliberately
 * different types. The renderer must not be able to read game identity (it
 * receives only `NodeId`); game identity stops here. Ids are **namespaced** so
 * no two collections can collide even when an id textually looks like another's
 * coordinate:
 *
 * ```text
 * block:<cellX>,<cellY>,<cellZ>   one absolute integer CellCoord
 * entity:<entityId>               one EntityId
 * ```
 *
 * `controlledActorNodeId` / `entityIdOfNodeId` / `blockCellOfNodeId` own both
 * directions of those conventions, so the UI — which may not import the game
 * protocol — can recover "entity vs block vs ground" from the opaque `NodeId`
 * `pick()` hands back.
 *
 * Chunk grouping
 * --------------
 * Blocks are a sparse set of absolute cells, and the protocol groups cells into
 * `CHUNK_SIZE`-edged chunks (`cellToChunk`). The bridge mirrors that boundary so
 * a chunk is the natural rebuild unit: block commands are emitted **chunk by
 * chunk**, and every block of one chunk is contiguous in the frame. A future
 * instanced / greedy-meshed realisation can therefore replace one chunk's
 * emission without changing the Render ISA contract. `CHUNK_SIZE` is re-declared
 * here (the bridge may not import the game protocol) and a test pins it to the
 * frozen protocol constant so it can never drift silently.
 */

import type {
  AnimationId,
  AppearanceId,
  NodeId,
  Quat,
  RenderCommand,
  RenderFrame,
  RenderTransform,
  Vec3,
} from '@starvalley/render-protocol';

import type { BlockViewModel, WorldState } from '../organizer';

// Re-export the ISA surface the UI is allowed to see. UI components must not
// import `@starvalley/render-protocol` directly (lint enforces it), so the
// bridge is their single entry point to the render primitives.
export type { RenderCommand, RenderFrame } from '@starvalley/render-protocol';

/**
 * Default duration for interpolating an authoritative transform target. Close to
 * the Manager's 20 Hz tick period (50 ms) so a continuous stream of authoritative
 * transforms renders smoothly at 60 fps without adding perceptible lag. This is
 * presentation-only smoothing: the target already came from the server, so easing
 * toward it is not client prediction.
 */
const DEFAULT_STEP_DURATION_MS = 50;

/**
 * Animation ids the bridge can emit. The runtime owns what they look like and
 * when a move is over; the bridge owns which animation a move start uses.
 */
const ANIMATION_WALK = 'walk' as AnimationId;

/** The neutral scale applied where the source has no meaningful value. */
const UNIT_SCALE: Vec3 = { x: 1, y: 1, z: 1 };

/**
 * Cells per chunk edge, mirroring the frozen protocol `CHUNK_SIZE`. The bridge
 * cannot import `@starvalley/protocol` (the architecture keeps the render layer
 * free of game-contract imports), so the value is declared here and a test pins
 * it to the protocol constant so it can never drift silently.
 */
export const BRIDGE_CHUNK_SIZE = 16;

/**
 * Appearance catalogue: block `kind` -> opaque render `AppearanceId`.
 *
 * The runtime owns what an appearance id *looks like* (the geometry, materials
 * and colours live in `render/three`); the bridge only chooses the id. `air` is
 * deliberately ABSENT: air is the absence of a block and never renders. A
 * snapshot never carries `air`, so this is not reachable through the real
 * transport; `air` is skipped defensively.
 */
const APPEARANCE_BY_BLOCK_KIND: Readonly<Record<string, AppearanceId>> = {
  grass: asAppearanceId('appearance.block.grass'),
  soil: asAppearanceId('appearance.block.soil'),
  stone: asAppearanceId('appearance.block.stone'),
  path: asAppearanceId('appearance.block.path'),
  water: asAppearanceId('appearance.block.water'),
  slab: asAppearanceId('appearance.block.slab'),
  stairs: asAppearanceId('appearance.block.stairs'),
  ramp: asAppearanceId('appearance.block.ramp'),
};

/**
 * Every block kind the bridge renders with a real (non-fallback) appearance.
 *
 * Exported so a cross-module coverage assertion can pin that every kind the real
 * server can send is a key here: a new kind silently falling through to the
 * fallback is exactly the bug this export exists to make impossible. It is
 * derived from the catalogue, so it cannot drift. `air` is intentionally absent.
 */
export const BRIDGE_BLOCK_KINDS: readonly string[] = Object.freeze(
  Object.keys(APPEARANCE_BY_BLOCK_KIND),
);

/**
 * Appearance catalogue: entity `kind` -> opaque render `AppearanceId`.
 *
 * Mirrors the closed `EntityKind` union: `character | tree | rock | chest |
 * building`. The runtime has an appearance slot (procedural placeholder + an
 * optional GLB descriptor) for every entry.
 */
const APPEARANCE_BY_KIND: Readonly<Record<string, AppearanceId>> = {
  character: asAppearanceId('appearance.character'),
  tree: asAppearanceId('appearance.tree'),
  rock: asAppearanceId('appearance.rock'),
  chest: asAppearanceId('appearance.chest'),
  building: asAppearanceId('appearance.building'),
};

/** Every entity kind the bridge renders with a real (non-fallback) appearance. */
export const BRIDGE_ENTITY_KINDS: readonly string[] = Object.freeze(
  Object.keys(APPEARANCE_BY_KIND),
);

/**
 * Documented fallback for a value the catalogue does not know (an entity `kind`
 * or a block `kind`).
 *
 * Unknown values are not reachable through the real transport: the Organizer
 * validates every kind against its closed union before a frame is built, so an
 * unknown value rejects there and the client settles into `error`. This fallback
 * is defence-in-depth for direct or looser callers of the bridge; it keeps such a
 * value rendering as a visible "unknown" look rather than throwing or silently
 * blanking.
 */
export const FALLBACK_APPEARANCE: AppearanceId = asAppearanceId('appearance.fallback');

/**
 * Every appearance id the bridge can emit: one per known block kind, one per
 * known entity kind, plus the fallback.
 *
 * Exported so the runtime can bind its own prefab catalogue to it: a rename on
 * either side becomes a test failure instead of a silent fallback colour. A new
 * kind added above grows this list automatically.
 */
export const BRIDGE_APPEARANCES: readonly AppearanceId[] = [
  ...new Set([
    ...Object.values(APPEARANCE_BY_BLOCK_KIND),
    ...Object.values(APPEARANCE_BY_KIND),
    FALLBACK_APPEARANCE,
  ]),
];

const BLOCK_NODE_PREFIX = 'block:';
const ENTITY_NODE_PREFIX = 'entity:';

function asAppearanceId(value: string): AppearanceId {
  return value as AppearanceId;
}

/** Resolve the catalogue appearance for a block kind, falling back for unknown kinds. */
export function blockAppearanceFor(kind: string): AppearanceId {
  return APPEARANCE_BY_BLOCK_KIND[kind] ?? FALLBACK_APPEARANCE;
}

/** Resolve the catalogue appearance for an entity kind, falling back for unknown kinds. */
export function entityAppearanceFor(kind: string): AppearanceId {
  return APPEARANCE_BY_KIND[kind] ?? FALLBACK_APPEARANCE;
}

/** Floor division: `Math.floor(a / b)`, correct for negative values (not truncation). */
function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/**
 * The chunk an absolute integer cell belongs to, using the frozen protocol rule
 * (`floorDiv(cell, CHUNK_SIZE)` on every axis). The bridge groups block
 * emission by this, so a chunk is the rebuild boundary.
 */
export function blockChunkOf(cell: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: floorDiv(cell.x, BRIDGE_CHUNK_SIZE),
    y: floorDiv(cell.y, BRIDGE_CHUNK_SIZE),
    z: floorDiv(cell.z, BRIDGE_CHUNK_SIZE),
  };
}

/** Stable, comparable key for a block's chunk (used for deterministic ordering). */
export function blockChunkKey(cell: { x: number; y: number; z: number }): string {
  const chunk = blockChunkOf(cell);
  return `${chunk.x},${chunk.y},${chunk.z}`;
}

/** The render node id of one block: `block:<cellX>,<cellY>,<cellZ>`. */
function blockNodeId(coord: { x: number; y: number; z: number }): NodeId {
  return `${BLOCK_NODE_PREFIX}${coord.x},${coord.y},${coord.z}` as NodeId;
}

/** The render node id of one entity: `entity:<entityId>`. */
function entityNodeId(entityId: string): NodeId {
  return `${ENTITY_NODE_PREFIX}${entityId}` as NodeId;
}

/**
 * Map a render `NodeId` back to the game `entityId` it was derived from, or
 * `null` when the node is not an entity node.
 *
 * The bridge owns the `entity:<entityId>` convention, so this mapping lives
 * here: the runtime hands back an opaque `NodeId` from `pick()`, and the UI —
 * which may not import the game protocol — turns it into an interact intent
 * through this function.
 */
export function entityIdOfNodeId(nodeId: NodeId): string | null {
  const raw = String(nodeId);
  if (!raw.startsWith(ENTITY_NODE_PREFIX)) {
    return null;
  }
  const entityId = raw.slice(ENTITY_NODE_PREFIX.length);
  return entityId.length > 0 ? entityId : null;
}

/**
 * Map a render `NodeId` back to the absolute integer cell it was derived from,
 * or `null` when the node is not a block node.
 *
 * This is the block half of the "entity vs block vs ground" distinction at the
 * pick site: an entity node returns `null` here and a non-null id from
 * {@link entityIdOfNodeId}, a block node does the opposite, and a ground hit
 * carries no node id at all.
 */
export function blockCellOfNodeId(
  nodeId: NodeId,
): { x: number; y: number; z: number } | null {
  const raw = String(nodeId);
  if (!raw.startsWith(BLOCK_NODE_PREFIX)) {
    return null;
  }
  const parts = raw.slice(BLOCK_NODE_PREFIX.length).split(',');
  if (parts.length !== 3) {
    return null;
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    return null;
  }
  return { x, y, z };
}

/**
 * Yaw about `+Y` as a quaternion. A block `orientation` is a yaw step in degrees
 * (`0 | 90 | 180 | 270`), so it maps to a real rotation on the standard 3D
 * transform with no new ISA primitive.
 */
function yawQuat(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Build a Render ISA transform from a view-model world position/rotation.
 *
 * The bridge maps the Organizer's world values through **unchanged**: no cell
 * interpretation, no axis flipping, no coordinate conversion.
 */
function renderTransform(position: Vec3, rotation: Quat, scale: Vec3 = UNIT_SCALE): RenderTransform {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
}

function sameVec3(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameQuat(a: Quat, b: Quat): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
}

/** The render state the bridge believes exists for one entity node. */
interface KnownEntity {
  appearance: AppearanceId;
  position: Vec3;
  rotation: Quat;
  visible: boolean;
}

/** The render state the bridge believes exists for one block node. */
interface KnownBlock {
  kind: string;
  orientation: number;
  position: Vec3;
}

function byEntityId(
  a: WorldState['entities'][number],
  b: WorldState['entities'][number],
): number {
  if (a.entityId < b.entityId) {
    return -1;
  }
  if (a.entityId > b.entityId) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic block order: **chunk-major**, then local cell `y`, `z`, `x`.
 *
 * Chunk-major order is what makes a chunk a rebuild boundary: every block of one
 * chunk is contiguous in the emitted frame, so a future instanced / greedy-meshed
 * realisation can replace one chunk's emission as a unit. Within a chunk the
 * order is the same layer/row/column discipline the Organizer already uses.
 */
export function compareBlocksForRender(a: BlockViewModel, b: BlockViewModel): number {
  const chunkA = blockChunkOf(a.coord);
  const chunkB = blockChunkOf(b.coord);
  if (chunkA.y !== chunkB.y) {
    return chunkA.y - chunkB.y;
  }
  if (chunkA.z !== chunkB.z) {
    return chunkA.z - chunkB.z;
  }
  if (chunkA.x !== chunkB.x) {
    return chunkA.x - chunkB.x;
  }
  if (a.coord.y !== b.coord.y) {
    return a.coord.y - b.coord.y;
  }
  if (a.coord.z !== b.coord.z) {
    return a.coord.z - b.coord.z;
  }
  return a.coord.x - b.coord.x;
}

function blockKey(coord: { x: number; y: number; z: number }): string {
  return `${coord.x},${coord.y},${coord.z}`;
}

/** Stateful mapper from `WorldState` to ordered render frames. */
export interface RenderBridge {
  /**
   * Produce the diff needed to move the runtime from its previous frame to this
   * state. A change of `WorldState.worldId` is a full world switch: the
   * known-node memory is reset first, so every node is re-created (a snap) and
   * any node the new world does not contain is destroyed.
   */
  frameFor(state: WorldState): RenderFrame;
  /** Forget every known node, so the next call re-emits `node.create` for all blocks and entities. */
  reset(): void;
}

/**
 * The render node id of the actor the caller controls, or `null` when there is
 * no controlled actor (including before the world loads).
 *
 * Exported so the UI can wire the runtime's camera follow target without
 * duplicating the bridge's id-namespacing rule: node identity is owned here.
 */
export function controlledActorNodeId(state: WorldState): NodeId | null {
  if (state.controlledActorId === null) {
    return null;
  }
  const entity = state.entities.find(
    (candidate) => candidate.actorId === state.controlledActorId,
  );
  return entity === undefined ? null : entityNodeId(entity.entityId);
}

/**
 * Create a fresh bridge. `stepDurationMs` is the interpolation duration attached
 * to `transform.setTarget` (defaults to {@link DEFAULT_STEP_DURATION_MS}).
 *
 * ## Emitted command order (part of the contract)
 *
 * `RenderFrame` is applied **in order**, so the order is deterministic and
 * documented:
 *
 * 1. block creates (`node.create` per new block), chunk-major then `y`/`z`/`x`;
 * 2. entity creates (`node.create` per new entity), sorted by `entityId`;
 * 3. entity object-layer commands (`transform.setTarget` / `animation.play` /
 *    `visibility.set` / `appearance.set`), sorted by `entityId`;
 * 4. block appearance / orientation changes (`appearance.set` / `transform.set`),
 *    chunk-major then `y`/`z`/`x`;
 * 5. block destroys (`node.destroy` per removed block), chunk-major then `y`/`z`/`x`;
 * 6. entity destroys (`node.destroy` per removed entity), sorted by `entityId`.
 *
 * Why this shape: every create is emitted before any update/destroy in the same
 * frame, every phase is a pure function of coordinates or ids, and blocks are
 * emitted chunk-by-chunk so a chunk can be replaced as a unit. A
 * `transform.setTarget` is emitted when an entity's authoritative **position or
 * rotation** changed, so an authoritative heading turn is applied even when the
 * position is static. `animation.play walk` is emitted only when the **position**
 * changed: turning in place is not a step.
 */
export function createRenderBridge(options?: { stepDurationMs?: number }): RenderBridge {
  const stepDurationMs = options?.stepDurationMs ?? DEFAULT_STEP_DURATION_MS;
  const knownEntities = new Map<string, KnownEntity>();
  const knownBlocks = new Map<string, KnownBlock>();
  // Identity of the world the known-node maps describe. `undefined` means "no
  // frame has been produced yet"; `null` is a real (pre-ready) world id.
  let knownWorldId: string | null | undefined;

  /** Forget every known node so the next frame re-creates all of them. */
  function forgetAll(): void {
    knownEntities.clear();
    knownBlocks.clear();
    knownWorldId = undefined;
  }

  return {
    frameFor(state: WorldState): RenderFrame {
      const commands: RenderCommand[] = [];
      const sortedBlocks = [...state.blocks]
        .filter((block) => block.kind !== 'air')
        .sort(compareBlocksForRender);
      const sortedEntities = [...state.entities].sort(byEntityId);

      // A change of `worldId` means every known node belongs to a different
      // world. Node ids are derived from coordinate/entity identity, so a new
      // world can reuse `block:<cell>` / `entity:<id>` for a DIFFERENT node;
      // diffing against the old world would emit `transform.setTarget` and make
      // the actor interpolate out of its previous world instead of snapping in.
      let previousBlockKeys: readonly string[] = [];
      let previousEntityIds: readonly string[] = [];
      if (knownWorldId !== state.worldId) {
        previousBlockKeys = [...knownBlocks.keys()];
        previousEntityIds = [...knownEntities.keys()];
        forgetAll();
        knownWorldId = state.worldId;
      }

      // 1. Block creates: first sight of an absolute cell. The world position is
      //    already authoritative in the view model (derived by the Organizer with
      //    the frozen `cellCentre` rule).
      const seenBlocks = new Set<string>();
      for (const block of sortedBlocks) {
        const key = blockKey(block.coord);
        seenBlocks.add(key);
        if (knownBlocks.has(key)) {
          continue;
        }
        commands.push({
          type: 'node.create',
          layer: 'object',
          nodeId: blockNodeId(block.coord),
          appearance: blockAppearanceFor(block.kind),
          transform: renderTransform(block.position, yawQuat(block.orientation)),
          visible: true,
        });
        knownBlocks.set(key, {
          kind: block.kind,
          orientation: block.orientation,
          position: { ...block.position },
        });
      }

      // 2. Entity creates: first sight of an entity.
      const seenEntities = new Set<string>();
      for (const entity of sortedEntities) {
        const nodeId = entityNodeId(entity.entityId);
        const appearance = entityAppearanceFor(entity.kind);
        const transform = renderTransform(entity.position, entity.rotation);
        seenEntities.add(entity.entityId);
        if (knownEntities.has(entity.entityId)) {
          continue;
        }
        commands.push({
          type: 'node.create',
          layer: 'object',
          nodeId,
          appearance,
          transform,
          visible: entity.visible,
        });
        knownEntities.set(entity.entityId, {
          appearance,
          position: { ...transform.position },
          rotation: { ...transform.rotation },
          visible: entity.visible,
        });
      }

      // 3. Entity updates: transform interpolation, animation, visibility,
      //    appearance. Sorted by entityId.
      for (const entity of sortedEntities) {
        const previous = knownEntities.get(entity.entityId);
        if (previous === undefined) {
          continue;
        }
        const nodeId = entityNodeId(entity.entityId);
        const appearance = entityAppearanceFor(entity.kind);
        const transform = renderTransform(entity.position, entity.rotation);
        const positionChanged = !sameVec3(previous.position, entity.position);
        const rotationChanged = !sameQuat(previous.rotation, entity.rotation);

        if (positionChanged || rotationChanged) {
          commands.push({
            type: 'transform.setTarget',
            nodeId,
            transform,
            durationMs: stepDurationMs,
          });
          previous.position = { ...transform.position };
          previous.rotation = { ...transform.rotation };
          // A change of authoritative POSITION is a visual move, so the actor
          // walks. A pure heading turn is applied but is not a step. The runtime
          // resets to its rest animation when the interpolation completes; the
          // bridge does not emit a settle.
          if (positionChanged) {
            commands.push({
              type: 'animation.play',
              nodeId,
              animation: ANIMATION_WALK,
              loop: true,
            });
          }
        }

        if (previous.visible !== entity.visible) {
          commands.push({ type: 'visibility.set', nodeId, visible: entity.visible });
          previous.visible = entity.visible;
        }

        if (previous.appearance !== appearance) {
          commands.push({ type: 'appearance.set', nodeId, appearance });
          previous.appearance = appearance;
        }
      }

      // 4. Block updates: an appearance swap for a changed kind and a
      //    `transform.set` for a changed orientation (blocks are static
      //    geometry, so an orientation change snaps rather than interpolates).
      for (const block of sortedBlocks) {
        const key = blockKey(block.coord);
        const previous = knownBlocks.get(key);
        if (previous === undefined) {
          continue;
        }
        if (previous.kind !== block.kind) {
          commands.push({
            type: 'appearance.set',
            nodeId: blockNodeId(block.coord),
            appearance: blockAppearanceFor(block.kind),
          });
          previous.kind = block.kind;
        }
        if (previous.orientation !== block.orientation) {
          commands.push({
            type: 'transform.set',
            nodeId: blockNodeId(block.coord),
            transform: renderTransform(block.position, yawQuat(block.orientation)),
          });
          previous.orientation = block.orientation;
        }
        if (!sameVec3(previous.position, block.position)) {
          // The Organizer derives the centre from the grid; a grid change is a
          // fresh snapshot, but this keeps a direct/looser caller correct.
          commands.push({
            type: 'transform.set',
            nodeId: blockNodeId(block.coord),
            transform: renderTransform(block.position, yawQuat(block.orientation)),
          });
          previous.position = { ...block.position };
        }
      }

      // 5. Block destroys: absolute cells that disappeared. After a world switch
      //    the previous world's blocks are considered here too, minus any the new
      //    world re-created. Ordered chunk-major then `y`/`z`/`x`, like creates.
      const removedBlockKeys = [
        ...[...knownBlocks.keys()].filter((key) => !seenBlocks.has(key)),
        ...previousBlockKeys.filter((key) => !seenBlocks.has(key)),
      ];
      removedBlockKeys.sort((a, b) =>
        compareBlocksForRender(
          { coord: cellOfBlockKey(a), position: { x: 0, y: 0, z: 0 }, kind: '', orientation: 0 },
          { coord: cellOfBlockKey(b), position: { x: 0, y: 0, z: 0 }, kind: '', orientation: 0 },
        ),
      );
      for (const key of removedBlockKeys) {
        commands.push({ type: 'node.destroy', nodeId: `${BLOCK_NODE_PREFIX}${key}` as NodeId });
        knownBlocks.delete(key);
      }

      // 6. Entity destroys: entities that disappeared, in id order.
      const removedEntities = [
        ...[...knownEntities.keys()].filter((entityId) => !seenEntities.has(entityId)),
        ...previousEntityIds.filter((entityId) => !seenEntities.has(entityId)),
      ].sort();
      for (const entityId of removedEntities) {
        commands.push({ type: 'node.destroy', nodeId: entityNodeId(entityId) });
        knownEntities.delete(entityId);
      }

      return commands;
    },

    reset(): void {
      forgetAll();
    },
  };
}

/** Parse an `x,y,z` block key back into an integer cell (ordering only). */
function cellOfBlockKey(key: string): { x: number; y: number; z: number } {
  const parts = key.split(',');
  return { x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) };
}
