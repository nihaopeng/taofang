# Starvalley

Web Stardew — a browser farming game built as a multi-agent reference project.

Phase 1 is a **vertical slice skeleton**: one real client ⇄ server data path
(`GET /api/game-info`) with no gameplay yet. Its purpose is to prove the module
boundaries, not the game.

- Engineering policy: [`AGENTS.md`](./AGENTS.md)
- Bootstrap/operator guide: [`AI-WORKFLOW.md`](./AI-WORKFLOW.md)
- Concrete architecture decisions: [`docs/architecture.md`](./docs/architecture.md)

## Requirements

- Node.js >= 22.19 (developed on 24.x)
- npm >= 10 (npm workspaces; no other package manager needed)

```bash
npm install
```

## Layout

```
packages/protocol   @starvalley/protocol  canonical contract (types + runtime guards)
packages/manager    @starvalley/manager   authoritative backend execution
packages/router     @starvalley/router    node:http transport adapter
apps/server         @starvalley/server    composition root + process lifecycle
apps/web            @starvalley/web       client (src/organizer + src/ui)
tests/integration   Main-owned end-to-end verification (real HTTP loopback)
```

Dependency direction, enforced by lint:

```
ui -> organizer -> protocol
router -> protocol, manager
manager -> protocol
```

## Development

```bash
npm run dev          # server (tsx watch, :8787) + web (vite, :5273) together
npm run dev:server   # backend only
npm run dev:web      # frontend only
```

Open <http://localhost:5273>. The Vite dev server proxies `/api` to
`http://localhost:8787`, so the browser uses origin-relative URLs and no CORS setup
is required. The dev ports are configurable: `PORT` (server) and `WEB_PORT` (web).
`WEB_PORT` defaults to **5273** rather than Vite's 5173 because 5173 is occupied by
another project on the development machine; `strictPort` is on so a conflict fails
loudly instead of silently drifting to a different port.

## Quality gates

```bash
npm run lint         # ESLint + architecture boundary rules
npm run typecheck    # tsc --noEmit for every workspace + tests/
npm run test         # Vitest: module tests + cross-module integration test
npm run build        # esbuild server bundle + Vite web bundle
npm run verify       # lint + typecheck + test + build
```

`npm run start` runs the built server bundle (`apps/server/dist/index.js`).

`tests/integration/` is Main-owned verification: it boots the real Router/Manager on
an ephemeral port and drives the real Organizer against it over HTTP, so it is the
evidence that the whole `UI -> Organizer -> Protocol -> Router -> Manager` chain works.
Module-scoped unit tests live beside their owners (`packages/*/test`, `apps/*/test`).

### Verification of the data path

```bash
npm run dev:server
curl -s http://localhost:8787/api/game-info
curl -s http://localhost:8787/api/health
```

## Notes

- `packages/*` are **source-only** packages (`exports` point at `src/index.ts`).
  Consumers compile them; there is no intermediate `dist` to go stale.
- Protocol must never import framework/runtime dependencies; Manager must never
  import HTTP/WebSocket frameworks; UI must never call the network directly. These
  are lint errors, not conventions.
