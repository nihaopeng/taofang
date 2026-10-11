/**
 * Main-owned integration test for the phase-1 vertical slice.
 *
 * Ownership note: this file deliberately imports BOTH a client module
 * (`apps/web/src/organizer`) and backend modules (`@starvalley/router`,
 * `@starvalley/manager`). The dependency rules in AGENTS.md forbid that inside
 * module code; here it is the point — this is the cross-module integration
 * evidence that Main is responsible for, not a module unit test.
 *
 * It boots a real `node:http` server from the production Router/Manager code and
 * drives the production Organizer against it over a real HTTP loopback. Nothing
 * is mocked: the only injected thing is the transport function the Organizer
 * already exposes for tests, which rewrites the origin-relative Protocol path to
 * the ephemeral server address.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { createGameInfoManager } from '@starvalley/manager';
import { createRequestListener } from '@starvalley/router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  getGameInfoState,
  loadGameInfo,
  resetGameInfoFetch,
  resetGameInfoState,
  setGameInfoFetch,
  subscribeGameInfo,
} from '../../apps/web/src/organizer';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const gameInfo = createGameInfoManager();
  server = createServer(createRequestListener({ gameInfo }));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('integration server did not bind to a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    // Deterministic teardown: `close()` waits for idle keep-alive sockets to time
    // out, which makes suites slow and occasionally flaky.
    server.closeAllConnections();
  });
});

afterEach(() => {
  resetGameInfoState();
  resetGameInfoFetch();
});

function useRealServer(path = '') {
  setGameInfoFetch((input, init) => fetch(new URL(path || input, baseUrl), init));
}

describe('vertical slice: organizer -> protocol -> router -> manager', () => {
  it('reaches connected state with the server-authoritative game info', async () => {
    useRealServer();

    await loadGameInfo();

    const state = getGameInfoState();
    expect(state.status).toBe('connected');
    expect(state.error).toBeNull();

    const data = state.data;
    if (data === null) {
      throw new Error('expected a view model after a successful load');
    }
    expect(data.connectionStatus).toBe('connected');
    expect(data.gameName).toBe('Starvalley');
    expect(data.serverVersion).toBe('0.1.0');
    expect(Number.isNaN(Date.parse(data.lastSyncedAt))).toBe(false);

    // The Organizer's view model must not leak wire-only fields.
    expect(Object.keys(data).sort()).toEqual([
      'connectionStatus',
      'gameName',
      'lastSyncedAt',
      'serverVersion',
    ]);
  });

  it('observes the idle -> connecting -> connected lifecycle against a real server', async () => {
    const observed: string[] = [];
    const unsubscribe = subscribeGameInfo((next) => {
      observed.push(next.status);
    });

    useRealServer();
    await loadGameInfo();
    unsubscribe();

    expect(observed).toEqual(['connecting', 'connected']);
  });

  it('surfaces a real 404 as a user-presentable error without leaking transport detail', async () => {
    useRealServer('/api/does-not-exist');

    await loadGameInfo();

    const state = getGameInfoState();
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
    expect(state.error).toContain('404');
    expect(state.error).not.toContain('/api/does-not-exist');
  });

  it('keeps the client view model small while the server sends the full DTO', async () => {
    // Directly assert the wire shape the Organizer validated, using the same
    // transport boundary the browser uses (the Vite dev proxy path).
    const response = await fetch(new URL('/api/game-info', baseUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const payload: unknown = await response.json();
    expect(payload).toEqual({
      gameInfo: {
        gameName: 'Starvalley',
        serverVersion: '0.1.0',
        protocolVersion: 1,
        serverTime: expect.any(String) as unknown as string,
      },
    });
  });
});
