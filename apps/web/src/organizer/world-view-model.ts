/**
 * UI-facing view models for the world feature.
 *
 * Deliberately narrower than the Protocol `WorldSnapshot`: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. `MoveDirection` is re-exported here so the UI can express intent
 * without importing `@starvalley/protocol`.
 *
 * The world is now primitive-driven: the UI needs the *tile* and *entity* lists to
 * render, so the view model exposes one presentation-ready `TileViewModel` per
 * authoritative `TileState` and one `EntityViewModel` per `EntityState`, plus the
 * `controlledActorId` saying which actor the caller controls.
 *
 * Terrain stays an **opaque string** at this boundary: mapping a terrain kind to
 * an appearance is the UI/bridge's job, and whether a terrain is walkable is an
 * authoritative Manager rule. The Organizer deliberately encodes neither, so no
 * gameplay or collision rule can leak into client state.
 *
 * Order is normalised deterministically — entities by `entityId`, tiles by `y`
 * then `x` — so each array is a stable function of the server state rather than
 * of wire iteration order.
 */

import type {
  EntityState,
  MoveDirection as ProtocolMoveDirection,
  TileState,
  WorldSnapshot,
} from '@starvalley/protocol';

/** Cardinal movement direction understood by the UI. */
export type MoveDirection = ProtocolMoveDirection;

/** Presentation-ready world dimensions. */
export interface WorldViewModel {
  width: number;
  height: number;
}

/** Presentation-ready static terrain tile. `terrain` stays an opaque string. */
export interface TileViewModel {
  x: number;
  y: number;
  terrain: string;
}

/** Presentation-ready world object. `kind` stays a plain string at the UI boundary. */
export interface EntityViewModel {
  entityId: string;
  actorId: string | null;
  kind: string;
  x: number;
  y: number;
  visible: boolean;
}

/** Map the `size` field of a validated Protocol `WorldSnapshot` into the view model. */
export function toWorldViewModel(snapshot: WorldSnapshot): WorldViewModel {
  return { width: snapshot.size.width, height: snapshot.size.height };
}

/**
 * Map a validated Protocol `TileState` into a presentation-ready view model.
 *
 * `terrain` is passed through verbatim as an opaque string: the Organizer must not
 * interpret it (no appearance mapping, and above all no walkability rule).
 */
export function toTileViewModel(tile: TileState): TileViewModel {
  return { x: tile.transform.x, y: tile.transform.y, terrain: tile.terrain };
}

/**
 * Deterministic tile order: ascending by `y`, then ascending by `x`.
 *
 * Row-major order makes the array a stable function of the snapshot rather than
 * of the order tiles happened to cross the wire in.
 */
export function compareTileViewModels(a: TileViewModel, b: TileViewModel): number {
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.x - b.x;
}

/** Map and order a validated tile list into presentation-ready view models. */
export function toTileViewModels(tiles: readonly TileState[]): TileViewModel[] {
  return tiles.map(toTileViewModel).sort(compareTileViewModels);
}

/** Map a validated Protocol `EntityState` into a presentation-ready view model. */
export function toEntityViewModel(entity: EntityState): EntityViewModel {
  return {
    entityId: entity.entityId,
    actorId: entity.actorId,
    kind: entity.kind,
    x: entity.transform.x,
    y: entity.transform.y,
    visible: entity.visible,
  };
}

/** Deterministic entity order: ascending by `entityId`. */
export function compareEntityViewModels(a: EntityViewModel, b: EntityViewModel): number {
  if (a.entityId < b.entityId) {
    return -1;
  }
  if (a.entityId > b.entityId) {
    return 1;
  }
  return 0;
}

/** Map and order a validated entity list into presentation-ready view models. */
export function toEntityViewModels(entities: readonly EntityState[]): EntityViewModel[] {
  return entities.map(toEntityViewModel).sort(compareEntityViewModels);
}
