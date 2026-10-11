import { describe, expect, it } from 'vitest';

import {
  isActorId,
  isEntityId,
  isPlayerId,
  isWorldId,
  parseActorId,
  parseEntityId,
  parsePlayerId,
  parseWorldId,
} from '../src/index.ts';
import { captureParseError } from './support.ts';

type Guard = (value: unknown) => boolean;
type Parser = (value: unknown) => string;
type Label = 'EntityId' | 'ActorId' | 'PlayerId' | 'WorldId';
type Concept = { label: Label; is: Guard; parse: Parser };

const concepts: Concept[] = [
  { label: 'EntityId', is: isEntityId, parse: parseEntityId },
  { label: 'ActorId', is: isActorId, parse: parseActorId },
  { label: 'PlayerId', is: isPlayerId, parse: parsePlayerId },
  { label: 'WorldId', is: isWorldId, parse: parseWorldId },
];

const invalidValues: Array<[string, unknown]> = [
  ['the empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['zero', 0],
  ['a boolean', true],
  ['an object', {}],
  ['an array', []],
];

describe.each(concepts)('$label runtime helpers', ({ is, parse, label }) => {
  it('accepts any non-empty string', () => {
    expect(is('x')).toBe(true);
    expect(is('actor-1')).toBe(true);
    expect(is(' ')).toBe(true);
  });

  it.each(invalidValues)('rejects %s', (_valueLabel, value) => {
    expect(is(value)).toBe(false);
  });

  it('parse returns the string unchanged when valid', () => {
    expect(parse('actor-1')).toBe('actor-1');
  });

  it.each(invalidValues)('parse throws ProtocolParseError for %s', (_valueLabel, value) => {
    const error = captureParseError(() => parse(value));
    expect(error.name).toBe('ProtocolParseError');
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(`Invalid ${label} payload`);
  });
});

describe('identity helpers are distinct functions', () => {
  it('does not collapse the identity guards into one shared implementation object', () => {
    const guards = [isEntityId, isActorId, isPlayerId, isWorldId];
    for (let i = 0; i < guards.length; i += 1) {
      for (let j = i + 1; j < guards.length; j += 1) {
        expect(guards[i]).not.toBe(guards[j]);
      }
    }
  });
});
