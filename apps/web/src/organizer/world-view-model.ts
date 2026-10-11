/**
 * UI-facing view models for the world/actor feature.
 *
 * Deliberately narrower than the Protocol `WorldSnapshot`: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. `MoveDirection` is re-exported here so the UI can express intent
 * without importing `@starvalley/protocol`.
 *
 * After the Phase-3 identity migration the controlled subject is an **Actor**,
 * not a player. The view model carries the `actorId` string so the UI can
 * identify which actor it controls once more than one actor exists, without
 * importing the Protocol branded type. The current UI renders only the actor's
 * name and position.
 */

import type {
  Actor,
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

/** Presentation-ready actor the client currently controls, with its authoritative tile position. */
export interface ControlledActorViewModel {
  actorId: string;
  name: string;
  x: number;
  y: number;
}

/** Map the `size` field of a validated Protocol `WorldSnapshot` into the view model. */
export function toWorldViewModel(snapshot: WorldSnapshot): WorldViewModel {
  return { width: snapshot.size.width, height: snapshot.size.height };
}

/** Map a validated Protocol `Actor` into the view model. */
export function toControlledActorViewModel(actor: Actor): ControlledActorViewModel {
  return {
    actorId: actor.actorId,
    name: actor.name,
    x: actor.position.x,
    y: actor.position.y,
  };
}
