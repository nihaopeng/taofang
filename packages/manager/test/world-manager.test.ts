import { describe, expect, it } from 'vitest';

import {
  cellOf,
  isGameEventBatch,
  isValidatePlacementResponse,
  isWorldSnapshot,
  parseActorId,
  parseEntityId,
} from '@starvalley/protocol';
import type { EntityState } from '@starvalley/protocol';
import { QUAT_IDENTITY } from '@starvalley/math';

import {
  INTERACTION_RANGE,
  InteractionRejectedError,
  UnknownActorError,
  UnknownEntityError,
  createWorldManager,
} from '../src/index.ts';
import {
  ACTOR_ID,
  actorOf,
  flatBlocks,
  makeManager,
  move,
  snapshotOf,
  stepMany,
} from './helpers.ts';

const OTHER_ACTOR = parseActorId('actor-other');

function entity(
  id: string,
  kind: EntityState['kind'],
  x: number,
  y: number,
  z: number,
): EntityState {
  return {
    entityId: parseEntityId(id),
    actorId: null,
    kind,
    transform: { position: { x, y, z }, rotation: { ...QUAT_IDENTITY } },
    visible: true,
  };
}

describe('v9 world snapshot', () => {
  it('is protocol-valid and contains every authored feature', () => {
    const manager = createWorldManager({ actorId: ACTOR_ID });
    const snapshot = snapshotOf(manager);
    expect(isWorldSnapshot(snapshot)).toBe(true);
    const kinds = new Set(snapshot.blocks.map((entry) => entry.kind));
    for (const kind of ['grass', 'slab', 'stairs', 'ramp', 'water', 'stone'] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
    const entityKinds = snapshot.entities.map((entry) => entry.kind);
    for (const kind of ['tree', 'rock', 'chest', 'building'] as const) {
      expect(entityKinds).toContain(kind);
    }
    expect(snapshot.controlledActorId).toBe(ACTOR_ID);
  });

  it('spawns the actor outside any solid block and above solid support', () => {
    const manager = createWorldManager({ actorId: ACTOR_ID });
    const snapshot = snapshotOf(manager);
    const actor = actorOf(manager);
    const cell = cellOf(snapshot.blockGrid, actor.transform.position);
    const solidAtFeet = snapshot.blocks.some(
      (entry) => entry.coord.x === cell.x && entry.coord.z === cell.z && entry.coord.y === cell.y,
    );
    expect(solidAtFeet).toBe(false);
    // Ground support exists directly beneath the actor.
    const support = snapshot.blocks.some(
      (entry) =>
        entry.coord.x === cell.x &&
        entry.coord.z === cell.z &&
        entry.coord.y < cell.y &&
        entry.kind === 'grass',
    );
    expect(support).toBe(true);
  });

  it('rejects an unknown actor', () => {
    const manager = createWorldManager({ actorId: ACTOR_ID });
    expect(() => manager.getSnapshot({ actorId: OTHER_ACTOR })).toThrow(UnknownActorError);
    expect(() => manager.submitIntent({ actorId: OTHER_ACTOR, command: move({ x: 1, z: 0 }) })).toThrow(
      UnknownActorError,
    );
  });
});

describe('command responses', () => {
  it('submitIntent returns a CommandResponse: batches for world commands, a preview for validate', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    const batch = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'block.set', coord: { x: 0, y: 1, z: 0 }, kind: 'stone', orientation: 0 },
    });
    expect(isGameEventBatch(batch)).toBe(true);

    const preview = manager.submitIntent({
      actorId: ACTOR_ID,
      command: {
        type: 'entity.validatePlacement',
        kind: 'chest',
        position: { x: 4.5, y: 1, z: 4.5 },
        yawDegrees: 0,
      },
    });
    expect(isValidatePlacementResponse(preview)).toBe(true);
    if (!('valid' in preview)) throw new Error('expected preview');
    expect(preview.valid).toBe(true);
  });
});

describe('interaction', () => {
  it('accepts an in-range interactable and turns to face it', () => {
    const manager = makeManager({
      blocks: flatBlocks(8, 8),
      entities: [entity('tree-1', 'tree', 3.5, 1, 1.5)],
      spawnCell: { x: 2, z: 1 },
    });
    const response = manager.submitIntent({
      actorId: ACTOR_ID,
      command: { type: 'actor.interact', targetEntityId: parseEntityId('tree-1') },
    });
    if (!isGameEventBatch(response)) throw new Error('expected batch');
    expect(response.events[0]).toMatchObject({ type: 'transform.changed' });
  });

  it('rejects an out-of-range target', () => {
    const manager = makeManager({
      blocks: flatBlocks(8, 8),
      entities: [entity('tree-1', 'tree', 6.5, 1, 1.5)],
      spawnCell: { x: 1, z: 1 },
    });
    expect(() =>
      manager.submitIntent({
        actorId: ACTOR_ID,
        command: { type: 'actor.interact', targetEntityId: parseEntityId('tree-1') },
      }),
    ).toThrow(InteractionRejectedError);
    expect(INTERACTION_RANGE).toBe(1.5);
  });

  it('rejects a non-interactable kind and an unknown entity', () => {
    const manager = makeManager({
      blocks: flatBlocks(8, 8),
      entities: [entity('building-1', 'building', 2.5, 1, 1.5)],
      spawnCell: { x: 1, z: 1 },
    });
    expect(() =>
      manager.submitIntent({
        actorId: ACTOR_ID,
        command: { type: 'actor.interact', targetEntityId: parseEntityId('building-1') },
      }),
    ).toThrow(InteractionRejectedError);
    expect(() =>
      manager.submitIntent({
        actorId: ACTOR_ID,
        command: { type: 'actor.interact', targetEntityId: parseEntityId('missing') },
      }),
    ).toThrow(UnknownEntityError);
  });
});

describe('jump', () => {
  it('sets upward velocity only when grounded and lands back on the ground', () => {
    const manager = makeManager({ blocks: flatBlocks(8, 8), spawnCell: { x: 1, z: 1 } });
    const response = manager.submitIntent({ actorId: ACTOR_ID, command: { type: 'actor.jump' } });
    if (!isGameEventBatch(response)) throw new Error('expected batch');
    expect(response.events).toEqual([]);

    let aboveGround = false;
    for (let i = 0; i < 12; i += 1) {
      manager.step(50);
      if (actorOf(manager).transform.position.y > 1.1) {
        aboveGround = true;
      }
    }
    expect(aboveGround).toBe(true);
    stepMany(manager, 60);
    expect(actorOf(manager).transform.position.y).toBeCloseTo(1, 6);
  });
});
