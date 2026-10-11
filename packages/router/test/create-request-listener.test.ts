import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAME_INFO_PATH,
  HEALTH_PATH,
  isGetGameInfoResponse,
  isHealthStatus,
  parseGetGameInfoResponse,
} from '@starvalley/protocol';
import type { GameInfo, HealthStatus, ProtocolError } from '@starvalley/protocol';
import type { GameInfoManager } from '@starvalley/manager';
import { createRequestListener } from '../src/index.ts';

const GAME_INFO: GameInfo = {
  gameName: 'Test Valley',
  serverVersion: '1.2.3',
  protocolVersion: 1,
  serverTime: '2024-01-01T00:00:00.000Z',
};

const HEALTH: HealthStatus = {
  status: 'ok',
  uptimeSeconds: 12.5,
  serverTime: '2024-01-01T00:00:00.000Z',
};

function createFakeManager(overrides: Partial<GameInfoManager> = {}): GameInfoManager {
  const manager: GameInfoManager = {
    getGameInfo: () => GAME_INFO,
    getHealth: () => HEALTH,
  };
  return Object.assign(manager, overrides);
}

const openServers: Server[] = [];

async function startServer(gameInfo: GameInfoManager): Promise<string> {
  const server = createServer(createRequestListener({ gameInfo }));
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Undici keeps idle keep-alive sockets for ~4s; close them eagerly
          // so teardown does not depend on socket timeouts.
          server.closeAllConnections();
        }),
    ),
  );
});

describe('createRequestListener', () => {
  it('serves GET /api/game-info as a protocol GetGameInfoResponse', async () => {
    const baseUrl = await startServer(createFakeManager());

    const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(isGetGameInfoResponse(body)).toBe(true);
    expect(parseGetGameInfoResponse(body)).toEqual({ gameInfo: GAME_INFO });
  });

  it('serves GET /api/health as a protocol HealthStatus', async () => {
    const baseUrl = await startServer(createFakeManager());

    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body: unknown = await response.json();
    expect(isHealthStatus(body)).toBe(true);
    expect(body).toEqual(HEALTH);
  });

  it('returns a 404 ProtocolError for an unknown path', async () => {
    const baseUrl = await startServer(createFakeManager());

    const response = await fetch(`${baseUrl}/api/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await response.json()) as ProtocolError;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns 405 with an Allow header for POST on a known path', async () => {
    const baseUrl = await startServer(createFakeManager());

    const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    const body = (await response.json()) as ProtocolError;
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('serves HEAD for a GET resource with matching headers and an empty body', async () => {
    const baseUrl = await startServer(createFakeManager());

    const getResponse = await fetch(`${baseUrl}${HEALTH_PATH}`);
    const headResponse = await fetch(`${baseUrl}${HEALTH_PATH}`, { method: 'HEAD' });

    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headResponse.headers.get('content-length')).toBe(
      getResponse.headers.get('content-length'),
    );
    expect(await headResponse.text()).toBe('');
  });

  it('maps a thrown manager error to an opaque 500 INTERNAL_ERROR', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'super-secret-message with stack detail';
    const baseUrl = await startServer(
      createFakeManager({
        getGameInfo: () => {
          throw new Error(secret);
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}${GAME_INFO_PATH}`);

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const raw = await response.text();
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain('Error');
      expect(raw).not.toContain('at ');

      const body = JSON.parse(raw) as ProtocolError;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Internal server error');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
