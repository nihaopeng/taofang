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
 * - No terrain -> walkability rule. `terrain` is an opaque presentation input:
 *   mapping it to an appearance is presentation, but whether it is walkable is
 *   an authoritative Manager rule the client must never infer.
 *
 * Phase 7: the world is continuous 3D
 * ----------------------------------
 * A tile view model already carries its derived **world position** (the
 * Organizer owns the grid -> world formula), and an entity carries an
 * authoritative 3D `position` + `rotation`. The bridge maps those through
 * unchanged into `RenderTransform { position, rotation, scale }`: there is **no
 * tile -> scene mapping** and no coordinate-system conversion anywhere on the
 * client. `transform.setTarget` still means "interpolate toward this transform",
 * and its default duration is close to the authoritative 20 Hz tick period
 * (50 ms) so continuous movement renders smoothly at 60 fps.
 *
 * When `animation.play` is emitted (documented driving state)
 * ---------------------------------------------------------
 * The bridge owns the **vocabulary** only — it emits `walk` on a frame where the
 * authoritative **position** changed (the same frame as `transform.setTarget`).
 * It deliberately does **not** emit a settle animation: the runtime interpolates
 * to the target, so the runtime owns WHEN the move is over and returns the node
 * to its prefab's `defaultAnimation` when that interpolation completes. A
 * client-side settle emission would also be unreachable: the world store is
 * event-driven, so after the last move no further frame arrives for the bridge to
 * observe the settle.
 *
 * Identity: a render `NodeId` is derived from game identity, but the two are
 * deliberately different types. The renderer must not be able to read game
 * identity (it receives only `NodeId`); game identity stops here. Tile and entity
 * ids are **namespaced** (`tile:<cellX>,<cellZ>` / `entity:<entityId>`) so a tile
 * can never collide with an entity whose id happens to look like a coordinate.
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

import type { WorldState } from '../organizer';

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

/** The neutral rotation/scale applied where the source has no meaningful value. */
const IDENTITY_ROTATION: Quat = { x: 0, y: 0, z: 0, w: 1 };
const UNIT_SCALE: Vec3 = { x: 1, y: 1, z: 1 };

/**
 * Appearance catalogue: game `kind` -> opaque render `AppearanceId`.
 *
 * The runtime owns what an appearance id *looks like*; the bridge only chooses
 * the id. Adding an entity kind is a game-protocol change; the bridge gains an
 * entry here independently.
 *
 * Like terrain, an unknown kind is **not** reachable through the real
 * transport: the Organizer validates every entity against the closed
 * `EntityKind` union before a frame is built, so an unknown kind rejects there
 * and the client settles into `error`. The fallback is defence-in-depth for
 * direct or looser callers of the bridge.
 */
const APPEARANCE_BY_KIND: Readonly<Record<string, AppearanceId>> = {
  character: asAppearanceId('appearance.character'),
  tree: asAppearanceId('appearance.tree'),
};

/**
 * Appearance catalogue: server terrain string -> opaque render `AppearanceId`.
 *
 * `terrain` is an opaque string at the bridge boundary, but nothing the real
 * transport delivers is absent from this catalogue: the Organizer's world guard
 * validates every tile against the closed `TerrainKind` union before a frame is
 * built, so an unknown terrain rejects there and the client settles into `error`
 * without the bridge ever seeing it. The fallback is therefore defence-in-depth
 * for direct or looser callers, not for a value the server can deliver through
 * the transport.
 */
const APPEARANCE_BY_TERRAIN: Readonly<Record<string, AppearanceId>> = {
  grass: asAppearanceId('appearance.terrain.grass'),
  path: asAppearanceId('appearance.terrain.path'),
  blocked: asAppearanceId('appearance.terrain.blocked'),
  water: asAppearanceId('appearance.terrain.water'),
};

/**
 * Every terrain key the bridge renders with a real (non-fallback) appearance.
 *
 * Exported so a cross-module coverage assertion can pin that every terrain the
 * real server can send is a key here: a new terrain silently falling through to
 * the fallback is exactly the bug this export exists to make impossible. It is
 * derived from the catalogue, so it cannot drift.
 */
export const BRIDGE_TERRAINS: readonly string[] = Object.freeze(
  Object.keys(APPEARANCE_BY_TERRAIN),
);

/**
 * Documented fallback for a value the catalogue does not know (an entity `kind`
 * or a tile `terrain`).
 *
 * Neither unknown value is reachable through the real transport: the Organizer
 * validates every kind and terrain against its closed union before a frame is
 * built, so an unknown value rejects there and the client settles into `error`.
 * This fallback is defence-in-depth for direct or looser callers of the bridge;
 * it keeps such a value rendering as a visible "unknown" look rather than
 * throwing or silently blanking.
 */
export const FALLBACK_APPEARANCE: AppearanceId = asAppearanceId('appearance.fallback');

/**
 * Every appearance id the bridge can emit: one per known kind, one per known
 * terrain, plus the fallback.
 *
 * Exported so the runtime can bind its own colour catalogue to it: a rename on
 * either side becomes a test failure instead of a silent fallback colour. A new
 * kind or terrain added above grows this list automatically.
 */
export const BRIDGE_APPEARANCES: readonly AppearanceId[] = [
  ...new Set([
    ...Object.values(APPEARANCE_BY_KIND),
    ...Object.values(APPEARANCE_BY_TERRAIN),
    FALLBACK_APPEARANCE,
  ]),
];

/**
 * The Render ISA ships branded id *types* only (no runtime constructors), so the
 * bridge performs the branding at the one point where it is legitimate: the
 * Organizer/ISA boundary. Downstream, a `NodeId` is opaque.
 *
 * Ids are namespaced by kind so the two collections can never collide. A tile's
 * cell coordinate is part of its *identity* here; it is not a scene mapping.
 */
function tileNodeId(cellX: number, cellZ: number): NodeId {
  return `tile:${cellX},${cellZ}` as NodeId;
}

function entityNodeId(entityId: string): NodeId {
  return `entity:${entityId}` as NodeId;
}

/** Key for the internal tile bookkeeping; the cell coordinate is the tile's identity. */
function tileKey(cellX: number, cellZ: number): string {
  return `${cellX},${cellZ}`;
}

function asAppearanceId(value: string): AppearanceId {
  return value as AppearanceId;
}

/** Resolve the catalogue appearance for a kind, falling back for unknown kinds. */
function appearanceForKind(kind: string): AppearanceId {
  return APPEARANCE_BY_KIND[kind] ?? FALLBACK_APPEARANCE;
}

/** Resolve the catalogue appearance for a terrain, falling back for unknown values. */
function appearanceForTerrain(terrain: string): AppearanceId {
  return APPEARANCE_BY_TERRAIN[terrain] ?? FALLBACK_APPEARANCE;
}

/**
 * Build a Render ISA transform from a view-model world position/rotation.
 *
 * Phase 7's `RenderTransform` is a real 3D transform (`position`, `rotation`,
 * `scale`). The bridge maps the Organizer's world values through **unchanged**:
 * no tile interpretation, no axis flipping, no coordinate conversion.
 */
function renderTransform(position: Vec3, rotation: Quat): RenderTransform {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    // Scale has no gameplay semantics yet; the ISA carries it, the bridge leaves it neutral.
    scale: { x: UNIT_SCALE.x, y: UNIT_SCALE.y, z: UNIT_SCALE.z },
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

/** The render state the bridge believes exists for one tile node. */
interface KnownTile {
  cellX: number;
  cellZ: number;
  position: Vec3;
  terrain: string;
}

/**
 * Deterministic ascending order by `entityId`. The Organizer already normalises
 * entity order, but the bridge does not rely on it: the frame's command order is
 * part of its contract.
 */
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

/** Deterministic tile order: ascending by `cellZ`, then `cellX` (row-major). */
function byCell(a: { cellX: number; cellZ: number }, b: { cellX: number; cellZ: number }): number {
  return a.cellZ - b.cellZ || a.cellX - b.cellX;
}

/** Stateful mapper from `WorldState` to ordered render frames. */
export interface RenderBridge {
  /**
   * Produce the diff needed to move the runtime from its previous frame to this
   * state. A change of `WorldState.worldId` is a full world switch: the known-node
   * memory is reset first, so every node is re-created (a snap) and any node the
   * new world does not contain is destroyed.
   */
  frameFor(state: WorldState): RenderFrame;
  /** Forget every known node, so the next call re-emits `node.create` for all tiles and entities. */
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
 * 1. base-layer creates (`node.create` for new tiles), sorted `cellZ` then `cellX`;
 * 2. object-layer commands (`node.create` for new entities, then per-entity
 *    `transform.setTarget` / `animation.play` / `visibility.set` /
 *    `appearance.set`), sorted by `entityId`;
 * 3. base-layer terrain changes (`appearance.set`), sorted `cellZ` then `cellX`;
 * 4. base-layer destroys (`node.destroy` for removed tiles), sorted `cellZ` then `cellX`;
 * 5. object-layer destroys (`node.destroy` for removed entities), sorted by
 *    `entityId`.
 *
 * Why this shape: all base-layer creation is a contiguous block emitted before
 * any object-layer creation, so a runtime that prepares object draw state (or
 * draw order) on top of the base can rely on the base existing first; every node
 * is created before any node in the same frame is destroyed, so a node that
 * leaves the world can never be recreated by a later command; and every phase is
 * a pure function of coordinates or ids, so the frame is byte-identical across
 * runs and input orderings.
 *
 * A `transform.setTarget` is emitted when the authoritative **position or
 * rotation** changed, so an authoritative heading turn is applied even when the
 * position is static. `animation.play walk` is emitted only when the **position**
 * changed: turning in place is not a step.
 */
export function createRenderBridge(options?: { stepDurationMs?: number }): RenderBridge {
  const stepDurationMs = options?.stepDurationMs ?? DEFAULT_STEP_DURATION_MS;
  const knownEntities = new Map<string, KnownEntity>();
  const knownTiles = new Map<string, KnownTile>();
  // Identity of the world the known-node maps describe. `undefined` means "no
  // frame has been produced yet"; `null` is a real (pre-ready) world id.
  let knownWorldId: string | null | undefined;

  /** Forget every known node so the next frame re-creates all of them. */
  function forgetAll(): void {
    knownEntities.clear();
    knownTiles.clear();
    knownWorldId = undefined;
  }

  return {
    frameFor(state: WorldState): RenderFrame {
      const commands: RenderCommand[] = [];
      const sortedTiles = [...state.tiles].sort(byCell);
      const sortedEntities = [...state.entities].sort(byEntityId);

      // A change of `worldId` means every known node belongs to a different
      // world. Node ids are derived from cell/entity identity, so a new world can
      // reuse `tile:<cellX>,<cellZ>` / `entity:<id>` for a DIFFERENT node; diffing
      // against the old world would emit `transform.setTarget` and make the
      // actor interpolate out of its previous world instead of snapping in.
      // Snapshot the old nodes (so any the new world does not contain are still
      // destroyed) and reset the maps so the diff below re-emits `node.create`
      // for every node of the new world.
      let previousTiles: readonly KnownTile[] = [];
      let previousEntityIds: readonly string[] = [];
      if (knownWorldId !== state.worldId) {
        previousTiles = [...knownTiles.values()];
        previousEntityIds = [...knownEntities.keys()];
        forgetAll();
        knownWorldId = state.worldId;
      }

      // 1. Base-layer creates: first sight of a tile. Its world position is
      //    already authoritative in the view model.
      const seenTiles = new Set<string>();
      for (const tile of sortedTiles) {
        const key = tileKey(tile.cellX, tile.cellZ);
        seenTiles.add(key);
        if (!knownTiles.has(key)) {
          commands.push({
            type: 'node.create',
            layer: 'base',
            nodeId: tileNodeId(tile.cellX, tile.cellZ),
            appearance: appearanceForTerrain(tile.terrain),
            transform: renderTransform(tile.position, IDENTITY_ROTATION),
            visible: true,
          });
          knownTiles.set(key, {
            cellX: tile.cellX,
            cellZ: tile.cellZ,
            position: tile.position,
            terrain: tile.terrain,
          });
        }
      }

      // 2. Object-layer commands: entity create/update diff.
      const seenEntities = new Set<string>();
      for (const entity of sortedEntities) {
        const nodeId = entityNodeId(entity.entityId);
        const appearance = appearanceForKind(entity.kind);
        const transform = renderTransform(entity.position, entity.rotation);
        seenEntities.add(entity.entityId);

        const previous = knownEntities.get(entity.entityId);

        if (previous === undefined) {
          // First sight: materialise the node with its authoritative transform.
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
          continue;
        }

        const positionChanged = !sameVec3(previous.position, entity.position);
        const rotationChanged = !sameQuat(previous.rotation, entity.rotation);

        if (positionChanged || rotationChanged) {
          // The new transform is authoritative; the runtime may interpolate to it.
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

      // 3. Base-layer terrain changes: a static tile whose terrain changed swaps
      //    appearance in place (it must not be recreated).
      for (const tile of sortedTiles) {
        const previous = knownTiles.get(tileKey(tile.cellX, tile.cellZ));
        if (previous === undefined || previous.terrain === tile.terrain) {
          continue;
        }
        commands.push({
          type: 'appearance.set',
          nodeId: tileNodeId(tile.cellX, tile.cellZ),
          appearance: appearanceForTerrain(tile.terrain),
        });
        previous.terrain = tile.terrain;
      }

      // 4. Base-layer destroys: tiles that disappeared. After a world switch the
      //    known map only holds the new world's tiles, so the previous world's
      //    tiles are considered here too, minus any the new world re-created.
      const removedTiles = [
        ...[...knownTiles.entries()].filter(([key]) => !seenTiles.has(key)),
        ...previousTiles
          .filter((tile) => !seenTiles.has(tileKey(tile.cellX, tile.cellZ)))
          .map((tile): [string, KnownTile] => [tileKey(tile.cellX, tile.cellZ), tile]),
      ].sort(([, a], [, b]) => byCell(a, b));
      for (const [key, tile] of removedTiles) {
        commands.push({ type: 'node.destroy', nodeId: tileNodeId(tile.cellX, tile.cellZ) });
        knownTiles.delete(key);
      }

      // 5. Object-layer destroys: entities that disappeared, in id order.
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
