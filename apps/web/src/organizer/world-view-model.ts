/**
 * UI-facing view models for the world/player feature.
 *
 * Deliberately narrower than the Protocol `WorldSnapshot`: the UI never sees wire
 * fields it does not render (e.g. `serverTime`), and it never depends on Protocol
 * types directly. `MoveDirection` is re-exported here so the UI can express intent
 * without importing `@starvalley/protocol`.
 */

import type { MoveDirection as ProtocolMoveDirection, Player, WorldSnapshot } from '@starvalley/protocol';

/** Cardinal movement direction understood by the UI. */
export type MoveDirection = ProtocolMoveDirection;

/** Presentation-ready world dimensions. */
export interface WorldViewModel {
  width: number;
  height: number;
}

/** Presentation-ready local player with its authoritative tile position. */
export interface PlayerViewModel {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** Map the `size` field of a validated Protocol `WorldSnapshot` into the view model. */
export function toWorldViewModel(snapshot: WorldSnapshot): WorldViewModel {
  return { width: snapshot.size.width, height: snapshot.size.height };
}

/** Map a validated Protocol `Player` into the view model. */
export function toPlayerViewModel(player: Player): PlayerViewModel {
  return { id: player.id, name: player.name, x: player.position.x, y: player.position.y };
}
