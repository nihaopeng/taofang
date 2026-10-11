# Architecture — Phase 1 skeleton (Starvalley)

Canonical policy is `AGENTS.md`. This document records the concrete decisions Main
made for the bootstrap so that every owner binds to the same structure.

## Workspace layout

```
starvalley/
├── packages/
│   ├── protocol/   @starvalley/protocol   canonical cross-boundary contract
│   ├── manager/    @starvalley/manager    authoritative backend execution
│   └── router/     @starvalley/router     server transport adapter (node:http)
└── apps/
    ├── server/     @starvalley/server     composition root + process lifecycle
    └── web/        @starvalley/web        client: organizer/ + ui/
```

`apps/web/src/organizer` and `apps/web/src/ui` are directories rather than packages so
the client ships as one Vite bundle; the ownership boundary is enforced by lint rules.

## Dependency direction (enforced)

```
apps/web/src/ui  ──►  apps/web/src/organizer  ──►  @starvalley/protocol
                                                            ▲
apps/server (root) ─► @starvalley/router ────────────────────┤
                            │                               │
                            └──►  @starvalley/manager ───────┘
```

Forbidden, and enforced by `eslint.config.js` `no-restricted-imports`:

- `ui` importing `@starvalley/protocol|router|manager|server`, `node:*`, or calling `fetch`
- `organizer` importing `@starvalley/router|manager|server` or anything under `ui/`
- `protocol` importing anything outside itself
- `manager` importing `node:http|https|http2|net`, `express`, `ws`, client code
- `router`/`server` importing client code

## Technology decisions

| Concern | Decision | Why |
| --- | --- | --- |
| Package manager | npm workspaces (npm >= 10) | available everywhere, no extra toolchain |
| Module system | ESM, `"type": "module"` | matches browser + modern Node |
| TS resolution | `moduleResolution: "bundler"`, `paths` + workspace `exports` → `src/index.ts` | internal packages stay source-only; no stale `dist` during dev |
| Server transport | `node:http` only | keeps Router thin and free of framework opinions; swap later behind the same shape |
| Server dev runner | `tsx watch` | runs TS sources directly |
| Server build | `esbuild --bundle --platform=node` | single artifact, workspace sources inlined |
| Web dev/build | Vite (+ React) | standard; React referenced by the role definitions |
| Tests | Vitest (node environment) | one runner for node + component smoke tests via `react-dom/server` |
| Lint | ESLint 9 flat config + typescript-eslint | carries the boundary rules above |
| Runtime validation | hand-written guards in `@starvalley/protocol` | keeps Protocol dependency-free in phase 1 |
| Dev API wiring | Vite proxy `/api` → `http://localhost:8787` | organizer uses origin-relative URLs; no CORS in dev |

### Why internal packages are source-only

`packages/*` publish `"exports": "./src/index.ts"`. Consumers (tsx, esbuild, Vite,
Vitest) all compile TypeScript, so there is no intermediate `dist` to get stale and no
build ordering between workspaces. `npm run build` therefore produces exactly two
artifacts: the server bundle and the web bundle. `typecheck` covers the rest.

## Frozen phase-1 contract

Defined by the `protocol` owner in `@starvalley/protocol`:

- `GAME_INFO_PATH = '/api/game-info'`, `HEALTH_PATH = '/api/health'`
- `GameInfo`, `GetGameInfoResponse`, `HealthStatus`
- `ProtocolErrorCode`, `ProtocolError`, `ProtocolParseError`
- runtime guards: `isGameInfo`, `parseGetGameInfoResponse`, `parseGameInfo`

Transport status codes are Router's mapping of Protocol error codes — Protocol does not
own HTTP semantics.

## Manager / Organizer / UI surfaces (frozen for parallel work)

```ts
// @starvalley/manager
interface GameInfoManager { getGameInfo(): GameInfo; getHealth(now?: Date): HealthStatus }
function createGameInfoManager(deps?: { clock?: () => Date }): GameInfoManager
const SERVER_VERSION: string

// @starvalley/router
function createRequestListener(deps: { gameInfo: GameInfoManager }): RequestListener

// apps/web/src/organizer
type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'
interface GameInfoState { status: ConnectionStatus; data: GameInfoViewModel | null; error: string | null }
function useGameInfo(): GameInfoState
function loadGameInfo(): Promise<void>
function subscribeGameInfo(listener: (state: GameInfoState) => void): () => void
function getGameInfoState(): GameInfoState
function resetGameInfoState(): void
// useGameInfo must be SSR-safe: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
```

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `8787` | `apps/server` listen port |
| `WEB_PORT` | `5273` | Vite dev/preview port (5173 is taken by another project on this machine) |
| `SERVER_ORIGIN` | `http://localhost:8787` | Vite dev proxy target |
