import { parseActorId } from '@starvalley/protocol';
import type {
  ActorId,
  BlockKind,
  BlockOrientation,
  BlockState,
  EntityState,
  GameCommand,
  WorldSnapshot,
} from '@starvalley/protocol';

import { createWorldManager } from '../src/index.ts';
import type { CreateWorldManagerDeps, WorldManager } from '../src/index.ts';

export const ACTOR_ID: ActorId = parseActorId('actor-1');

/** Build one block state. */
export function block(
  x: number,
  y: number,
  z: number,
  kind: BlockKind,
  orientation: BlockOrientation = 0,
): BlockState {
  return { coord: { x, y, z }, kind, orientation };
}

/** A flat ground layer of `width x depth` cells at `y = 0`. */
export function flatBlocks(
  width: number,
  depth: number,
  kind: BlockKind = 'grass',
): BlockState[] {
  const blocks: BlockState[] = [];
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      blocks.push(block(x, 0, z, kind));
    }
  }
  return blocks;
}

/** Create a manager over a simple, test-controlled world. */
export function makeManager(deps: CreateWorldManagerDeps = {}): WorldManager {
  return createWorldManager({
    grid: { origin: { x: 0, y: 0, z: 0 }, cellSize: 1 },
    ...deps,
  });
}

export function snapshotOf(manager: WorldManager): WorldSnapshot {
  return manager.getSnapshot({ actorId: ACTOR_ID });
}

/** The controlled actor entity (always delivered first). */
export function actorOf(manager: WorldManager): EntityState {
  return snapshotOf(manager).entities[0];
}

export function stepMany(manager: WorldManager, ticks: number, dtMs = 50): void {
  for (let i = 0; i < ticks; i += 1) {
    manager.step(dtMs);
  }
}

export function move(movement: { x: number; z: number }): GameCommand {
  return { type: 'actor.moveIntent', movement };
}

export function moveTo(target: { x: number; y: number; z: number }): GameCommand {
  return { type: 'actor.moveTo', target };
}
