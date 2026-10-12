import { describe, expect, it } from 'vitest';

import {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  WORLD_PATH,
} from '../src/index.ts';

describe('protocol constants', () => {
  it('exposes the frozen wire paths', () => {
    expect(GAME_INFO_PATH).toBe('/api/game-info');
    expect(HEALTH_PATH).toBe('/api/health');
  });

  it('exposes the frozen world / command wire paths', () => {
    expect(WORLD_PATH).toBe('/api/world');
    expect(COMMAND_PATH).toBe('/api/command');
  });

  it('exposes the phase-6 protocol version (water / tree vocabulary additions)', () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
