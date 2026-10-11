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
```

Dependency direction, enforced by lint:

```
ui -> organizer -> protocol
router -> protocol, manager
manager -> protocol
```

## Development

```bash
npm run dev          # server (tsx watch, :8787) + web (vite, :5173) together
npm run dev:server   # backend only
npm run dev:web      # frontend only
```

Open http://localhost:5173. The Vite dev server proxies `/api` to
`http://localhost:8787`, so the browser uses origin-relative URLs and no CORS setup
is required. Override with `SERVER_ORIGIN` and `PORT`.

## Quality gates

```bash
npm run lint         # ESLint + architecture boundary rules
npm run typecheck    # tsc --noEmit for every workspace
npm run test         # Vitest (node environment)
npm run build        # esbuild server bundle + Vite web bundle
npm run verify       # lint + typecheck + test + build
```

`npm run start` runs the built server bundle (`apps/server/dist/index.js`).

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
