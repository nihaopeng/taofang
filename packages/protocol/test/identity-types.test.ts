import { describe, expect, it } from 'vitest';

import { parseActorId, parseEntityId, parsePlayerId } from '../src/index.ts';
import type { ActorId, EntityId, PlayerId } from '../src/index.ts';

/**
 * Type-level test for nominal identity. `tsc` is what enforces this file: the
 * `@ts-expect-error` comments below fail the build if the branded types ever
 * become mutually assignable, or assignable from a plain `string`.
 *
 * The runtime assertions keep the declarations live so `noUnusedLocals` and
 * Vitest both see a real test suite.
 */

// Positive direction: only the `parse*` helpers produce a branded id.
const actorId: ActorId = parseActorId('actor-1');
const playerId: PlayerId = parsePlayerId('player-1');
const entityId: EntityId = parseEntityId('entity-1');

// A plain string is not any of the branded ids.
// @ts-expect-error a plain string is not assignable to ActorId
const plainAsActor: ActorId = 'x';
// @ts-expect-error a plain string is not assignable to PlayerId
const plainAsPlayer: PlayerId = 'x';
// @ts-expect-error a plain string is not assignable to EntityId
const plainAsEntity: EntityId = 'x';

// The brands are mutually non-assignable.
// @ts-expect-error ActorId is not assignable to PlayerId
const actorAsPlayer: PlayerId = actorId;
// @ts-expect-error ActorId is not assignable to EntityId
const actorAsEntity: EntityId = actorId;
// @ts-expect-error PlayerId is not assignable to ActorId
const playerAsActor: ActorId = playerId;
// @ts-expect-error EntityId is not assignable to ActorId
const entityAsActor: ActorId = entityId;

describe('identity nominal typing', () => {
  it('carries branded ids as plain strings at runtime', () => {
    expect(actorId).toBe('actor-1');
    expect(playerId).toBe('player-1');
    expect(entityId).toBe('entity-1');
    expect(typeof actorId).toBe('string');
  });

  it('keeps the suppressed negative cases live at runtime', () => {
    expect(plainAsActor).toBe('x');
    expect(plainAsPlayer).toBe('x');
    expect(plainAsEntity).toBe('x');
    expect(actorAsPlayer).toBe('actor-1');
    expect(actorAsEntity).toBe('actor-1');
    expect(playerAsActor).toBe('player-1');
    expect(entityAsActor).toBe('entity-1');
  });
});
