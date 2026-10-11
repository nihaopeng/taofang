import { describe, expect, it } from 'vitest';

import { GAME_INFO_PATH, HEALTH_PATH, MOVE_ACTOR_PATH, PROTOCOL_VERSION, WORLD_PATH } from '../src/index.ts';

describe('protocol constants', () => {
  it('exposes the frozen wire paths', () => {
    expect(GAME_INFO_PATH).toBe('/api/game-info');
    expect(HEALTH_PATH).toBe('/api/health');
  });

  it('exposes the frozen world / movement wire paths', () => {
    expect(WORLD_PATH).toBe('/api/world');
    expect(MOVE_ACTOR_PATH).toBe('/api/actor/move');
  });

  it('exposes the frozen protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
