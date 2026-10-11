/**
 * Organizer unit tests for the Phase-5 world feature (tiles + entities).
 *
 * Focuses on the client-application contract: request lifecycle, protocol
 * validation, authoritative-event reconciliation, static-terrain handling,
 * no-optimism, and deterministic command serialization. Transport mechanics are
 * injected through `setWorldFetch`.
 *
 * The client is event-driven: a command returns a `{ events, serverTime }` delta
 * and the store applies those events to its entity list. Tiles are static, so no
 * event carries terrain: they only ever change through a fresh snapshot. The move
 * body is exactly `{ type: 'actor.move', direction }`; no actor/player id and no
 * destination coordinate is ever sent.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMAND_PATH } from '@starvalley/protocol';
import type { GameEvent } from '@starvalley/protocol';

import {
  getWorldState,
  loadWorld,
  moveActor,
  resetWorldFetch,
  resetWorldState,
  setGameInfoFetch,
  setWorldFetch,
  subscribeWorld,
  useWorld,
} from '../src/organizer/index.ts';
import type { WorldState } from '../src/organizer/index.ts';
// Internal seam (not re-exported by the public organizer index); see the test
// below for why the applier's defensive tolerance is only observable here.
import { applyEvents } from '../src/organizer/world-store.ts';

const SERVER_TIME = '2025-01-02T03:04:05.000Z';

const ENTITY_A = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  transform: { x: 3, y: 4 },
  visible: true,
};

const ENTITY_B = {
  entityId: 'entity-b',
  actorId: null,
  kind: 'character',
  transform: { x: 1, y: 2 },
  visible: true,
};

const ENTITY_C = {
  entityId: 'entity-c',
  actorId: null,
  kind: 'character',
  transform: { x: 7, y: 7 },
  visible: true,
};

const ENTITY_A_VM = {
  entityId: 'entity-a',
  actorId: 'actor-1',
  kind: 'character',
  x: 3,
  y: 4,
  visible: true,
};

const ENTITY_B_VM = {
  entityId: 'entity-b',
  actorId: null,
  kind: 'character',
  x: 1,
  y: 2,
  visible: true,
};

// Deliberately scrambled wire order: the deterministic mapper must re-sort by
// `y` then `x` so the snapshot's tile array does not depend on iteration order.
const TILE_PATH = { transform: { x: 1, y: 0 }, terrain: 'path' };
const TILE_BLOCKED = { transform: { x: 0, y: 1 }, terrain: 'blocked' };
const TILE_GRASS = { transform: { x: 0, y: 0 }, terrain: 'grass' };

const TILE_GRASS_VM = { x: 0, y: 0, terrain: 'grass' };
const TILE_PATH_VM = { x: 1, y: 0, terrain: 'path' };
const TILE_BLOCKED_VM = { x: 0, y: 1, terrain: 'blocked' };
const ORDERED_TILES = [TILE_GRASS_VM, TILE_PATH_VM, TILE_BLOCKED_VM];

const WORLD_ID = 'world-main';

const VALID_SNAPSHOT = {
  worldId: WORLD_ID,
  size: { width: 10, height: 8 },
  tiles: [TILE_PATH, TILE_BLOCKED, TILE_GRASS],
  entities: [ENTITY_A, ENTITY_B],
  controlledActorId: 'actor-1',
  serverTime: SERVER_TIME,
};

const VALID_WORLD_RESPONSE = { world: VALID_SNAPSHOT };

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
}

/** Minimal `Response` stand-in: the organizer only reads `ok`, `status`, `json`. */
function fakeResponse(body: unknown, init: FakeResponseInit = {}): Response {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async (): Promise<unknown> => body,
  };
  return response as unknown as Response;
}

/** A promise whose settlement the test controls explicitly (no timers/sleeps). */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Build a valid `SubmitCommandResponse` body from a list of events. */
function commandResponse(events: unknown[]): unknown {
  return { events, serverTime: SERVER_TIME };
}

/** Build a valid `WorldSnapshot` with the given entities. */
function snapshotWith(entities: unknown[]): unknown {
  return { world: { ...VALID_SNAPSHOT, entities } };
}

function transformChanged(entityId: string, x: number, y: number): unknown {
  return { type: 'transform.changed', entityId, transform: { x, y } };
}

function entitySpawned(entity: unknown): unknown {
  return { type: 'entity.spawned', entity };
}

function entityRemoved(entityId: string): unknown {
  return { type: 'entity.removed', entityId };
}

/** Find an entity view model by id (throws if absent). */
function entity(state: WorldState, entityId: string) {
  const found = state.entities.find((candidate) => candidate.entityId === entityId);
  if (found === undefined) {
    throw new Error(`entity ${entityId} not present`);
  }
  return found;
}

/** Load a valid world so move tests start from a `ready` state. */
async function loadValidWorld(): Promise<void> {
  setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
  await loadWorld();
}

beforeEach(() => {
  resetWorldState();
  resetWorldFetch();
});

afterEach(() => {
  // Ensure a deferred/stubbed fetch can never leak into the next test.
  resetWorldFetch();
  resetWorldState();
});

describe('loadWorld', () => {
  it('maps worldId/tiles/entities and controlledActorId into ready state with no error', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(VALID_WORLD_RESPONSE);
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(calls).toBe(1);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.worldId).toBe(WORLD_ID);
    expect(state.world).toEqual({ width: 10, height: 8 });
    // One `TileViewModel` per tile, `terrain` preserved verbatim as an opaque string.
    expect(state.tiles).toEqual(ORDERED_TILES);
    expect(state.entities).toEqual([ENTITY_A_VM, ENTITY_B_VM]);
    expect(state.controlledActorId).toBe('actor-1');
  });

  it('orders tiles deterministically by y then x regardless of wire order', async () => {
    // The fixture crosses the wire as [path(1,0), blocked(0,1), grass(0,0)] and must
    // come out row-major: grass(0,0), path(1,0), blocked(0,1).
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));

    await loadWorld();

    expect(getWorldState().tiles).toEqual([
      { x: 0, y: 0, terrain: 'grass' },
      { x: 1, y: 0, terrain: 'path' },
      { x: 0, y: 1, terrain: 'blocked' },
    ]);
  });

  it('orders entities deterministically by entityId regardless of wire order', async () => {
    setWorldFetch(async () => fakeResponse(snapshotWith([ENTITY_B, ENTITY_A])));

    await loadWorld();

    expect(getWorldState().entities.map((entity) => entity.entityId)).toEqual([
      'entity-a',
      'entity-b',
    ]);
  });

  it('maps an uncontrolled actor as controlledActorId === null', async () => {
    setWorldFetch(async () =>
      fakeResponse({ world: { ...VALID_SNAPSHOT, controlledActorId: null } }),
    );

    await loadWorld();

    expect(getWorldState().status).toBe('ready');
    expect(getWorldState().controlledActorId).toBeNull();
  });

  it('maps a network rejection to an error state with no partial data', async () => {
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(loadWorld()).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.world).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
    expect(state.error).not.toContain('fetch');
  });

  it('maps a non-2xx response to an error that mentions the status', async () => {
    setWorldFetch(async () =>
      fakeResponse(
        { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        { ok: false, status: 503 },
      ),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.world).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toContain('503');
  });

  it('rejects an old snapshot with an `actor` key instead of `entities` and keeps no partial data', async () => {
    // Phase-3 shape: `{ world: { size, actor, serverTime } }`. It is structurally
    // invalid for the current `WorldSnapshot`, so the guard must reject it rather
    // than silently reading a missing `entities` field.
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          size: { width: 10, height: 8 },
          actor: { actorId: 'actor-1', name: 'Alex', position: { x: 3, y: 4 } },
          serverTime: SERVER_TIME,
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.world).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toBeTruthy();
  });

  it('rejects a phase-4-shaped snapshot missing `worldId`/`tiles` with no partial data', async () => {
    // Phase-4 shape: `{ world: { size, entities, controlledActorId, serverTime } }`.
    // `worldId` and `tiles` are required and keyed exactly, so this is a contract
    // failure: the store must not adopt the entities when the snapshot is not whole.
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          size: { width: 10, height: 8 },
          entities: [ENTITY_A, ENTITY_B],
          controlledActorId: 'actor-1',
          serverTime: SERVER_TIME,
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.world).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.error).toBeTruthy();
  });

  it('rejects a snapshot carrying an unknown extra tile key (no partial data)', async () => {
    // Tiles are keyed exactly and walkability is NOT on the wire; a stray
    // `walkable` field must fail validation rather than be silently ignored.
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          ...VALID_SNAPSHOT,
          tiles: [{ ...TILE_GRASS, walkable: true }],
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('rejects a renamed payload carrying `player` instead of `entities`', async () => {
    setWorldFetch(async () =>
      fakeResponse({
        world: {
          size: { width: 10, height: 8 },
          player: { id: 'player-1', name: 'Alex', position: { x: 3, y: 4 } },
          serverTime: SERVER_TIME,
        },
      }),
    );

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.worldId).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it('treats unparseable JSON as a contract failure', async () => {
    const badBody = {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    };
    setWorldFetch(async () => badBody as unknown as Response);

    await loadWorld();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('SyntaxError');
  });

  it('dedupes concurrent loads into a single fetch', async () => {
    let calls = 0;
    const deferred = createDeferred<Response>();
    setWorldFetch(() => {
      calls += 1;
      return deferred.promise;
    });

    const first = loadWorld();
    const second = loadWorld();

    expect(calls).toBe(1);
    expect(first).toBe(second);

    deferred.resolve(fakeResponse(VALID_WORLD_RESPONSE));
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(getWorldState().status).toBe('ready');
  });

  it('notifies subscribers synchronously across the lifecycle', async () => {
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next.status);
    });

    const settled = loadWorld();
    expect(seen).toEqual(['loading']);

    deferred.resolve(fakeResponse(VALID_WORLD_RESPONSE));
    await settled;
    expect(seen).toEqual(['loading', 'ready']);

    unsubscribe();
  });
});

describe('moveActor', () => {
  it('applies a transform.changed event to exactly that entity', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));

    await moveActor('east');

    const state = getWorldState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(entity(state, 'entity-a')).toMatchObject({ x: 4, y: 4 });
    // The other entity is untouched.
    expect(entity(state, 'entity-b')).toMatchObject({ x: 1, y: 2 });
  });

  it('keeps static tiles/worldId reference-identical across a move event', async () => {
    // No event carries terrain: only a fresh snapshot may replace `tiles`.
    await loadValidWorld();
    const before = getWorldState();
    setWorldFetch(async () => fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));

    await moveActor('east');

    const after = getWorldState();
    expect(after.entities).not.toBe(before.entities);
    expect(after.tiles).toBe(before.tiles);
    expect(after.worldId).toBe(before.worldId);
  });

  it('sends a body of exactly `{ type, direction }` to COMMAND_PATH with no actor or destination', async () => {
    await loadValidWorld();
    const requests: Array<{
      url: string;
      method: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    setWorldFetch(async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)]));
    });

    await moveActor('east');

    // Transport contract lives here, not in the UI tests: the Organizer builds
    // the primitive command itself and posts it to the canonical Protocol path.
    // The actor is resolved server-side from transport context, so the body must
    // NOT carry an actor/player id. The destination is computed by the Manager,
    // so the body must NOT carry a target coordinate either — a client cannot
    // submit a final position and thereby bypass collision.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(COMMAND_PATH);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ type: 'actor.move', direction: 'east' });
    expect(Object.keys(requests[0].body)).toEqual(['type', 'direction']);
    expect('actorId' in requests[0].body).toBe(false);
    expect('playerId' in requests[0].body).toBe(false);
    expect('x' in requests[0].body).toBe(false);
    expect('y' in requests[0].body).toBe(false);
    expect('position' in requests[0].body).toBe(false);
    expect('to' in requests[0].body).toBe(false);
  });

  it('does not move optimistically while the request is in flight', async () => {
    await loadValidWorld();
    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const pending = moveActor('east');

    // Position must still be the old authoritative one before the response.
    expect(entity(getWorldState(), 'entity-a')).toMatchObject({ x: 3, y: 4 });
    expect(getWorldState().status).toBe('ready');

    deferred.resolve(fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));
    await pending;

    expect(entity(getWorldState(), 'entity-a')).toMatchObject({ x: 4, y: 4 });
  });

  it('treats an empty events array (blocked step) as a no-op with no error and no state change', async () => {
    // A blocked step is expressed as a refusal: the server returns 200 with an
    // empty `events` array. That is NOT an error, and it must leave the whole
    // snapshot untouched — tiles, entities and worldId stay reference-identical.
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(commandResponse([])));

    const before = getWorldState();
    await moveActor('west');
    const after = getWorldState();

    expect(after).toBe(before);
    expect(after.tiles).toBe(before.tiles);
    expect(after.entities).toBe(before.entities);
    expect(after.worldId).toBe(before.worldId);
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(entity(after, 'entity-a')).toMatchObject({ x: 3, y: 4 });
  });

  it('applies an entity.spawned event to the entity list', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(commandResponse([entitySpawned(ENTITY_C)])));

    await moveActor('east');

    const state = getWorldState();
    expect(entity(state, 'entity-c')).toMatchObject({
      entityId: 'entity-c',
      actorId: null,
      kind: 'character',
      x: 7,
      y: 7,
      visible: true,
    });
    expect(state.entities.map((candidate) => candidate.entityId)).toEqual([
      'entity-a',
      'entity-b',
      'entity-c',
    ]);
  });

  it('applies an entity.removed event to the entity list', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse(commandResponse([entityRemoved('entity-b')])));

    await moveActor('east');

    const state = getWorldState();
    expect(state.entities.map((candidate) => candidate.entityId)).toEqual(['entity-a']);
  });

  it('ignores a transform.changed event for an unknown entity (creates nothing)', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(commandResponse([transformChanged('entity-missing', 9, 9)])),
    );

    const before = getWorldState();
    await moveActor('east');

    // Nothing observable changed, so the snapshot is reference-stable.
    expect(getWorldState()).toBe(before);
    expect(getWorldState().entities.map((candidate) => candidate.entityId)).toEqual([
      'entity-a',
      'entity-b',
    ]);
  });

  it('ignores an unknown event type at runtime without throwing or changing state', async () => {
    // The transport's Protocol guard rejects an unknown event `type` before it
    // reaches the applier, so this exercises the applier's `default` branch
    // directly. The object is cast through `unknown` only here, in the test:
    // production code must never fabricate a union member.
    await loadValidWorld();

    const unknownEvent = {
      type: 'entity.teleported',
      entityId: 'entity-a',
      transform: { x: 9, y: 9 },
    } as unknown as GameEvent;

    const before = getWorldState();

    // The applier's `default` branch contains `const exhaustive: never = event;`.
    // That `never` assignment is what makes adding a fourth `GameEvent` member a
    // COMPILE error at this applier until it is handled. At runtime an unknown
    // event is tolerated instead of thrown: no throw, and no observable change,
    // so the snapshot stays reference-stable.
    expect(() => {
      applyEvents([unknownEvent]);
    }).not.toThrow();

    const after = getWorldState();
    expect(after).toBe(before);
    expect(after.error).toBeNull();
    expect(entity(after, 'entity-a')).toMatchObject({ x: 3, y: 4 });
  });

  it('serializes moves with a single in-flight slot and latest wins', async () => {
    await loadValidWorld();

    const bodies: Array<Record<string, unknown>> = [];
    const deferreds = [createDeferred<Response>(), createDeferred<Response>()];
    let calls = 0;
    setWorldFetch((_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      const deferred = deferreds[calls];
      calls += 1;
      return deferred.promise;
    });

    const first = moveActor('east');
    const second = moveActor('south');
    const third = moveActor('west');

    // Only the first request is in flight; `south` was superseded by `west`.
    expect(calls).toBe(1);
    expect(bodies).toEqual([{ type: 'actor.move', direction: 'east' }]);

    deferreds[0].resolve(fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));
    await first;

    // Once the first settles, exactly one more request is sent, with the latest
    // queued direction.
    expect(calls).toBe(2);
    expect(bodies).toEqual([
      { type: 'actor.move', direction: 'east' },
      { type: 'actor.move', direction: 'west' },
    ]);
    expect(entity(getWorldState(), 'entity-a')).toMatchObject({ x: 4, y: 4 });

    deferreds[1].resolve(fakeResponse(commandResponse([transformChanged('entity-a', 3, 4)])));
    await Promise.all([second, third]);

    expect(calls).toBe(2);
    expect(entity(getWorldState(), 'entity-a')).toMatchObject({ x: 3, y: 4 });
  });

  it('settles every move promise when a reset supersedes an in-flight loop', async () => {
    // Regression: a superseded loop used to read and clear the shared queue
    // before checking its generation, then break and discard the waiters it had
    // just taken. A caller queued to the newer loop never settled and its
    // direction was silently lost. Losing the race must never hang a caller.
    await loadValidWorld();

    const deferreds = [
      createDeferred<Response>(),
      createDeferred<Response>(),
      createDeferred<Response>(),
    ];
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const captureMove = (_url: string, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      const deferred = deferreds[calls];
      calls += 1;
      return deferred.promise;
    };

    // Loop 1: `east` in flight.
    setWorldFetch(captureMove);
    const a = moveActor('east');
    expect(calls).toBe(1);

    // Reset supersedes loop 1 while its request is still in flight, then load a
    // fresh snapshot so a new loop can own the move slot.
    resetWorldState();
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await loadWorld();

    // Loop 2: `north` in flight; `west` queued behind it.
    setWorldFetch(captureMove);
    const c = moveActor('north');
    const d = moveActor('west');
    expect(calls).toBe(2);
    expect(bodies.map((body) => body.direction)).toEqual(['east', 'north']);

    // Settle loop 1's stale response. It must not consume loop 2's queue.
    deferreds[0].resolve(fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));
    await a;

    // Loop 2's current request settles and it must still dispatch the queued
    // `west` rather than have it dropped by the stale loop.
    deferreds[1].resolve(fakeResponse(commandResponse([transformChanged('entity-a', 4, 5)])));
    await c;
    expect(bodies.map((body) => body.direction)).toEqual(['east', 'north', 'west']);

    deferreds[2].resolve(fakeResponse(commandResponse([transformChanged('entity-a', 3, 5)])));
    await expect(d).resolves.toBeUndefined();
  });

  it('is a safe no-op before any world is loaded', async () => {
    let calls = 0;
    setWorldFetch(async () => {
      calls += 1;
      return fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)]));
    });

    await expect(moveActor('east')).resolves.toBeUndefined();

    expect(calls).toBe(0);
    const state = getWorldState();
    expect(state.status).toBe('idle');
    expect(state.worldId).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
  });

  it('maps a 404 command response to a user-presentable actor-not-found error', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(
        { error: { code: 'NOT_FOUND', message: 'unknown actor' } },
        { ok: false, status: 404 },
      ),
    );

    await expect(moveActor('east')).resolves.toBeUndefined();

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('404');
    expect(state.error?.toLowerCase()).toContain('actor');
    // The last authoritative entities are preserved on a command failure.
    expect(entity(state, 'entity-a')).toMatchObject({ x: 3, y: 4 });
  });

  it('maps a network failure during a move to an error state', async () => {
    await loadValidWorld();
    setWorldFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await moveActor('east');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
  });

  it('maps a malformed command payload to a contract error', async () => {
    await loadValidWorld();
    setWorldFetch(async () => fakeResponse({ result: { moved: true } }));

    await moveActor('east');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
  });

  it('maps a renamed event field (actorId instead of entityId) to a contract error', async () => {
    await loadValidWorld();
    setWorldFetch(async () =>
      fakeResponse(
        commandResponse([{ type: 'transform.changed', actorId: 'entity-a', transform: { x: 4, y: 4 } }]),
      ),
    );

    await moveActor('east');

    const state = getWorldState();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    // The stale event must not be reconciled into the entity list.
    expect(entity(state, 'entity-a')).toMatchObject({ x: 3, y: 4 });
  });
});

describe('world store identity and subscription', () => {
  it('returns a stable state reference while nothing changes', () => {
    const first = getWorldState();
    expect(getWorldState()).toBe(first);

    const unsubscribe = subscribeWorld(() => {});
    expect(getWorldState()).toBe(first);
    unsubscribe();
  });

  it('exposes `worldId`/`tiles`/`controlledActorId`/`entities` and has no legacy fields', () => {
    const state: WorldState = getWorldState();

    // Compile-level guarantee of the frozen Organizer contract: the phase-3
    // `controlledActor` and phase-2 `player` fields were removed, so these
    // accesses must not typecheck.
    // @ts-expect-error WorldState has no `controlledActor` field after the primitive migration.
    expect(state.controlledActor).toBeUndefined();
    // @ts-expect-error WorldState has no `player` field.
    expect(state.player).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state, 'controlledActor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state, 'player')).toBe(false);
    expect(state.worldId).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(state.entities).toEqual([]);
  });

  it('resetWorldState returns to idle and drains queued moves', async () => {
    await loadValidWorld();

    const deferred = createDeferred<Response>();
    setWorldFetch(() => deferred.promise);

    const inFlight = moveActor('east');
    const queued = moveActor('south');

    const seen: WorldState[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next);
    });

    resetWorldState();

    const state = getWorldState();
    expect(state.status).toBe('idle');
    expect(state.worldId).toBeNull();
    expect(state.world).toBeNull();
    expect(state.tiles).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(state.controlledActorId).toBeNull();
    expect(seen).toHaveLength(1);

    unsubscribe();
    resetWorldState();
    expect(seen).toHaveLength(1);

    // The queued caller must not hang after the reset.
    deferred.resolve(fakeResponse(commandResponse([transformChanged('entity-a', 4, 4)])));
    await Promise.all([inFlight, queued]);
    expect(getWorldState().status).toBe('idle');
  });

  it('unsubscribe stops notifications', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeWorld((next) => {
      seen.push(next.status);
    });
    unsubscribe();

    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));
    await loadWorld();

    expect(seen).toEqual([]);
  });
});

describe('resource isolation', () => {
  it('keeps the world fetch hook independent from the game-info hook', async () => {
    setGameInfoFetch(async () => {
      throw new Error('game-info transport must not be used for the world');
    });
    setWorldFetch(async () => fakeResponse(VALID_WORLD_RESPONSE));

    await loadWorld();

    expect(getWorldState().status).toBe('ready');
  });
});

describe('useWorld', () => {
  function StatusProbe() {
    const state = useWorld();
    return createElement('span', null, state.status);
  }

  it('renders through getServerSnapshot for SSR', () => {
    resetWorldState();
    expect(renderToStaticMarkup(createElement(StatusProbe))).toContain('idle');
  });
});
