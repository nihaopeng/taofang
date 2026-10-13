import { describe, expect, it } from 'vitest';

import {
  COMMAND_PATH,
  GAME_INFO_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  STREAM_PATH,
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

  it('exposes the phase-7 world stream path', () => {
    expect(STREAM_PATH).toBe('/api/stream');
  });

  it('exposes the phase-14 protocol version (world-geometry layer break)', () => {
    expect(PROTOCOL_VERSION).toBe(8);
  });
});
