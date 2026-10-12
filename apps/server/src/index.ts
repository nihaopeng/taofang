import { createServer } from 'node:http';
import { parseActorId } from '@starvalley/protocol';
import type { GameEventBatch } from '@starvalley/protocol';
import { TICK_RATE_HZ, createGameInfoManager, createWorldManager } from '@starvalley/manager';
import { createRequestListener } from '@starvalley/router';
import type { WorldStreamPort } from '@starvalley/router';

/**
 * Composition root for `@starvalley/server`.
 *
 * Wiring + process lifecycle only: build the Manager, adapt it through Router,
 * own the authoritative simulation clock, serve, and shut down gracefully. No
 * business logic lives here.
 */
const port = Number(process.env.PORT ?? 8787);

// Temporary single-actor resolver: today the server owns exactly one local
// actor, so every request resolves to it. A later session slice replaces only
// this seam (session/cookie/header -> PlayerId -> controlled ActorId).
const ACTOR_ID = parseActorId('actor-1');

const gameInfo = createGameInfoManager();
const world = createWorldManager({ actorId: ACTOR_ID });

/**
 * The realtime fan-out seam injected into Router.
 *
 * Router must not own a timer, so this root owns the tick below and only fans
 * the batches it produces out to registered stream listeners. A misbehaving
 * listener must not abort the tick or starve the others.
 */
const streamListeners = new Set<(batch: GameEventBatch) => void>();
const worldStream: WorldStreamPort = {
  subscribe(listener) {
    streamListeners.add(listener);
    return () => {
      streamListeners.delete(listener);
    };
  },
};

const server = createServer(
  createRequestListener({ gameInfo, world, worldStream, resolveActorId: () => ACTOR_ID }),
);

const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;

let tickTimer: NodeJS.Timeout | undefined;

function tick(): void {
  const batch = world.step(TICK_INTERVAL_MS);
  for (const listener of streamListeners) {
    try {
      listener(batch);
    } catch (error) {
      console.error('[server] stream listener failed:', error);
    }
  }
}

server.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  // Start the authoritative clock only after the transport is accepting.
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[server] received ${signal}, closing...`);
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
  server.close(() => {
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
