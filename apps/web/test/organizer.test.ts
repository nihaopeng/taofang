import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getGameInfoState,
  loadGameInfo,
  resetGameInfoFetch,
  resetGameInfoState,
  setGameInfoFetch,
  subscribeGameInfo,
  useGameInfo,
} from '../src/organizer/index.ts';
import type { GameInfoState } from '../src/organizer/index.ts';

const VALID_GAME_INFO = {
  gameName: 'Starvalley',
  serverVersion: '0.1.0',
  protocolVersion: 1,
  serverTime: '2025-01-02T03:04:05.000Z',
};

const VALID_RESPONSE = { gameInfo: VALID_GAME_INFO };

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

beforeEach(() => {
  resetGameInfoState();
  resetGameInfoFetch();
});

afterEach(() => {
  // Ensure a deferred/stubbed fetch can never leak into the next test.
  resetGameInfoFetch();
  resetGameInfoState();
});

describe('loadGameInfo', () => {
  it('maps a valid Protocol response into connected state', async () => {
    let calls = 0;
    setGameInfoFetch(async () => {
      calls += 1;
      return fakeResponse(VALID_RESPONSE);
    });

    await expect(loadGameInfo()).resolves.toBeUndefined();

    const state = getGameInfoState();
    expect(calls).toBe(1);
    expect(state.status).toBe('connected');
    expect(state.error).toBeNull();
    expect(state.data).not.toBeNull();
    expect(state.data).toMatchObject({
      gameName: 'Starvalley',
      serverVersion: '0.1.0',
      connectionStatus: 'connected',
    });
    expect(state.data?.lastSyncedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('maps a network rejection to an error state with no data and a user message', async () => {
    setGameInfoFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(loadGameInfo()).resolves.toBeUndefined();

    const state = getGameInfoState();
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
    expect(state.error).toBeTruthy();
    expect(state.error).not.toContain('TypeError');
    expect(state.error).not.toContain('fetch');
  });

  it('maps a non-2xx response to an error that mentions the status', async () => {
    setGameInfoFetch(async () =>
      fakeResponse(
        { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        { ok: false, status: 503 },
      ),
    );

    await loadGameInfo();

    const state = getGameInfoState();
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
    expect(state.error).toContain('503');
  });

  it('rejects a payload failing the protocol guard and keeps no partial data', async () => {
    setGameInfoFetch(async () => fakeResponse(VALID_RESPONSE));
    await loadGameInfo();
    expect(getGameInfoState().status).toBe('connected');

    setGameInfoFetch(async () => fakeResponse({ gameInfo: { gameName: 'Starvalley' } }));
    await loadGameInfo();

    const state = getGameInfoState();
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
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
    setGameInfoFetch(async () => badBody as unknown as Response);

    await loadGameInfo();

    const state = getGameInfoState();
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
    expect(state.error).not.toContain('SyntaxError');
  });

  it('ignores a superseded success response after a reset', async () => {
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    setGameInfoFetch(() => pending);

    const superseded = loadGameInfo();
    expect(getGameInfoState().status).toBe('connecting');

    resetGameInfoState();
    expect(getGameInfoState().status).toBe('idle');

    // The in-flight request settles *after* the reset; its valid payload must
    // not resurrect `connected` state over the newer `idle` state.
    resolveFetch(fakeResponse(VALID_RESPONSE));
    await superseded;

    const state = getGameInfoState();
    expect(state.status).toBe('idle');
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
  });

  it('ignores a superseded failure response after a reset', async () => {
    let rejectFetch!: (error: unknown) => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    });
    setGameInfoFetch(() => pending);

    const superseded = loadGameInfo();
    expect(getGameInfoState().status).toBe('connecting');

    resetGameInfoState();
    expect(getGameInfoState().status).toBe('idle');

    // The in-flight request rejects *after* the reset; it must not write an
    // `error` state over the newer state.
    rejectFetch(new TypeError('Failed to fetch'));
    await superseded;

    const state = getGameInfoState();
    expect(state.status).toBe('idle');
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
  });

  it('lets a newer request win while a superseded response is in flight', async () => {
    const firstDeferred = createDeferred<Response>();
    const secondDeferred = createDeferred<Response>();
    let calls = 0;
    setGameInfoFetch(() => {
      calls += 1;
      return calls === 1 ? firstDeferred.promise : secondDeferred.promise;
    });

    const first = loadGameInfo();
    // Reset drops the in-flight marker, so the next call starts a new request
    // at the bumped generation.
    resetGameInfoState();
    const second = loadGameInfo();
    expect(calls).toBe(2);

    // Resolve the superseded request first: its payload must be ignored and
    // the store must keep `connecting` for the newer request.
    firstDeferred.resolve(fakeResponse({ gameInfo: { ...VALID_GAME_INFO, gameName: 'First' } }));
    await first;
    expect(getGameInfoState().status).toBe('connecting');

    secondDeferred.resolve(
      fakeResponse({ gameInfo: { ...VALID_GAME_INFO, gameName: 'Second' } }),
    );
    await second;

    const state = getGameInfoState();
    expect(state.status).toBe('connected');
    expect(state.data?.gameName).toBe('Second');
  });

  it('dedupes concurrent calls into a single fetch', async () => {
    let calls = 0;
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    setGameInfoFetch(() => {
      calls += 1;
      return pending;
    });

    const first = loadGameInfo();
    const second = loadGameInfo();

    expect(calls).toBe(1);
    expect(first).toBe(second);

    resolveFetch(fakeResponse(VALID_RESPONSE));
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(getGameInfoState().status).toBe('connected');
  });

  it('transitions synchronously and notifies subscribers on each transition', async () => {
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    setGameInfoFetch(() => pending);

    const seen: string[] = [];
    const unsubscribe = subscribeGameInfo((next) => {
      seen.push(next.status);
    });

    const settled = loadGameInfo();
    expect(seen).toEqual(['connecting']);

    resolveFetch(fakeResponse(VALID_RESPONSE));
    await settled;
    expect(seen).toEqual(['connecting', 'connected']);

    unsubscribe();
  });
});

describe('game-info store identity and subscription', () => {
  it('returns a stable state reference while nothing changes', () => {
    const first = getGameInfoState();
    expect(getGameInfoState()).toBe(first);

    const unsubscribe = subscribeGameInfo(() => {});
    expect(getGameInfoState()).toBe(first);
    unsubscribe();
  });

  it('resetGameInfoState returns to idle and unsubscribe stops notifications', async () => {
    setGameInfoFetch(async () => fakeResponse(VALID_RESPONSE));
    await loadGameInfo();

    const seen: GameInfoState[] = [];
    const unsubscribe = subscribeGameInfo((next) => {
      seen.push(next);
    });

    resetGameInfoState();

    const state = getGameInfoState();
    expect(state.status).toBe('idle');
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
    expect(seen).toHaveLength(1);

    unsubscribe();
    resetGameInfoState();
    expect(seen).toHaveLength(1);
  });
});

describe('useGameInfo', () => {
  function StatusProbe() {
    const state = useGameInfo();
    return createElement('span', null, state.status);
  }

  it('renders through getServerSnapshot for SSR', () => {
    resetGameInfoState();
    expect(renderToStaticMarkup(createElement(StatusProbe))).toContain('idle');
  });
});
