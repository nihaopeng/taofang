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

### Orchestrator surfaces intentionally superseded in phase 4

The phase-3 manager/organizer surfaces (`MoveActorInput`, `MoveActorCommand`/`MoveActorResult`,
`ControlledActorViewModel`, `WorldState.controlledActor`) no longer exist: phase 4 replaced them
with the primitive contract (`submitCommand`, `EntityState`, `WorldState.entities` +
`controlledActorId`). See "Phase 4 frozen contract — primitive-driven architecture" above for the
current surface; this section is kept only so the phase-3 history is not silently rewritten.

## Phase 11 frozen contract — narrow-FOV perspective camera + a minimal renderer regression scene

Owner's decision: switch the rig to a **narrow-FOV `PerspectiveCamera` (initial 28 degrees)**, fixed pitch,
`roll = 0`, yaw + bounded zoom only, for **gentle** near-large/far-small rather than strong third-person
perspective. Orthographic has **no** foreshortening by construction, so "far is smaller" can never come from
it — and it must NOT be faked with per-object scale (forbidden).

### The regression scene (required BEFORE and AFTER the camera switch)

A minimal scene that renders **only a regular grid of terrain**: no actor, no props, no decorations, no
GridOverlay, no fake shadow geometry. Yaw is swept 0..345 degrees. It exists so camera and terrain defects
are separated instead of argued about visually. It asserts:

1. **Orthographic**: the parallel near and far edges are STRICTLY equal in projected length (measured ratio
   exactly 1 to 9 decimals; verified at yaw 0/30/45/60/90/135/180/225/270/315).
2. **Perspective**: the near edge is STABLY longer than the far edge (a ratio with a lower bound, not merely
   `!=`) at every yaw.
3. **No terrain crack at any yaw**: adjacent tiles share boundaries in WORLD space exactly
   (`|centre_{i+1} - centre_i| == cellSize` and each footprint == cellSize), so no gap can exist.
4. **Tile world footprint is always exactly `cellSize`** (measured from real geometry, at every yaw).
5. **Every tile/node scale is constantly 1.**

### Decision rules (explicit, so nobody tunes visuals instead of fixing a cause)

- If the minimal ORTHO scene shows "near short, far long", do **not** tune camera/visual parameters:
  investigate `CameraRig`, parent transforms and `WorldRoot` scale.
- If PERSPECTIVE shows a crack, do **not** attribute it to perspective: keep investigating terrain geometry.
- If perspective feels too strong, prefer a **narrower FOV plus a larger camera distance** to preserve
  composition. Never correct per tile.
- If per-tile meshes still show a raster seam, escalate the terrain to a **shared/chunked continuous mesh**
  (shared vertices along cell boundaries, e.g. one mesh per (layer, appearance)). The gameplay grid, the
  protocol and every other layer stay exactly as they are; only the realisation changes.

### Terrain rules that remain in force

- The gameplay tile/grid continues to exist as an interaction layer; nothing about it changes.
- Visible terrain tiles have **no inset**; the footprint is exactly `cellSize`; neighbours share boundaries.
- The dark base plate must **never** be used to show through as grid lines; `GridOverlay` (an independent
  layer, hidden by default) is the only grid-line mechanism.
- No per-tile `scale`, per-tile `offset`, or `renderOrder` hack anywhere.
- Phase 9/10 record: the seam removal, the independent `GridOverlay`, the `framingMargin`, and the rule that
the oversized backdrop does **not** receive/cast shadows (outside the shadow map the clamped lookup draws a
false world-space boundary that reads as a tapering trapezoid — 73% of the floor lay beyond it at zoom 1).

### Consequences recorded for the perspective rig

- "Projection is affine" and "on-screen footprint is constant with depth" are **intentionally given up**;
  depth-dependent on-screen size is the point. The affineness assertions are replaced by rule 2.
- Framing and backdrop coverage must be recomputed for a perspective frustum: the visible ground is now a
  trapezoid running to a horizon, so the backdrop is sized from the projected view footprint (with the
  framing margin) and the camera needs a sane `near`/`far`; zoom must keep the world framed and must never
  expose the backdrop's edge.
- The shadow camera stays orthographic and keeps covering the world.
- `inspect().camera` must describe a perspective frustum honestly (e.g. fov/near/far) instead of ortho
  left/right/top/bottom, so tests assert what the renderer actually uses.

### Final rig parameters (Wave D + phase-12 flattened pitch, measured)

- **Camera**: `PerspectiveCamera`, pitch 35 (**fixed**, no adjustable path: `setCameraOrientation` accepts
  yaw only and the pitch is reported but never set), roll 0, yaw free, orthographic shadow camera unchanged.
  Phase 12 lowered the locked pitch 58 -> 45, and phase 12b lowered it again 45 -> 35 to lay the camera
  flatter still (a larger pitch is a HIGHER, more top-down view; 90 = straight down, 0 = level). It is still
  one named constant in `RENDER_CAMERA`, not a range or an adjustable path.
- **FOV is a FIXED constant**: 28 degrees at every yaw. Wave C derived the FOV per yaw (20.2854..28.0000)
  to keep the world's projected bounding box inside the frame; a per-yaw FOV is a per-yaw **zoom**, so a
  fixed-size object appeared ~38% larger at axis-aligned yaws than at the diagonals (the reported "map pulls
  farther away then closer" defect). Wave D removes it.
- **Orbit radius is FIXED** at `distance = worstCaseFit / tan(fov / 2)` with `fov = 28` and
  `worstCaseFit = max(extentUp + verticalHeadroom, extentRight / aspect) * framingMargin` taken as the exact
  maximum over yaw (closed form, not sampled). At aspect 1 / zoom 1 that is **40.839126**, constant across the
  whole yaw sweep to ~1e-14 (verified). FOV, near, far and distance are all yaw-invariant, i.e. a pure orbit
  with a completely unchanging projection; no object changes apparent size while rotating. The phase-12b
  pitch change leaves the DISTANCE unchanged at this aspect, because the fit-driving term at aspect 1 is the
  horizontal `diagonal` (8.485), not the pitch-dependent vertical term
  (`sin(35) * 8.485 + 1 = 5.87`, still below the horizontal). The camera HEIGHT is `distance * sin(pitch)`,
  so it does follow the pitch: **23.424360** at pitch 35 (was 28.877 at pitch 45).
- **Honest consequence**: the world's projected *outline* still varies with yaw (a square world subtends a
  wider width corner-on than edge-on). That is geometric and is NOT zoom pumping — a fixed-size segment at the
  focus plane projects to a constant NDC length at every yaw (`0.1964186`). Frame utilisation (max `|ndc|`
  over the world's ground corners) is **0.669874 at axis-aligned yaws vs 0.833333 (= 1 / framingMargin) at the
  diagonals** at pitch 35 (0.657568 vs 0.833333 at pitch 45, 0.639005 vs 0.833333 at pitch 58; the flatter
  camera pushes the axis-aligned outline larger), so the axis-aligned yaws carry extra margin and the
  diagonals sit exactly at the framing margin. The worst frame utilisation over the sweep is **0.842030**
  (at the ~30-degree yaws), still strictly inside the viewport. The only levers that would flatten the outline
  are a wider FOV / farther camera or a 90-degree-stepped yaw; never a per-yaw FOV.
- **Zoom is a DOLLY** (`distance = base / zoom`) while the FOV is zoom-invariant; a dolly does change
  foreshortening, which is acceptable because it is an explicit user action and the orbit is exactly constant
  at any single zoom. Verified at zoom 0.25 / 1 / 8.
- **`near` is derived from the geometry**, not a small constant: `max(0.5, distance - worldRadius - 1)`
  (18.762 = full bounds diagonal, so a follow focus anywhere in the world is covered), further clamped below
  the nearest visible ground-corner depth. At default that is **21.0775** (was 0.1, which wasted depth
  precision); it is constant across yaw as well, and the phase-12b pitch change leaves it at 21.0775. The
  tightest clearance is exactly `nearClearance` (1 world unit), at the most zoomed-out state where the
  `minDepth` clamp binds (`near` = 126.7317 there); at max zoom `near` stays at `minNear` (0.5) with a ~3.49
  gap. The flatter camera makes every visible ground ray meet the floor *farther* from the camera (the top of
  the frame now looks `pitch - fov/2 = 21` degrees below horizontal instead of 31), so the near clearance at
  the intermediate/default zooms stays comfortably above 1 (10.86 at default); re-verified at every yaw and
  zoom in `apps/web/test/three-runtime.test.ts`.
- **Backdrop still covers the visible floor**: the single backdrop mesh is sized from the projected view
  footprint (per yaw/zoom) plus the world half-extents and a 2x overshoot; its silhouette stays off-screen at
  every yaw/zoom, and the `far` plane is 1.2x the farthest visible ground depth + 1. The flatter pitch only
  grows the visible ground footprint, which the same `backdropHalfExtents`/`perspectiveFrustum` pair handles
  automatically. Measured backdrop (overshoot 2, yaw 0, aspect 1) and far plane: zoom 1: 75.25 x 122.28,
  far 81.699; zoom 0.25: 265.01 x 453.11, far 323.798; zoom 8: 19.91 x 25.78, far 11.087. Re-verified
  (strictly inside, >= 20% gap) in the same test file. The single backdrop is never derived from the shadow
  camera and never casts/receives shadows; the shadow camera stays sized to the WORLD (below).
- **Shadow camera stays world-sized, not view-sized**: `shadowExtent = max(worldWidth, worldDepth) / 2 + 4`
  (`+-10` for the default 12x12 world) is derived from the WORLD bounds alone — it does not read the pitch,
  zoom, or the visible ground footprint. The oversize backdrop is deliberately outside the shadow frustum and
  neither casts nor receives, so coupling the shadow camera to the visible floor would only inflate the
  frustum and collapse the 1024x1024 map's resolution. `inspect().shadow.extent` reports the half-width and a
  focused test pins it against a large zoom change of the visible ground.
- **Residual ratio variation is geometric, not a defect**: the selected near/far edge pair is
  `12*cos(pitch)` apart in depth at axis-aligned yaws and `12*cos(pitch)*cos45` at the diagonals — at pitch 35
  that is **9.83** and **6.95** (was 8.49 and 6.00 at pitch 45, 6.36 and 4.50 at pitch 58) — and the ratio is
  FOV-independent, so no FOV can flatten it (only a much larger distance would, and that abandons the
  composition). The harness therefore asserts the STRUCTURAL properties exactly (FOV/near/far/distance/height
  constant at 1e-9, a fixed-size focus-plane segment's NDC length constant at 1e-9, calibration against
  `pick()`, near strictly > far, footprint/boundary/scale exactly 0) and treats the ratio band as a smoke
  check only: at pitch 35 it is **1.0916..1.2736** (measured span **0.1821**, midpoint 1.182598), which the
  harness bands with a 0.1 tolerance (half the span with margin).

### Tuning the flattening further (owner note)

The camera angle is still exactly ONE constant: `RENDER_CAMERA.pitchDegrees` (now 35). Lowering it further
(e.g. 30 is noticeably flatter still; a larger pitch such as 40 is more of a map view) has these unavoidable,
measurable effects, all of which the harness already reports:

- the world's depth spread `12*cos(pitch)` grows as the pitch falls (8.49 at 40, 9.83 at 35, 10.39 at 30),
  widening the near/far ratio band further — again a smoke-check band, not a defect;
- the visible ground extends farther and the frame's top edge looks `pitch - fov/2` below horizontal (e.g. 26
  at 40, 21 at 35, 16 at 30), so the backdrop/far-plane coverage must keep up (it does, automatically,
  through `backdropHalfExtents`);
- the vertical fit term `sin(pitch)*diagonal + headroom` shrinks, but at aspect 1 the horizontal term still
  dominates down to roughly 6.6 degrees, so the orbit distance is unchanged until the pitch is very low;
- below `fov/2 = 14` degrees some viewport ray would point at/above the horizon and the footprint becomes
  unbounded; `perspectiveFrustum` guards that (`parallelToGround`) but the composition is no longer a framed
  world, so do not go there. Below the fit crossover the vertical term takes over and the distance grows;
- the near/far projected-length band widens; the harness's `PERSPECTIVE_RATIO_REFERENCE_TOLERANCE` must be
  re-banded to half the newly measured span whenever the pitch moves.

Never flatten by scaling tiles, changing the FOV per yaw, or adding a per-tile offset.

## Phase 8 frozen design — GLB asset pipeline + mouse-first input

Two presentation-side additions, then they are wired to the phase-7 continuous authoritative
movement. Scope is deliberately presentation/input: no farming, no inventory, no NPC behaviour.

### A. GLB / glTF asset route (client-only; the Game Protocol does not move)

The contract is NOT touched to get real art. The existing pipeline already isolates it:

```
EntityKind / TerrainKind  (game semantics, on the wire)
  -> bridge picks an AppearanceId      (presentation policy, client)
  -> runtime prefab registry resolves the AppearanceId
       -> a GLB asset, or the procedural placeholder
```

- **Asset paths, file names, model scale/orientation fixes, clip names and material tweaks live in
a client ASSET CATALOGUE inside `apps/web/src/render`** and never on the wire. The server, the
  Manager, the Router and the Organizer must remain unable to name an asset.
- Loading is runtime-internal and **asynchronous**: one load per appearance, cached, and **cloned per
  node** (`SkeletonUtils.clone` for skinned meshes, plain `clone()` otherwise) so N trees share one
  parsed model. Everything loaded is released in `dispose()` (geometry/material/texture).
- **The procedural prefab stays as the loading/fallback visual.** A slow asset renders the
  placeholder; a failed load logs and keeps the placeholder — a missing asset must never break the
  scene or produce an invisible node.
- The loader is **injectable**, so tests never touch the network, plus a **minimal GLB fixture**
  proves the real `GLTFLoader` path end to end (load → clone → place → dispose).
- **Material policy for this slice: opaque or `alphaTest` only.** Blended transparency still needs
  the (not yet built) uniform y-sorted transparent pass; a GLB with a blended material must be
  coerced to alphaTest/opaque or reported, never silently allowed to break draw order.
- Recorded extension points: DRACO/KTX2 decoder registration belongs where the loader is
  configured; instancing per `(layer, appearance)` is the existing bucket index; unused
  `RenderTransform.scale` is available for art sizing.

### B. Mouse-first interaction (client presentation/input only)

- **CameraRig**: drag to rotate (free yaw, pitch clamped to the existing 20-80 range) and wheel to
  zoom (existing 0.25-8 clamp). Pointer/wheel handling lives in the UI; the rig remains the only
  place pitch/yaw/zoom exist.
- **Click vs drag is explicit**: a click is a pointerdown->pointerup within a small movement AND
  time threshold. A drag must never emit an intent, and a click must never rotate the camera.
- **The raycast is a runtime QUERY, not an ISA primitive**: `runtime.pick(ndcX, ndcY)` returns plain
  data — `{ kind: 'node'; nodeId }`, `{ kind: 'ground'; point: Vec3 }`, or `null`. It needs the
  camera matrix, which is exactly why it can never leave the client.
- **Ground picking intersects the mathematical ground plane**, not the 100 tile plates (robust to
  the deliberate inset gaps). A hit outside `WorldBounds` produces **no intent** — no client-side
  clamping and no gameplay rule.
- **Entity picking raycasts the registered node visuals and returns a `NodeId`**: the runtime knows
  nothing about entities. The **bridge** owns the nodeId<->entityId convention and exposes the
  mapping; the **UI** turns a picked node into an interact intent.
- **The server receives world-space gameplay intents only.** No screen coordinate, NDC value, camera
  matrix, ray/plane parameter or pointer field may appear in any command. Because the wire guards
  match keys exactly, such a field is a `400`; a test asserts that.

### C. The one contract change: two new intents

```ts
interface MoveToCommand   { type: 'actor.moveTo';   target: Vec3 }          // world-space goal
interface InteractCommand { type: 'actor.interact'; targetEntityId: EntityId }
type GameCommand = MoveIntentCommand | MoveToCommand | InteractCommand;    // 1 -> 3
```

- **`moveTo` is a steering goal, not a teleport.** The Manager stores it as the current movement
  mode, integrates toward it each tick with the SAME world-space collision resolution, and clears it
  on arrival (within an arrival radius) or when blocked. A client still cannot submit a position
  that is applied directly, so the phase-7 anti-cheat property is preserved. With no pathfinding in
  scope, the actor walks a straight line and stops against an obstacle rather than routing around it.
- The direction intent and the moveTo goal **supersede each other** (exactly one current movement
  mode); the latest input wins, so WASD interrupts a click-to-move.
- **`interact` = "face the target, stop, and (today) nothing more".** The Manager validates that the
  target exists, is within `INTERACTION_RANGE` of the actor, and is interactable per a per-kind rule;
  the observed effect is the authoritative heading change plus stopping, carried by the existing
  `transform.changed` event. No new event, and the intent is not dead code: it is the prerequisite
  real interactions will build on.
- **Rejected vs no-effect (design decision, flagged for veto).** Today a refusal is an empty `events`
  array, which a client cannot distinguish from "nothing happened". Interaction needs the difference
  (out of range / not interactable must be visible). Decision: reuse the existing transport error
  path with ONE new code, **`CONFLICT` (409)**, meaning "valid request, illegal against the current
  world state", and `NOT_FOUND` for an unknown target. No new event is introduced. This is additive
  and cheap to reverse if the owner prefers silence plus a future result code.
- `PROTOCOL_VERSION` 6 -> 7.

### D. Acceptance for this phase

1. Click the ground -> the actor walks to that world point continuously and stops there.
2. Click a blocked or out-of-bounds area -> no teleport; the actor stops against the obstacle.
3. Drag rotates the view, wheel zooms, and WASD stays camera-relative after rotating.
4. Clicking an entity produces an interact intent; out-of-range or non-interactable is rejected
   visibly rather than silently ignored.
5. No command ever carries a screen/camera/ray field.
6. A GLB can be swapped in per appearance WITHOUT touching the protocol, the Manager, the Router or
   the Organizer.

### E. Phase-8 limitations and decisions recorded after review

1. **The error `message` is displayed to the player for interaction rejections.** A rejected
   interaction is a `CONFLICT` (409) whose text the client shows verbatim, so those messages are
   user-facing contract text (`Too far away.` / `Nothing to do with that.`). Other error messages
   remain developer-facing. The Organizer therefore READS the error body (`code` + `message`)
   instead of guessing a notice from the HTTP status, and the Manager docs must not claim the
   discriminated `reason` itself reaches the client (it is server-side; the reason selects the
   message). This keeps the wire shape unchanged: no new field, no new code.
2. **A `moveTo` that is immediately blocked is an accepted-but-nothing-happened no-op** (200, empty
   events, no notice): the Manager clears an unreachable goal and `CONFLICT` is deliberately limited
   to interactions. Movement therefore has no "your request could not be honoured" signal. If that
   becomes a UX problem, the fix is a decision about movement errors, not a client heuristic.
3. **Real art over HTTP has never been exercised.** The only real-file test loads the fixture from a
   `data:` URL; the `/models/*.glb` path served from Vite's `public/` (or any configured `base`) is
   untested, and the catalogue URL is passed to the loader with no base resolution. The first real
   asset may need a path fix.
4. **Clips are recorded but never played.** `idleClip`/`walkClip` are catalogue data, and a loaded
   model keeps its default pose; a real GLB will be visually static until a clip/mixer slice lands.
   That is the gap between "a GLB can be swapped in" and "a GLB looks right".
5. **One-shot intents are not serialised.** `moveTo`/`interact` do not use the movement loop's
   single-in-flight slot, so two rapid clicks can resolve out of order and a late rejection can
   overwrite a fresh notice. Low probability; revisit if rapid clicking becomes common.
6. **The loaded-model path is only partly constrained by tests:** the shadow intent now comes from
   the prefab (so a swap cannot downgrade it) and material coercion is reported, but the skinned
   clone path is verified against a synthetic skinned mesh, not a real rigged GLTF, and there is no
   DRACO/KTX2 decoding.

## Phase 7 frozen contract — continuous 3D world; the grid is an interaction layer

Corrects a modelling error from phases 4-6: `Transform` was a 2D integer tile coordinate, so the
**Actor's motion coordinate system was the tile grid**, and a 2.5D `tile -> scene` mapping was
invented inside the runtime and even leaked into the Render ISA (`RenderTransform { x, y }`).
Both are reversed here.

### Principles (not negotiable, and recorded so they are not re-broken)

1. **The Game World is a real continuous 3D world.** `2.5D` is only a `CameraRig` presentation
   constraint. It must never again appear in the Game World coordinate model, the Actor motion
   model, or the Render ISA's dimensionality.
2. **The gameplay grid/tile is a discrete interaction layer overlaid on that world** (farming,
   placement, interaction, terrain metadata). It is **not** the Actor's motion coordinate system.
3. **`Gameplay Grid != Collision System`.** Cells may *generate* colliders (an UNWALKABLE cell ->
   a world-space static AABB; that includes `blocked` and `water`), but movement legality is
decided by a **world-space** collision query against the Actor's collider, never by "is the
   target cell walkable".
4. `cellOf(position)` remains available for farming/placement/interaction/terrain lookup, and must
   never be used as the Actor's stored position.

### Axis and unit convention

`+X = East`, `+Y = Up`, `+Z = South`. Default `1 gameplay cell = 1 world unit`, but **`cellSize`
stays grid configuration and must not be hardcoded in algorithms**.

### Game Protocol value objects

```ts
interface Vec3 { x: number; y: number; z: number }        // continuous, world units
interface Quat { x: number; y: number; z: number; w: number }
interface Transform { position: Vec3; rotation: Quat }    // canonical 3D transform

interface WorldBounds { min: Vec3; max: Vec3 }            // the WORLD's bounds

// the grid is a separate concept, and cell(0,0) is deliberately NOT bound to the world origin
interface GridSpec { origin: Vec3; width: number; depth: number; cellSize: number }
interface CellCoord { x: number; z: number }              // integer cell indices on the ground plane
interface TileState { cell: CellCoord; terrain: TerrainKind }   // NO Transform: the grid holds no position
```

`Transform` is a general 3D transform: current gameplay may only produce a yaw rotation, but the
canonical type must not degenerate to `rotationY`-only. **No visual `scale` in the Game
Transform** unless it acquires gameplay semantics.

Cell centre rule (frozen, so both sides agree without guessing):

```
cellCenter.x = grid.origin.x + (cell.x + 0.5) * grid.cellSize
cellCenter.z = grid.origin.z + (cell.z + 0.5) * grid.cellSize
cellCenter.y = grid.origin.y
```

`WorldSnapshot` becomes `{ worldId, bounds: WorldBounds, grid: GridSpec, tiles: TileState[],
entities: EntityState[], controlledActorId, serverTime }`. `EntityState` keeps
`transform: Transform` (now real 3D). `PROTOCOL_VERSION` 5 -> 6.

### Command: movement intent, level-triggered

```ts
interface MoveIntentCommand {
  type: 'actor.moveIntent';
  movement: { x: number; z: number };   // desired horizontal direction, clamped to |v| <= 1
}
```

- **No `actorId` in the body.** Main deliberately deviates from the proposed shape here: the actor
  is resolved from transport context (the phase-3 invariant, verified by three reviews). Accepting
  a client-named actor would reopen the unauthenticated-actor hole. The intent means "the actor I
  control". `{ x: 0, z: 0 }` means stop.
- **Level-triggered, not one-shot:** the Manager stores the latest intent per actor and applies it
  every tick until superseded. The client therefore posts only on input CHANGE (key down/up,
  joystick change), so a 20 Hz simulation does not need 20 Hz upstream traffic.
- `movement` is a direction (magnitude <= 1 allows analog speed); the Manager multiplies by the
  actor's speed. The client is never trusted with a position.

### Events and the stream envelope

The event vocabulary is UNCHANGED (`entity.spawned`, `entity.removed`, `transform.changed`) —
continuous movement simply emits `transform.changed` once per tick for entities that moved.
`SubmitCommandResponse` is generalised/renamed to:

```ts
interface GameEventBatch { events: GameEvent[]; serverTime: string }
```

Transport: `POST COMMAND_PATH` submits an intent and returns the immediate batch (ack);
`GET STREAM_PATH = '/api/stream'` is a Server-Sent Events stream of

```ts
type WorldStreamMessage =
  | { type: 'snapshot'; snapshot: WorldSnapshot }   // sent first on every connection
  | { type: 'events'; batch: GameEventBatch };
```

The leading snapshot closes the connect race. SSE is chosen over WebSocket on purpose: zero new
dependencies, and the needed direction (server -> client state) is one-way while intents already
have a reliable request/response channel. A bidirectional socket is a later, explicit decision.

### Simulation tick

The Manager owns an authoritative fixed-step simulation of **20 Hz** (`TICK_RATE_HZ`, dt = 50 ms),
and stays PURE and testable: `step(dtMs)` advances the world and returns a `GameEventBatch`; no
timers live in the Manager. The composition root (`apps/server`) owns the interval and a tiny
fan-out, and injects a `worldStream.subscribe(listener)` port into the Router, which only forwards.

### World-space collision (no physics engine)

```
movement intent -> desired displacement (speed * |v| * dt) -> world-space collision query
                -> collision resolution -> authoritative Transform (+ authoritative heading)
```

- Actor footprint: a circle in XZ (radius 0.35 world units by default), for the first version.
- Static colliders, built ONCE at construction and never consulted as a grid at runtime:
  one AABB per UNWALKABLE cell (driven by `WALKABILITY_BY_TERRAIN`, so `blocked` **and** `water`
  cells collide), plus one AABB per blocking prop derived from its world position and a per-kind
  half-extent table (`FOOTPRINT_BY_ENTITY_KIND`; `BLOCKING_BY_ENTITY_KIND` decides which kinds get
  one).
- `WorldBounds` participates in the SAME resolution pass rather than being applied as a cosmetic
  post-clamp, so a world-edge stop slides like a wall and a clamped position can never be projected
  into a collider.
- Resolution: axis-separated (attempt the full displacement; if it intersects, try X-only then
  Z-only) so the actor slides along walls instead of sticking. Deterministic and unit-testable.
  Because the simulation is discrete-step, contact is approached to within one integrated step
  rather than exactly; tests therefore assert the invariant (never penetrates, and stops within one
  step of the surface) instead of a magic contact number.
- Y is taken from the ground/surface (flat `y = 0` for now); no gravity, no jumping, no slopes.
- Heading (rotation) is AUTHORITATIVE and follows the effective movement direction; when the intent
  is zero the last heading is kept. This removes the phase-6 presentational facing derivation.

### Render ISA

```ts
interface RenderTransform { position: Vec3; rotation: Quat; scale: Vec3 }
```

A real 3D render transform. The ISA still knows nothing about cells, tiles, terrain gameplay
semantics or farming. **The runtime places nodes at their world positions directly — there is no
tile -> scene mapping left.** `transform.setTarget` keeps its meaning (interpolate toward this
transform) and the bridge passes a duration close to the tick period so 20 Hz authority renders
smoothly at 60 fps. Client prediction/reconciliation is explicitly a LATER milestone.

### Camera

The `CameraRig` is the ONLY place 2.5D lives: follow the controlled actor, constrained pitch,
free/stepped yaw, zoom, smoothing. The Game Protocol does not know the camera exists, and camera
rotation must never change the world coordinate system. Because the camera can yaw, **input is
camera-relative**: the UI converts WASD/joystick into a world-space movement vector using the rig's
yaw, so a rotated camera keeps WASD intuitive. That mapping is UI-local.

### Deleted in this phase

One-tile `actor.move`, tile coordinates as the Actor's position, `WorldSize { width, height }` as the
world's definition, `TileState.transform`, the runtime's `tile -> scene` mapping, and the
presentational facing derivation.

### Acceptance

Continuous world-space movement in a real 3D world: hold input -> intent -> authored tick
simulation -> world-space collision -> authoritative 3D transform -> Organizer -> Render ISA ->
ThreeRuntime interpolation. The grid still exists, but **hiding the debug grid entirely must not
affect movement at all**, and WASD must stay intuitive after rotating the camera.

Out of scope for this milestone: client prediction + server reconciliation (next, separate),
farming, inventory, NPCs, persistence, a physics engine.

### Phase-7 known limitations (recorded after review)

1. **No correlation metadata for reconciliation.** `GameEventBatch` / `TransformChangedEvent` carry
   no tick or sequence number, and nothing carries a "last processed input sequence". Client
   prediction + server reconciliation therefore cannot be implemented until that is designed — it is
   the single largest piece of work left and a protocol decision, not a transport one. SSE (one-way)
   + intent POST is sufficient for the no-prediction milestone because `EventSource` rebuilds state
   from the leading `snapshot`, and intents already have a reliable ordered channel.
2. **The movement intent is a single slot**, not per-actor. Correct today: the Manager is
   constructed with exactly one actor and rejects any other. A real per-actor intent store is
   required before a second actor exists.
3. **Every tick fans out a frame even when the batch is empty** (~20 empty frames/s/client at rest,
   ~3 KB/s). Harmless today (`applyEvents` early-returns) and the per-tick `serverTime` is arguably
   useful, but it is an explicit decision to make before the stream is scaled.
4. **The composition root (the 20 Hz interval, the fan-out, the shutdown path) has no automated
   test.** The integration suite re-implements the tick loop to stay deterministic, so a regression
   in `apps/server`'s wiring (wrong `dt`, missing fan-out) would not be caught by CI. It is verified
   only by a live run.
5. **`cellOf` has no production call site yet.** It is a deliberate reservation (like `PlayerId`),
   exported and tested because farming/placement/interaction are defined in terms of "the cell of a
   position", and it is the inverse of `cellCentre` which the client and the collider generator use
   today. If the farming/placement slice does not consume it, delete it rather than carrying it.

## Phase 6 frozen contract — 2.5D rendering foundation (UI-led milestone)

The lower layers are verified; the client is still a box tech demo. This milestone turns it into
a grey-box 2.5D scene that shows the intended direction. It is a **presentation** milestone: the
work happens in the bridge / Three runtime / UI, and the game contract changes only where the
existing abstraction genuinely cannot express required world semantics.

### Protocol delta — vocabulary only, ZERO new instructions

The only changes, both enum members (data), are the minimum needed to satisfy the visual
requirements. No new **game-protocol** command, no new game-protocol event, and no new
instruction of any kind. (The Render ISA separately gained back `animation.play` — see below;
that is an in-process presentation primitive, not a wire instruction, and it is called out
rather than glossed so the claim stays checkable.)

- `TerrainKind` gains `'water'`; `WALKABILITY_BY_TERRAIN.water = false`. Justification: `terrain`
  is the only per-tile semantic on the wire, so with a single generic `'blocked'` value water and
  rock are indistinguishable to the presenter. Modelling note, recorded: `'blocked'` is really a
  *property* (impassable), not a ground kind; when real terrain art lands, prefer concrete kinds
  (`rock`) over a generic `blocked`.
- `EntityKind` gains `'tree'`. Justification: the phase requires a raised world object to validate
  occlusion and the `WorldObjects` scene group, and a tall object cannot be terrain without
  conflating `` terrain `` with `` object ``. This also makes "how do trees/crops/buildings/NPCs
  plug in" a demonstrated path instead of a designed one.
- `PROTOCOL_VERSION` 4 -> 5. Both additions are incompatible under exact-key/exact-union guards.

### Manager delta

- The world map legend gains `w` (water, unwalkable) and `T` (a tree standing on grass). The map
  stays a fixed literal 10x10 layout; no procedural generation, no streaming.
- `entities` becomes a real **collection** (the actor plus static props), still delivered whole in
  the snapshot (props are part of the initial world, so they need no `entity.spawned` event).
- A SECOND authoritative rule joins terrain walkability:
  `BLOCKING_BY_ENTITY_KIND = { character: false, tree: true }`. A move is refused if the target
  terrain is unwalkable **or** a blocking entity occupies the target tile. Same refusal semantics
  (empty `events`, transform untouched). `character: false` is deliberate (a single actor cannot
  block itself, and multi-actor blocking is a later decision).

### Render ISA delta — `animation.play` returns, with a real producer

`animation.play { nodeId, animation: AnimationId, loop }` plus `AnimationId` are re-added.

This is a deliberate reversal of the phase-4 deletion, and the phase-4 criterion is what makes it
legitimate: that criterion was "no producer AND no driving state", and it is now false. The bridge
has a real driving state — whether a visual move is in flight — so it emits `idle`/`walk` for the
actor, and the runtime records the current animation in `inspect()` so it is **observable** rather
than write-only. Re-adding a primitive because a checklist mentions it would still be wrong; this
is re-adding it because a driving state now exists.

### 2.5D rendering model (decided by Main, implemented by the UI owner)

- **Orthographic**, not perspective. A fixed view with no perspective distortion keeps tile shape
  uniform across the small map, makes depth sorting stable, and is the standard 2.5D look.
- **Front-facing, tilted down.** No yaw (camera looks along -Z), pitch about 55-60 degrees down.
  So tile `+y` (south) moves toward the camera and appears lower on screen: depth is a pure
  function of tile `y`, which is what makes occlusion predictable without per-object hacks.
- **Y-up world; ground lies in the XZ plane.** `tile (x, y) -> render (x, 0, y)`, i.e. `+y` tile is
  `+z` render (toward the camera). This mapping lives ONLY in the runtime — Protocol never sees a
  render coordinate, and `RenderTransform` keeps carrying tile coordinates.
- **Camera follows the controlled actor** with light smoothing. The follow target is runtime
  configuration (`setFollowTarget(nodeId)`), NOT a new ISA primitive: the ISA describes scene
  content, the camera is a viewer. If multi-camera or cutscenes arrive, that is when a `camera.*`
  primitive should be considered.

### Scene graph

```
Scene
├─ WorldRoot
│   ├─ Terrain        // layer: 'base'
│   ├─ WorldObjects   // layer: 'object' + a prefab whose group is WorldObjects (tree)
│   ├─ Actors         // layer: 'object' + a prefab whose group is Actors (character)
│   └─ Effects        // empty today; reserved so one-off visuals need no new group
├─ CameraRig          // orthographic camera + follow target
└─ Lights             // sun (directional, casts shadows) + ambient fill
```

Which group an object-layer node belongs to is decided by the runtime's PREFAB registry for that
appearance id, not by a game concept on the wire. That is why a tree and an NPC can live in
different groups while the ISA only knows "a node with an appearance in a layer".

### Depth / occlusion policy (no per-object z-index patching, ever)

- Use a **real 3D depth buffer**: opaque geometry plus a tilted orthographic camera resolves
  occlusion geometrically. There is no hand-written z per business object, and none may be added.
- `layer` remains for coarse ordering (terrain behind objects) and is applied as a depth offset
  inside the runtime, not by callers.
- Placeholder visuals are OPAQUE (alpha-tested at most) precisely so the depth buffer does the
  work. Recorded consequence: real sprite/billboard art with alpha transparency will need a
  y-sorted render pass — that is a runtime-internal policy applied uniformly to every transparent
  node, still not per-object z patches.

### Actor presentation

- A visual root `Group` per node, anchored at the FEET (tile centre, y = 0), so scale/rotation/
  animation compose without moving the anchor.
- Facing is derived presentationally from the visual movement delta (the runtime rotates the visual
  root). **Authoritative facing does not exist yet** and is recorded as a future protocol addition
  (it matters for "which tile do I interact with", which is gameplay, not presentation).
- **Authoritative vs visual transform are separate**: the runtime interpolates toward the last
  `transform.setTarget`; the visual position is never reported back as authoritative. Movement is
  therefore smooth without introducing prediction.

### Asset abstraction

A runtime-internal **prefab registry**: `AppearanceId -> prefab { group, realisation, footprint,
height, material }`. Prefabs are composed from standard Three.js primitives (no custom shaders, no
external art assets). Swapping to a sprite atlas, billboards, GLTF, or instanced meshes is a
registry change confined to the runtime, because the ISA only ever names an appearance.

Qualification (recorded after review): "registry-only" is fully true for a sprite atlas, a
billboard realisation, or a GLTF prefab, but **instancing additionally requires changing the
per-node bookkeeping** — the runtime today keeps one `Group`/visual per node (a `nodes` map plus
the tile↔scene inversion in `inspect()`), and an instanced renderer would batch those away. The
`(layer, appearance)` bucket index is the key that makes that change local, not the whole change.

### Explicitly out of scope

Farming, inventory, NPC behaviour, accounts, persistence, procedural worlds, large-map streaming,
production art assets, complex shaders.

## Phase 5 frozen contract — World / Tile / Collision (reusing the phase-4 primitives)

The goal is to prove the two ISAs can carry a NON-actor world object without growing new
instructions. Main froze the following before implementation.

### Model

```ts
type WorldId = string & brand            // world identity (branded, like the other ids)
type TerrainKind = 'grass' | 'blocked' | 'path'   // 'path' is walkable but visually different
interface TileState { transform: Transform; terrain: TerrainKind }

interface WorldSnapshot {
  worldId: WorldId
  size: WorldSize
  tiles: TileState[]          // static terrain
  entities: EntityState[]     // dynamic world objects (actor, later NPCs/items/crops)
  controlledActorId: ActorId | null
  serverTime: string
}
```

`PROTOCOL_VERSION` 3 -> 4: adding required `worldId`/`tiles` fields is an incompatible change
(guards are exact), exactly as the phase-4 notes predicted.

### Decisions (and the reasoning that must not be silently reversed)

1. **Tiles are static terrain in their own collection, NOT entities.** Terrain does not move,
   spawn or despawn, so making it an entity would force `EntityState` to grow a terrain field and
   would make the entity lifecycle meaningless for static data. `entities` stays "things the
   server can create/destroy", `tiles` is "the world's shape".
2. **Walkability is NOT on the wire.** The wire carries `terrain` (a world fact). Whether a
   terrain is walkable is a Manager rule (`WALKABILITY_BY_TERRAIN`), because collision is
   authoritative gameplay. Shipping `walkable` today would invite client-side collision rules,
   which this phase explicitly forbids. Consequence, recorded deliberately: client-side
   prediction will need either this field or a shared rule module — that is a later, deliberate
   decision, not an oversight.
3. **No new commands and no new events.** Terrain is static, so movement stays `actor.move` and
   collision becomes an additional Manager rule on the same command. `entity.spawned` /
   `entity.removed` remain for dynamic objects only.
4. **Tiles are not protocol instructions.** There is no per-terrain command or event; there is one
   `terrain` enum value per tile and nothing else. Adding a terrain is a data + appearance
   change, not a new instruction.
5. **The actor's world is the snapshot's scope.** `worldId` sits on the snapshot, so "which world
   is the actor in" is implied and needs no per-entity field. A per-entity `worldId` is the
   multi-world extension point, not something to add now.
6. **Fixed 10x10 map, defined as a literal layout in the Manager** (an ASCII map: `g` grass,
   `p` path, `#` blocked). No procedural generation, no chunk streaming, no biome/height/
   buildings/crops. The actor spawns on a walkable tile (an invariant the Manager must hold:
   an unwalkable spawn is a configuration error).

### Collision

```
actor.move -> Manager resolves the target transform
           -> out of bounds            -> refusal
           -> target terrain unwalkable -> refusal
           -> otherwise: update the authoritative transform, emit transform.changed
refusal == empty events array (unchanged phase-4 semantics; still no 'moved' boolean)
```

A client cannot bypass this: the command carries no destination and no actor, so there is no way
to submit a final coordinate. The only movement input is a direction, and the destination is
computed by the Manager.

### Render ISA: exactly ONE addition

`node.create` gains `layer: RenderLayer` with `RenderLayer = 'base' | 'object'`.

Why it is needed now, not speculation: with terrain and actors both created at the same depth,
draw order is undefined (z-fighting / the actor can be drawn under the tiles). A render-layer
bucket is a pure render concept — it names no game thing — and it is the natural key for later
batching (see below). Nothing else in the ISA changed: no tile primitive, no terrain primitive,
no collision primitive.

### Tile rendering and the upgrade path (no server protocol change)

Terrain reaches the renderer as ordinary render nodes:

```
WorldSnapshot.tiles -> Organizer TileViewModel -> bridge -> node.create { layer: 'base',
                       appearance: <terrain appearance id> }
WorldSnapshot.entities -> bridge -> node.create { layer: 'object', appearance: <kind appearance id> }
```

The ISA stays business-free: it knows "a node with an appearance in a layer", never "a grass
tile". Therefore the visual upgrade path is entirely inside the runtime:

- **now**: one placeholder mesh per node, appearance -> colour.
- **later (quality)**: appearance -> sprite/atlas frame, instanced meshes batched by the
  `(layer, appearance)` bucket, chunked terrain meshes. All of it is runtime-internal, so the
  server contract and the bridge's command stream do not change. This is the concrete payoff of
  keeping the ISA declarative.

### Who owns chunking / visibility / batching when the map grows

- **Render batching, instancing, atlas frames, chunk meshes, frustum culling of the scene**: the
  Three.js runtime (an ISA executor detail).
- **Deciding which nodes should exist at all** (e.g. only the visible region): the render bridge
  (client) — it can emit `node.create`/`node.destroy` as the viewport moves, using the same
  primitives.
- **Deciding which world data the server sends** (interest management, viewport-scoped tile
  queries): a later, explicit *protocol* change, because it changes what crosses the wire.
  Chunking is therefore split: rendering-side is free, data-side needs a contract.

## Phase 4 frozen contract — primitive-driven architecture (two instruction sets)

A feature is now expressed by **composing primitives**, not by adding a bespoke endpoint pair
per feature. There are exactly two instruction sets, and neither may know the other's
implementation:

- **Game Protocol** (`@starvalley/protocol`) — game-semantic primitives crossing client <-> server.
  A real wire contract: serialized, guarded, versioned.
- **Render Protocol** (`@starvalley/render-protocol`) — render primitives crossing
  Organizer world state -> render runtime. **In-process, not serialized, not versioned, no
  runtime guards** (guards exist for untrusted wire data; this ISA is typed in-process).

Three.js is merely one **executor** of the Render Protocol. It is not part of any contract.

### Game Protocol primitives

```ts
// value objects
Transform    { x: number; y: number }
EntityKind   = 'character'                    // closed union, grows as features land
EntityState  { entityId: EntityId; actorId: ActorId | null; kind: EntityKind;
               transform: Transform; visible: boolean }
WorldSnapshot { size: WorldSize; entities: EntityState[];
                controlledActorId: ActorId | null; serverTime: string }

// commands (discriminated union on `type`; no `action: string` + `args: unknown`)
type GameCommand = ActorMoveCommand
ActorMoveCommand { type: 'actor.move'; direction: MoveDirection }   // no actor field

// events (discriminated union on `type`)
type GameEvent = EntitySpawnedEvent | EntityRemovedEvent | TransformChangedEvent
EntitySpawnedEvent    { type: 'entity.spawned';    entity: EntityState }
EntityRemovedEvent    { type: 'entity.removed';    entityId: EntityId }
TransformChangedEvent { type: 'transform.changed'; entityId: EntityId; transform: Transform }

// transport
WORLD_PATH    = '/api/world'     // GET  -> GetWorldResponse { world: WorldSnapshot }
COMMAND_PATH  = '/api/command'   // POST GameCommand -> SubmitCommandResponse
SubmitCommandResponse { events: GameEvent[]; serverTime: string }
```

Rules that make it an instruction set rather than an RPC surface:

- Every command and event is its own strongly-typed interface in a discriminated union. There
  is no `action: string` and no `args: any`/`unknown` catch-all, ever.
- **No rendering concept appears here**: no mesh, material, node, animation, camera, or colour.
  `EntityKind` is a game label; what it *looks like* is decided by the render bridge.
- **A refused command produces no events.** An empty `events` array *is* the refusal — there is
  no `moved` boolean. A step into a wall changes nothing observable.
- Events are the authoritative delta; the snapshot is full state (initial load and recovery).
- `controlledActorId` states which actor the caller controls, instead of assuming a single
  `actor` field — this removes the phase-2 single-actor assumption from the contract.
- Adding an entity kind is a semantic change and (because guards are exact) a version bump;
  `PROTOCOL_VERSION` goes 2 -> 3 for this reshape.

### Render Protocol primitives (Render ISA)

```ts
NodeId, AppearanceId                  // nominal ids; a NodeId is NOT an EntityId
RenderTransform { x: number; y: number }

type RenderCommand =
  | NodeCreate     { type: 'node.create';       nodeId; appearance: AppearanceId; transform; visible }
  | NodeDestroy    { type: 'node.destroy';      nodeId }
  | TransformSet   { type: 'transform.set';     nodeId; transform }
  | TransformSetTarget { type: 'transform.setTarget'; nodeId; transform; durationMs: number }
  | AppearanceSet  { type: 'appearance.set';    nodeId; appearance: AppearanceId }
  | VisibilitySet  { type: 'visibility.set';    nodeId; visible: boolean }

type RenderFrame = readonly RenderCommand[]    // an ordered diff, applied in order
```

Rules:

- The ISA says *what the scene should contain*, never *how Three.js does it*. No `Object3D`,
  no `Vector3`, no matrix, no material type appears in it.
- `transform.set` is instant (spawn/teleport/snap); `transform.setTarget` + `durationMs` asks
  the runtime to interpolate. Render-side interpolation of an **authoritative** position is not
  client prediction.
- Appearance is an opaque id: the runtime owns the catalogue, the bridge chooses ids, and the
  bridge's emitted ids are asserted to be a subset of the runtime's known catalogue. (There is no
  animation primitive: `animation.play`/`AnimationId` were deleted because nothing could drive
  them and their only honest implementation was unobservable state.)
- A runtime must handle every command exhaustively (a `switch` with a `never` check), so adding
  a primitive is a compile error in every runtime until implemented.

### Ownership and dependency direction after phase 4

```
apps/web/src/ui/            SceneView: canvas + wiring only
   │  imports: ../organizer, ../render/bridge, ../render/three/runtime
   ▼
apps/web/src/render/bridge.ts          pure world state -> RenderFrame   (NO Three.js)
   │  imports: ../organizer (barrel), @starvalley/render-protocol
   ▼
apps/web/src/render/three/runtime.ts   the ONLY module importing three
   │  imports: @starvalley/render-protocol, three      (NEVER ../organizer)
   ▼
@starvalley/render-protocol            types only; framework-free
```

Enforced by `eslint.config.js`: the Render ISA may not import Three/React/Node/game protocol;
the bridge may not import Three, the game protocol, the backend or UI components; the Three
runtime may not import the Organizer (it must not know game semantics) and is the only place
`three` is importable; the Organizer may not import the Render ISA or Three; UI may not import
Three, the Render ISA, the game protocol, or Organizer internals.

### Movement, expressed as primitive composition (the migration case)

```
UI click / keypress
  -> organizer.moveActor(direction)                    [UI intent; no wire detail]
  -> GameCommand { type: 'actor.move', direction }      [protocol]
  -> POST COMMAND_PATH                                  [router]
  -> manager.submitCommand({ actorId, command })         [authoritative rules]
       -> GameEvent { type: 'transform.changed', entityId, transform }
  -> organizer applies the event to its entity state
  -> bridge: state -> RenderFrame
       node.create (first sight) / transform.setTarget { durationMs }
  -> three runtime applies the frame to the scene graph
```

Adding planting, NPCs, trees, items or animations should be new *kinds*, new commands, or new
events composed from these primitives — not a new per-feature endpoint pair.

### Primitive stability (Main's assessment at phase-4 close)

Classification is by whether a producer exists **today**, not by whether the primitive is
implemented.

**Triggered by the current game (stable core):** `actor.move` (command), `transform.changed`
(event), `node.create`, `transform.setTarget` (render). Movement is exactly this composition.

**Wired but not yet triggered (real producers exist in code; current game state never changes
the relevant field):**
- `node.destroy` — emitted whenever an entity disappears from the entity list.
- `visibility.set`, `appearance.set` — emitted by the bridge's diff of the per-entity fields
  `visible` and `kind`, both of which the game contract already carries. Nothing flips them yet.

**Deleted in this slice (no producer, no driving state):**
- `animation.play` — there was no animation data, no clip catalogue and no entity field that
  could drive it, and its runtime implementation wrote unobservable state. Keeping a primitive
  whose only honest implementation is a silent no-op is exactly the over-abstraction this phase
  asked to avoid. Re-adding it is additive and cheap (the Render ISA is in-process).

**Declared with no producer, kept deliberately (with the cost stated):**
- `transform.set` — the instant counterpart of `transform.setTarget`, needed the first time an
  entity must be snapped rather than interpolated (respawn/teleport). `node.create` carries the
  initial transform, so nothing emits it today. Unlike `animation.play` it *is* fully
  implementable and observable (`inspect()` reads real node positions), so it is a reservation
  rather than dead weight.
- `entity.spawned` / `entity.removed` — no despawn and no runtime entity creation exist. Kept
  because the snapshot cannot express "this went away" as a delta, and because a client that
  cannot remove a node leaks it. Note the asymmetry: keeping them costs nothing at runtime, but
  *deleting* them later is a `PROTOCOL_VERSION` bump because the game contract's guards are
  exact.

Rule going forward: a primitive with no driving state and no producer should be deleted, not
kept "for completeness" — and a null implementation is a stronger delete signal than a missing
producer.

### Phase-4 known limitations and verified-risk gaps

Recorded so they are not mistaken for solved problems:

1. **A disposed render runtime is not re-mountable.** `mount()` is a no-op while already mounted,
   but after `dispose()` a second `mount()` is unsupported (the scene composition it released is
   not rebuilt). `SceneView` always constructs a fresh runtime per mount, so this is unreachable
   today; the contract is documented in the runtime rather than guarded, because a guard cannot be
   tested without a WebGL context and untested defensive code is its own liability.
2. **Two sequential `WebGLRenderer`s on one canvas (React StrictMode remount) is unverified.**
   jsdom has no WebGL, so this needs a manual browser check; `forceContextLoss()` is deliberately
   not called. The code says so rather than claiming it is handled.
3. **Canvas resize/aspect is unexercised by the test suite.** The uniform-scale projection fixes
   the vertical extent at the world height and derives the horizontal extent from the canvas
   aspect, so on a canvas narrower than the world's aspect ratio the world is horizontally
   cropped rather than squashed. That is the intended trade-off (square tiles over full
   visibility), and it needs a manual browser check.
4. **`transform.set`, `entity.spawned` and `entity.removed` are declared with no producer** — see
   the primitive-stability notes above for why each is kept.

### Reserved identity vocabulary: outcome after the Tile/World slice

When this vocabulary was added, `EntityId`/`isEntityId`/`parseEntityId` and
`PlayerId`/`isPlayerId`/`parsePlayerId` had no production consumer, and the plan was to trim
whatever the Tile/World slice failed to consume. Recording the outcome (phase 5 is that slice):

- `EntityId` **earned its keep** and stays: the actor is an entity that can act, so the Manager
  builds one with `parseEntityId` and the entity guards consume it.
- `PlayerId` **still has no consumer** and stays only as declared vocabulary for the session
  slice. This is the last reservation of this kind: if the session slice does not consume it
  either, delete it rather than carrying it further.

### Adding fields to `WorldSnapshot` is a breaking change

All payload guards use exact-key matching (`hasExactKeys`), so **adding** a field is an
incompatible change that requires a `PROTOCOL_VERSION` bump. Phase 4 predicted this and phase 5
did it for real: adding `worldId` and `tiles` forced 3 -> 4, and a test pins that the phase-4
snapshot shape is now rejected. That is a
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
4. **~~The world has no terrain.~~ RESOLVED IN PHASE 5.** `WorldSnapshot` now carries `worldId`
   and `tiles` (`TileState { transform, terrain }`), the Manager holds a real 10x10 map, and
   collision is enforced authoritatively against `WALKABILITY_BY_TERRAIN`. What is still NOT
   built: other terrain besides `grass`/`path`/`blocked`, elevation, buildings, crops, more than
   one map, and any client-side collision/prediction.
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
