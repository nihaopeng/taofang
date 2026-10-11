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

## Phase 2 frozen contract — World / Player / Movement

Main froze this before parallel implementation. `protocol` owns the definitions; no other
module may invent a wire field.

```ts
// transport
WORLD_PATH       = '/api/world'          // GET  -> GetWorldResponse
PLAYER_MOVE_PATH = '/api/player/move'    // POST MovePlayerCommand -> MovePlayerResponse

// shared identifiers / enums
type PlayerId      = string
type MoveDirection = 'north' | 'south' | 'east' | 'west'

// value objects (integer tile coordinates; origin TOP-LEFT, x -> east, y -> south)
interface Position  { x: number; y: number }
interface WorldSize { width: number; height: number }   // positive integers
interface Player    { id: PlayerId; name: string; position: Position }

// read
type WorldSnapshot  = { size: WorldSize; player: Player; serverTime: string }
interface GetWorldResponse  { world: WorldSnapshot }

// command / result
interface MovePlayerCommand { playerId: PlayerId; direction: MoveDirection }
interface MovePlayerResult  { player: Player; moved: boolean; serverTime: string }
interface MovePlayerResponse { result: MovePlayerResult }
```

> **Correction (Main, after Wave 2):** this section originally declared
> `WorldSnapshot = { world: { size: WorldSize }; player; serverTime }`, which nested a
> `world` field inside the `world` response envelope and forced every consumer to write
> `response.world.world.size`. That was a defect in Main's frozen contract, not an
> implementation error. `WorldSnapshot` now carries `size` directly, so consumers read
> `response.world.size` / `response.world.player`. Future world data (tiles, objects,
> NPCs) is added as further `WorldSnapshot` fields rather than as another nesting level.
> `GetWorldResponse` and `PROTOCOL_VERSION = 1` are unchanged.

Semantics frozen for this slice:
- `north` = y-1, `south` = y+1, `east` = x+1, `west` = x-1.
- The target tile must satisfy `0 <= x < width` and `0 <= y < height`. A step that would
  leave the world is **not an error**: the server returns 200 with `moved: false` and the
  unchanged authoritative position. (Manager decides this at runtime; Protocol only
  declares the shape.)
- Unknown `playerId` -> `NOT_FOUND` (404). Invalid/missing fields or malformed JSON ->
  `BAD_REQUEST` (400).
- `serverTime` is an ISO-8601 UTC string, same guard as `GameInfo`.
- `PROTOCOL_VERSION` stays `1`: this slice only **adds** endpoints and DTOs; no existing
  shape changes.
- Explicitly out of scope: prediction, interpolation, collision, pathfinding, art,
  authentication/authorization (the command carries `playerId`, but the server does not yet
  verify that the caller owns it).

### Phase-3 frozen contract — identity, and migration of movement to ActorId

Main froze this before parallel implementation. Three identity concepts are deliberately
**distinct nominal types**, not one universal id. They answer different questions:

| Concept | Answers | Lives in the world? | Carried on the wire today? |
| --- | --- | --- | --- |
| `EntityId` | "this *thing* exists" | yes | **no** — it appears when the world has objects (tiles/objects/crops) |
| `ActorId` | "this *thing that can act* is who" — the subject of a command | yes | **yes** — the movement chain uses it |
| `PlayerId` | "this *human/session* is who" — the authentication principal | no (outside the world) | **no** — lands with the session slice |

Intended relation (not yet implemented, only reserved):

```
PlayerId (authentication principal, out of world)
   │ controls
   ▼
ActorId (an entity that can act)
   │ identifies
   ▼
Entity  (any world object — referenced through its EntityId)
```

```ts
// packages/protocol/src/identity.ts
// Nominal (branded) types: mutually non-assignable, and not assignable to `string`.
type EntityId = string & { readonly [entityIdBrand]: true }
type ActorId  = string & { readonly [actorIdBrand]: true }
type PlayerId = string & { readonly [playerIdBrand]: true }

isEntityId / parseEntityId
isActorId  / parseActorId
isPlayerId / parsePlayerId        // all three: non-empty string at runtime
```

Movement / world shapes after the migration:

```ts
MOVE_ACTOR_PATH = '/api/actor/move'      // was PLAYER_MOVE_PATH = '/api/player/move'

interface Actor   { actorId: ActorId; name: string; position: Position }
interface WorldSnapshot { size: WorldSize; actor: Actor; serverTime: string }
interface GetWorldResponse { world: WorldSnapshot }

// The command does NOT carry an actor id: a client may not name the actor it acts as.
interface MoveActorCommand  { direction: MoveDirection }
interface MoveActorResult   { actor: Actor; moved: boolean; serverTime: string }
interface MoveActorResponse { result: MoveActorResult }
```

Removed (no external consumers; contract stays unambiguous): `Player`, `MovePlayerCommand`,
`MovePlayerResult`, `MovePlayerResponse`, `PLAYER_MOVE_PATH`, `isPlayer`, `parsePlayer` and the
other player-named movement helpers. **`PROTOCOL_VERSION` is bumped `1 -> 2`** because this is
an incompatible wire change.

### The authorization boundary (reserved, not implemented)

Who-is-the-caller is resolved in exactly ONE place, and it is not the request body:

```ts
// packages/router — the single seam. Today: the server's one local actor.
// Later: session/cookie/header lookup -> PlayerId -> the ActorId that player CONTROLS.
type ResolveActorId = (request: IncomingMessage) => ActorId | Promise<ActorId>
interface RouterDependencies { gameInfo; world; resolveActorId: ResolveActorId }
```

- Router extracts the actor id from transport context and calls Manager with typed input:
  `world.moveActor({ actorId, command })` — the phase-1-preferred shape from
  `.pi/agents/manager.md`.
- Manager enforces runtime rules for that actor (`UnknownActorError` when it does not exist).
- Because the wire command has no actor field, a client **cannot** name an actor: an extra
  `actorId` field is a `400 BAD_REQUEST`. This is the regression guard for the boundary.
- Deliberately NOT built: an ECS/component system, a permission/role engine, a session store, or
  an `UNAUTHORIZED`/`FORBIDDEN` error code (it would be unused until sessions exist — and the
  error-code -> HTTP status map is a total `Record`, so adding one is a compile-checked change).

### Orchestrator surfaces after the migration

```ts
// @starvalley/manager
interface MoveActorInput { actorId: ActorId; command: MoveActorCommand }
interface WorldManager {
  getSnapshot(input: { actorId: ActorId }): WorldSnapshot
  moveActor(input: MoveActorInput): MoveActorResult
}
class UnknownActorError extends Error { readonly actorId: ActorId }
createWorldManager(deps?: { worldSize?; actorId?: ActorId; actorName?: string; clock? })

// apps/web/src/organizer — UI-facing: the client sees the actor IT CONTROLS
interface ControlledActorViewModel { actorId: string; name: string; x: number; y: number }
interface WorldState { status; world: WorldViewModel | null; controlledActor: ControlledActorViewModel | null; error: string | null }
function moveActor(direction: MoveDirection): Promise<void>   // was movePlayer
```

### Reserved identity vocabulary vs. dead exports (Main decision)

`EntityId`/`isEntityId`/`parseEntityId` and `PlayerId`/`isPlayerId`/`parsePlayerId` have **no
production consumer yet** — they are exported vocabulary, deliberately reserved:
`EntityId` for the Tile/World/objects slice, `PlayerId` for the session slice. This is the one
place where the contract is intentionally ahead of its consumers, because the whole point of
this phase was to fix the *semantics* of the three ids before any of them spread. Re-evaluate
in the Tile/World slice: if `EntityId` still has no consumer afterwards, trim it from
`index.ts` until it does.

### Adding fields to `WorldSnapshot` is a breaking change

All payload guards use exact-key matching (`hasExactKeys`), so **adding** a field (e.g. the
upcoming `tiles`) is an incompatible change that requires a `PROTOCOL_VERSION` bump. That is a
deliberate trade-off: strict guards catch client/server drift immediately (they have already
caught real drift in this project). It is safe while there are no deployed clients and no
version negotiation. When compatibility actually matters, we must choose between version
negotiation and tolerating unknown extra fields — do not quietly relax the guards before then.

### Known consequence: identity is resolved for every known route

The listener resolves `resolveActorId(request)` once per routed request, including for
`/api/health` and `/api/game-info`, which do not need an actor. Harmless today (the injected
resolver is total and side-effect free), but a future session resolver that *rejects*
anonymous requests would also fail the health check. When sessions land, either resolve the
actor only for routes that declare they need one, or let the resolver return optional context
for the current routes plus a required actor for actor routes. Deliberately not fixed now:
fixing it today needs a handler/context union that buys nothing until a session exists.

### Phase-2 known limitations (deliberate, to be addressed in later slices)

1. **No authentication.** `PlayerId` exists as vocabulary but nothing authenticates it: `resolveActorId` returns the server's single local actor without inspecting the request. Identity/session must
   land before any second player or any privileged command.
2. **In-memory state only.** The world lives in the Manager process, so a restart resets every
   position. Persistence is not implemented anywhere yet (`Manager` owns that responsibility
   but no repository exists).
3. **No event channel.** Router registers request routes only, so one client cannot observe
   another's movement. Realtime push is not implemented.
4. **The world has no terrain.** `WorldSnapshot.size` is the only world data; there are no
   tiles, objects, or collision surfaces.
5. **A load overlapping an in-flight move can render a stale position.** `performMove` drops a
   move result when the store has no controlled actor yet (`state.controlledActor === null`),
   and a snapshot fetched before the move was applied can be older than the server's current
   state. Unreachable from the current UI (direction controls are gated on `ready`), but it
   must be guarded when reconnect/manual-refresh lands.
6. **Single in-flight command, latest wins.** Organizer serialises moves into one slot rather
   than a queue, so rapid input coalesces instead of replaying every press. This is intentional
   for a no-prediction client; a predicted client will need real input sequencing.

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `8787` | `apps/server` listen port |
| `WEB_PORT` | `5273` | Vite dev/preview port (5173 is taken by another project on this machine) |
| `SERVER_ORIGIN` | `http://localhost:8787` | Vite dev proxy target |
