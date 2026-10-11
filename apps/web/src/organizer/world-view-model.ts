/**
 * UI-facing view models for the world feature.
 *
 * Deliberately narrower than the Protocol `WorldSnapshot`: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. `MoveDirection` is re-exported here so the UI can express intent
 * without importing `@starvalley/protocol`.
 *
 * The world is now primitive-driven: the UI needs the *entity list* to render, so
 * the view model exposes one presentation-ready `EntityViewModel` per authoritative
 * `EntityState`, plus the `controlledActorId` saying which actor the caller controls.
 * Entity order is normalised deterministically (by `entityId`) so the array is a
 * stable function of the server state rather than of wire iteration order.
 */

import type {
  EntityState,
  MoveDirection as ProtocolMoveDirection,
  WorldSnapshot,
} from '@starvalley/protocol';

/** Cardinal movement direction understood by the UI. */
export type MoveDirection = ProtocolMoveDirection;

/** Presentation-ready world dimensions. */
export interface WorldViewModel {
  width: number;
  height: number;
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
