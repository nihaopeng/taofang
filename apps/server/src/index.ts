import { createServer } from 'node:http';
import { createGameInfoManager, createWorldManager } from '@starvalley/manager';
import { createRequestListener } from '@starvalley/router';

/**
 * Composition root for `@starvalley/server`.
 *
 * Wiring + process lifecycle only: build the Manager, adapt it through Router,
 * serve, and shut down gracefully. No business logic lives here.
 */
const port = Number(process.env.PORT ?? 8787);

const gameInfo = createGameInfoManager();
const world = createWorldManager();
const server = createServer(createRequestListener({ gameInfo, world }));

server.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[server] received ${signal}, closing...`);
  server.close(() => {
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
