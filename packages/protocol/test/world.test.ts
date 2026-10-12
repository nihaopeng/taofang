import { describe, expect, it } from 'vitest';

import {
  isGetWorldResponse,
  isTerrainKind,
  isTileState,
  isWorldSize,
  isWorldSnapshot,
  parseGetWorldResponse,
  parseTerrainKind,
  parseTileState,
  parseWorldSize,
  parseWorldSnapshot,
} from '../src/index.ts';
import {
  captureParseError,
  phase4WorldSnapshot,
  validEntityState,
  validTileState,
  validWorldSnapshot,
} from './support.ts';

const nonObjects: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'value'],
  ['a boolean', true],
  ['an array', []],
];

describe('isWorldSize', () => {
  it('accepts a well-formed WorldSize', () => {
    expect(isWorldSize({ width: 20, height: 15 })).toBe(true);
  });

  it('rejects zero, negative, and non-integer dimensions', () => {
    expect(isWorldSize({ width: 0, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: 0 })).toBe(false);
    expect(isWorldSize({ width: -1, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: -4 })).toBe(false);
    expect(isWorldSize({ width: 1.5, height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: Number.NaN })).toBe(false);
    expect(isWorldSize({ width: Number.POSITIVE_INFINITY, height: 15 })).toBe(false);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSize(value)).toBe(false);
  });

  it.each(['width', 'height'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { width: 20, height: 15 };
    delete value[key];
    expect(isWorldSize(value)).toBe(false);
  });

  it('rejects unknown extra fields and wrong field types', () => {
    expect(isWorldSize({ width: 20, height: 15, depth: 2 })).toBe(false);
    expect(isWorldSize({ width: '20', height: 15 })).toBe(false);
    expect(isWorldSize({ width: 20, height: null })).toBe(false);
  });
});

describe('isTerrainKind', () => {
  it('accepts exactly grass, path, blocked, and water', () => {
    expect(isTerrainKind('grass')).toBe(true);
    expect(isTerrainKind('path')).toBe(true);
    expect(isTerrainKind('blocked')).toBe(true);
    expect(isTerrainKind('water')).toBe(true);
  });

  it('rejects an unknown value even though the union grew (exact-union regression guard)', () => {
    expect(isTerrainKind('lava')).toBe(false);
  });

  it.each([
    ['a non-member literal', 'lava'],
    ['the empty string', ''],
    ['a number', 0],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isTerrainKind(value)).toBe(false);
  });
});

describe('parseTerrainKind', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTerrainKind('path')).toBe('path');
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTerrainKind('lava'));
    expect(error.message).toBe('Invalid TerrainKind payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isTileState', () => {
  it('accepts a well-formed TileState', () => {
    expect(isTileState(validTileState)).toBe(true);
  });

  it("accepts a 'water' tile (the phase-6 ground kind)", () => {
    expect(isTileState({ ...validTileState, terrain: 'water' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isTileState(value)).toBe(false);
  });

  it.each(['transform', 'terrain'])('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...validTileState };
    delete value[key];
    expect(isTileState(value)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(isTileState({ ...validTileState, walkable: true })).toBe(false);
    expect(isTileState({ ...validTileState, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type for each field', () => {
    expect(isTileState({ ...validTileState, transform: null })).toBe(false);
    expect(isTileState({ ...validTileState, transform: { x: 1, y: 2, extra: 3 } })).toBe(false);
    expect(isTileState({ ...validTileState, transform: { x: 1.5, y: 2 } })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: 'lava' })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: 1 })).toBe(false);
    expect(isTileState({ ...validTileState, terrain: null })).toBe(false);
  });
});

describe('parseTileState', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseTileState(validTileState)).toBe(validTileState);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseTileState({ ...validTileState, terrain: 'lava' }));
    expect(error.message).toBe('Invalid TileState payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('parseWorldSize', () => {
  it('returns the value unchanged when valid', () => {
    const value = { width: 20, height: 15 };
    expect(parseWorldSize(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldSize({ width: 0, height: 15 }));
    expect(error.message).toBe('Invalid WorldSize payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isWorldSnapshot', () => {
  it('accepts a well-formed WorldSnapshot', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
  });

  it('still validates the phase-5 shape (the additions are additive)', () => {
    expect(isWorldSnapshot(validWorldSnapshot)).toBe(true);
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, tiles: [{ ...validTileState, terrain: 'grass' }] }),
    ).toBe(true);
  });

  it("accepts a snapshot containing a 'water' tile and a 'tree' entity (phase-6 vocabulary)", () => {
    expect(
      isWorldSnapshot({
        ...validWorldSnapshot,
        tiles: [{ ...validTileState, terrain: 'water' }],
        entities: [{ ...validEntityState, entityId: 'entity-tree', actorId: null, kind: 'tree' }],
      }),
    ).toBe(true);
  });

  it('accepts an empty entities list (a world with nothing in it yet)', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [] })).toBe(true);
  });

  it('accepts an empty tiles list and a null controlledActorId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [] })).toBe(true);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: null })).toBe(true);
  });

  it('accepts a worldId that is any non-empty string', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: 'overworld' })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isWorldSnapshot(value)).toBe(false);
  });

  it.each(['worldId', 'size', 'tiles', 'entities', 'controlledActorId', 'serverTime'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validWorldSnapshot };
      delete value[key];
      expect(isWorldSnapshot(value)).toBe(false);
    },
  );

  it('rejects unknown extra fields', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, extra: 1 })).toBe(false);
  });

  it('rejects a malformed worldId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, worldId: null })).toBe(false);
  });

  it('rejects a malformed size', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: {} })).toBe(false);
    expect(
      isWorldSnapshot({ ...validWorldSnapshot, size: { width: 20, height: 15, extra: 1 } }),
    ).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, size: { width: 0, height: 15 } })).toBe(false);
  });

  it('rejects unknown terrain / entity kind values inside a snapshot (exact-union regression guard)', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [{ ...validTileState, terrain: 'lava' }] })).toBe(
      false,
    );
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [{ ...validEntityState, kind: 'npc' }] })).toBe(
      false,
    );
  });

  it('rejects entities that are not an array or that contain a malformed entity', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: [{ ...validEntityState, kind: 'npc' }] })).toBe(
      false,
    );
    expect(isWorldSnapshot({ ...validWorldSnapshot, entities: ['entity-1'] })).toBe(false);
  });

  it('rejects tiles that are not an array or that contain a malformed tile', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: null })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: {} })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: [{ ...validTileState, terrain: 'lava' }] })).toBe(
      false,
    );
    expect(isWorldSnapshot({ ...validWorldSnapshot, tiles: ['grass'] })).toBe(false);
  });

  it('rejects a malformed controlledActorId', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: 1 })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: '' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, controlledActorId: undefined })).toBe(false);
  });

  it('rejects a non-ISO serverTime', () => {
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 'yesterday' })).toBe(false);
    expect(isWorldSnapshot({ ...validWorldSnapshot, serverTime: 123 })).toBe(false);
  });

  it('rejects the phase-3 single-actor shape (requires entities + controlledActorId)', () => {
    expect(
      isWorldSnapshot({
        size: { width: 20, height: 15 },
        actor: validEntityState,
        serverTime: validWorldSnapshot.serverTime,
      }),
    ).toBe(false);
    expect(
      isWorldSnapshot({
        size: { width: 20, height: 15 },
        entities: [validEntityState],
        actor: validEntityState,
        controlledActorId: 'actor-1',
        serverTime: validWorldSnapshot.serverTime,
      }),
    ).toBe(false);
  });

  it('rejects the phase-4 snapshot shape (no worldId, no tiles) — the 3 -> 4 break', () => {
    expect(isWorldSnapshot(phase4WorldSnapshot)).toBe(false);
    expect(isWorldSnapshot({ ...phase4WorldSnapshot, worldId: 'world-1' })).toBe(false);
    expect(isWorldSnapshot({ ...phase4WorldSnapshot, tiles: [] })).toBe(false);
  });
});

describe('parseWorldSnapshot', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseWorldSnapshot(validWorldSnapshot)).toBe(validWorldSnapshot);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseWorldSnapshot({ size: {} }));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the phase-3 single-actor shape', () => {
    const error = captureParseError(() =>
      parseWorldSnapshot({
        size: { width: 20, height: 15 },
        actor: validEntityState,
        serverTime: validWorldSnapshot.serverTime,
      }),
    );
    expect(error.message).toBe('Invalid WorldSnapshot payload');
  });

  it('rejects the phase-4 snapshot shape (no worldId, no tiles)', () => {
    const error = captureParseError(() => parseWorldSnapshot(phase4WorldSnapshot));
    expect(error.message).toBe('Invalid WorldSnapshot payload');
  });
});

describe('isGetWorldResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isGetWorldResponse({ world: validWorldSnapshot })).toBe(true);
  });

  it.each(nonObjects)('rejects %s', (_label, value) => {
    expect(isGetWorldResponse(value)).toBe(false);
  });

  it('rejects a missing world and unknown extra fields', () => {
    expect(isGetWorldResponse({})).toBe(false);
    expect(isGetWorldResponse({ world: validWorldSnapshot, extra: true })).toBe(false);
  });

  it('rejects a malformed world snapshot', () => {
    expect(isGetWorldResponse({ world: { ...validWorldSnapshot, extra: 1 } })).toBe(false);
    expect(isGetWorldResponse({ world: null })).toBe(false);
  });

  it('rejects the phase-3 single-actor snapshot inside `world`', () => {
    expect(
      isGetWorldResponse({
        world: {
          size: { width: 20, height: 15 },
          actor: validEntityState,
          serverTime: validWorldSnapshot.serverTime,
        },
      }),
    ).toBe(false);
  });

  it('rejects the phase-4 snapshot (no worldId, no tiles) inside `world`', () => {
    expect(isGetWorldResponse({ world: phase4WorldSnapshot })).toBe(false);
    expect(isGetWorldResponse({ world: { ...phase4WorldSnapshot, worldId: 'world-1' } })).toBe(false);
    expect(isGetWorldResponse({ world: { ...phase4WorldSnapshot, tiles: [] } })).toBe(false);
  });
});

describe('parseGetWorldResponse', () => {
  it('returns the value unchanged when valid', () => {
    const value = { world: validWorldSnapshot };
    expect(parseGetWorldResponse(value)).toBe(value);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGetWorldResponse({}));
    expect(error.message).toBe('Invalid GetWorldResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('rejects the phase-4 snapshot (no worldId, no tiles)', () => {
    const error = captureParseError(() => parseGetWorldResponse({ world: phase4WorldSnapshot }));
    expect(error.message).toBe('Invalid GetWorldResponse payload');
  });
});
