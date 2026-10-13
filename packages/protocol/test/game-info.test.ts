import { describe, expect, it } from 'vitest';

import {
  isBlockKindInfo,
  isEntityKindInfo,
  isGameInfo,
  isGetGameInfoResponse,
  parseBlockKindInfo,
  parseEntityKindInfo,
  parseGameInfo,
  parseGetGameInfoResponse,
} from '../src/index.ts';
import {
  captureParseError,
  validBlockKindInfo,
  validEntityKindInfo,
  validGameInfo,
  validGetGameInfoResponse,
} from './support.ts';

const invalidValues: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'game-info'],
  ['a boolean', true],
  ['an array', []],
];

describe('isGameInfo', () => {
  it('accepts a well-formed GameInfo', () => {
    expect(isGameInfo(validGameInfo)).toBe(true);
  });

  it('accepts a timestamp without fractional seconds', () => {
    expect(isGameInfo({ ...validGameInfo, serverTime: '2025-01-02T03:04:05Z' })).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_label, value) => {
    expect(isGameInfo(value)).toBe(false);
  });

  it('rejects each unknown extra field (the catalogues live on the response, not here)', () => {
    expect(isGameInfo({ ...validGameInfo, extra: 1 })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, blockKinds: [] })).toBe(false);
  });

  it.each(['gameName', 'serverVersion', 'protocolVersion', 'serverTime'])(
    'rejects a missing %s',
    (key) => {
      const value: Record<string, unknown> = { ...validGameInfo };
      delete value[key];
      expect(isGameInfo(value)).toBe(false);
    },
  );

  it('rejects wrong field types', () => {
    expect(isGameInfo({ ...validGameInfo, gameName: 1 })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, serverVersion: null })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: '1' })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, serverTime: 123 })).toBe(false);
  });

  it('requires a finite integer protocolVersion', () => {
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 1.5 })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: Number.NaN })).toBe(false);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 0 })).toBe(true);
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 999 })).toBe(true);
  });

  it('does not couple the guard to the current PROTOCOL_VERSION', () => {
    expect(isGameInfo({ ...validGameInfo, protocolVersion: 2 })).toBe(true);
  });

  it.each([
    'not-a-date',
    '',
    '2025-01-02',
    '2025-01-02T03:04:05+00:00',
    '2025-01-02T03:04:05.1234Z',
    '2025-13-01T00:00:00Z',
    '2025-02-30T00:00:00Z',
  ])('rejects non-ISO serverTime %s', (serverTime) => {
    expect(isGameInfo({ ...validGameInfo, serverTime })).toBe(false);
  });
});

describe('parseGameInfo', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseGameInfo(validGameInfo)).toBe(validGameInfo);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGameInfo({ ...validGameInfo, extra: 1 }));
    expect(error.message).toBe('Invalid GameInfo payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});

describe('isBlockKindInfo', () => {
  it('accepts a well-formed block-kind catalogue entry', () => {
    expect(isBlockKindInfo(validBlockKindInfo)).toBe(true);
    expect(isBlockKindInfo({ kind: 'stairs', orientable: true })).toBe(true);
    expect(isBlockKindInfo({ kind: 'air', orientable: false })).toBe(true);
  });

  it('rejects missing keys, a bad kind, a non-boolean orientable, and presentation leaks', () => {
    const missing: Record<string, unknown> = { ...validBlockKindInfo };
    delete missing.orientable;
    expect(isBlockKindInfo(missing)).toBe(false);
    expect(isBlockKindInfo({ ...validBlockKindInfo, kind: 'lava' })).toBe(false);
    expect(isBlockKindInfo({ ...validBlockKindInfo, orientable: 'yes' })).toBe(false);
    expect(isBlockKindInfo({ ...validBlockKindInfo, collision: 'aabb' })).toBe(false);
    expect(isBlockKindInfo({ ...validBlockKindInfo, material: 'grass' })).toBe(false);
    expect(isBlockKindInfo({ ...validBlockKindInfo, texture: 'x.png' })).toBe(false);
    expect(isBlockKindInfo(null)).toBe(false);
  });
});

describe('parseBlockKindInfo', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseBlockKindInfo(validBlockKindInfo)).toBe(validBlockKindInfo);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    expect(captureParseError(() => parseBlockKindInfo({ kind: 'lava' })).message).toBe(
      'Invalid BlockKindInfo payload',
    );
  });
});

describe('isEntityKindInfo', () => {
  it('accepts a well-formed entity-kind catalogue entry', () => {
    expect(isEntityKindInfo(validEntityKindInfo)).toBe(true);
    expect(
      isEntityKindInfo({
        kind: 'tree',
        footprintX: 1,
        footprintZ: 1,
        height: 6,
        allowedYawSteps: [0, 90, 180, 270],
        pivot: 'center',
      }),
    ).toBe(true);
  });

  it('rejects missing/extra keys (no collision, support, occupancy, permission, appearance)', () => {
    const missing: Record<string, unknown> = { ...validEntityKindInfo };
    delete missing.pivot;
    expect(isEntityKindInfo(missing)).toBe(false);
    for (const key of [
      'collision',
      'collider',
      'occupancy',
      'support',
      'permission',
      'asset',
      'model',
      'material',
      'color',
    ]) {
      expect(isEntityKindInfo({ ...validEntityKindInfo, [key]: {} })).toBe(false);
    }
  });

  it('rejects a non-positive/non-integer footprint, a non-positive height, and a bad pivot', () => {
    expect(isEntityKindInfo({ ...validEntityKindInfo, footprintX: 0 })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, footprintZ: 1.5 })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, footprintX: -1 })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, height: 0 })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, pivot: 'corner' })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, kind: 'npc' })).toBe(false);
  });

  it('requires a non-empty allowedYawSteps subset of the quarter turns', () => {
    expect(isEntityKindInfo({ ...validEntityKindInfo, allowedYawSteps: [] })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, allowedYawSteps: [45] })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, allowedYawSteps: [0, '90'] })).toBe(false);
    expect(isEntityKindInfo({ ...validEntityKindInfo, allowedYawSteps: null })).toBe(false);
  });
});

describe('parseEntityKindInfo', () => {
  it('throws ProtocolParseError with a message when invalid', () => {
    expect(captureParseError(() => parseEntityKindInfo({ kind: 'tree' })).message).toBe(
      'Invalid EntityKindInfo payload',
    );
  });
});

describe('isGetGameInfoResponse', () => {
  it('accepts a well-formed response with both catalogues', () => {
    expect(isGetGameInfoResponse(validGetGameInfoResponse)).toBe(true);
    expect(
      isGetGameInfoResponse({ ...validGetGameInfoResponse, blockKinds: [], entityKinds: [] }),
    ).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_label, value) => {
    expect(isGetGameInfoResponse(value)).toBe(false);
  });

  it('rejects unknown extra fields and each missing key (the v8 shape is rejected)', () => {
    expect(isGetGameInfoResponse({ ...validGetGameInfoResponse, extra: true })).toBe(false);
    expect(isGetGameInfoResponse({ gameInfo: validGameInfo })).toBe(false);
    expect(isGetGameInfoResponse({ gameInfo: validGameInfo, blockKinds: [] })).toBe(false);
    expect(isGetGameInfoResponse({ gameInfo: validGameInfo, entityKinds: [] })).toBe(false);
  });

  it('rejects malformed catalogue arrays and entries', () => {
    expect(isGetGameInfoResponse({ ...validGetGameInfoResponse, blockKinds: null })).toBe(false);
    expect(isGetGameInfoResponse({ ...validGetGameInfoResponse, blockKinds: {} })).toBe(false);
    expect(
      isGetGameInfoResponse({ ...validGetGameInfoResponse, blockKinds: [{ kind: 'lava' }] }),
    ).toBe(false);
    expect(isGetGameInfoResponse({ ...validGetGameInfoResponse, entityKinds: null })).toBe(false);
    expect(
      isGetGameInfoResponse({
        ...validGetGameInfoResponse,
        entityKinds: [{ ...validEntityKindInfo, pivot: 'corner' }],
      }),
    ).toBe(false);
    expect(isGetGameInfoResponse({ gameInfo: { ...validGameInfo, extra: 1 }, blockKinds: [], entityKinds: [] })).toBe(
      false,
    );
  });
});

describe('parseGetGameInfoResponse', () => {
  it('returns the value unchanged when valid', () => {
    expect(parseGetGameInfoResponse(validGetGameInfoResponse)).toBe(validGetGameInfoResponse);
  });

  it('throws ProtocolParseError with a message when invalid', () => {
    const error = captureParseError(() => parseGetGameInfoResponse({ gameInfo: validGameInfo }));
    expect(error.message).toBe('Invalid GetGameInfoResponse payload');
    expect(error.code).toBe('BAD_REQUEST');
  });
});
