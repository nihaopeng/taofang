import { describe, expect, it } from 'vitest';

import { GAME_INFO_PATH, HEALTH_PATH, PROTOCOL_VERSION } from '../src/index.ts';

describe('protocol constants', () => {
  it('exposes the frozen wire paths', () => {
    expect(GAME_INFO_PATH).toBe('/api/game-info');
    expect(HEALTH_PATH).toBe('/api/health');
  });

  it('exposes the frozen protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
