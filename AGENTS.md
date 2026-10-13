# Web Stardew Multi-Agent Engineering Policy

This repository uses `pi-subagents` as the default implementation workflow.

The parent Pi session is the **Main / Coordinator**. It owns orchestration, task decomposition, routing, arbitration, integration, and final acceptance. It should not become the routine implementation agent when a specialist owner exists.

For repository implementation tasks, delegation to the specialist agents below is explicitly authorized and expected.

## Permanent specialist roles

- `ui` — client presentation, Three.js rendering, UI components, input, visual interaction
- `organizer` — client data organization, state, remote requests, realtime sync, protocol-to-view-model mapping
- `protocol` — canonical cross-boundary contracts and shared domain semantics
- `router` — backend transport boundary: HTTP/WebSocket/RPC adapters, validation, auth/session extraction, request/response mapping
- `manager` — backend application/domain execution, persistence, transactions, authoritative runtime rules

A built-in reviewer may be used as an ephemeral QA role after implementation. It is not a module owner.

## Architecture

The intended dependency direction is:

```text
UI
 │
 ▼
Organizer
 │
 ▼
Protocol  <---- canonical cross-boundary contract
 ▲
 │
Router
 │
 ▼
Manager
```

More precisely:

```text
UI -> Organizer
Organizer -> Protocol
Router -> Protocol
Router -> Manager
Manager -> Protocol only where shared contract/domain types are appropriate
Protocol -> no application-specific module
```

Forbidden shortcuts:

```text
UI --------X-------> Router / Manager / network transport
UI --------X-------> persistence
Organizer -X-------> backend implementation files
Router ----X-------> client implementation files
Router ----X-------> persistence/business rules
Manager ---X-------> HTTP/WebSocket framework details
Any role --X-------> silently redefine Protocol contracts
```

## Ownership rules

Each specialist edits its owned module by default.

If a task requires changes outside its ownership:

1. Do not silently make the cross-owner change.
2. Use `contact_supervisor` with a concise structured request.
3. Main decides whether to spawn/steer the owning agent.
4. Main keeps the cross-module dependency visible until resolved.

Small mechanical changes outside ownership may be allowed only when Main explicitly grants them in the task.

## Main / Coordinator responsibilities

Main must:

1. Understand the user goal and acceptance criteria.
2. Determine which module owners are affected.
3. Identify whether a protocol change is required.
4. If the cross-boundary contract changes, run `protocol` first far enough to establish the contract.
5. Once interfaces are stable enough, run independent owners in parallel when they touch disjoint files.
6. Route child questions through the supervisor channel.
7. Avoid copying large implementation details into Main context; preserve only decisions, blockers, interfaces, and acceptance state.
8. Run integration checks after module work completes.
9. Use a fresh reviewer for material multi-module changes when practical.
10. Summarize what changed, what was verified, and any unresolved risks.

Main should not directly implement substantial UI, Organizer, Protocol, Router, or Manager work unless:
- the user explicitly asks Main to do it, or
- the change is tiny integration glue and delegation overhead would clearly exceed the work.

## Recommended execution order

For a feature that crosses client and server:

```text
1. Main clarifies goal and acceptance criteria
2. Protocol determines/changes the contract if needed
3. Main freezes the minimum usable contract for this task
4. Parallel where safe:
   - UI
   - Organizer
   - Router
   - Manager
5. Main integrates
6. Relevant tests/typechecks/builds
7. Fresh review
8. Fix review findings with the owning agent
9. Final acceptance
```

Not every feature needs all five agents.

Examples:

- CSS/layout-only change -> `ui`
- client cache/request lifecycle change -> `organizer`
- new request/event/DTO -> `protocol`, then affected implementers
- endpoint wiring/auth extraction -> `router`
- persistence/game-rule execution -> `manager`

## Protocol-first rule

When a feature changes anything crossing the client/server boundary, `protocol` is the authority for:

- request/command shapes
- response/result shapes
- events
- DTOs
- error codes
- shared identifiers
- serialization-relevant enums
- cross-boundary invariants
- compatibility/versioning decisions

Implementation agents must not invent a wire field or event locally and "fix protocol later."

Protocol should define the **minimum stable contract** needed to unblock implementation; it does not need to finish every downstream implementation before other agents start.

## Layer rules

### UI
UI renders and collects intent. It does not know how the backend is called.

UI talks to Organizer through view models, selectors, actions, commands, callbacks, or a similarly explicit client application API.

**UI placement policy (owner decision):** feature UI lives **inside the world window**, as DOM/CSS layered over the WebGL canvas (the in-world HUD overlay), not in panels beside or below the canvas. An affordance may live outside the HUD **only** when it is explicitly debug-only. Consequence for delegation: a new user-facing control is a HUD task, and "add a panel under the canvas" is not an acceptable default.

Camera rig parameters (pitch/yaw/zoom) are **presentation**, not game state: the HUD drives them straight into the render layer's rig API, exactly as drag-orbit and wheel-zoom already do. Gameplay actions (move/interact) still go through the Organizer. A camera setting must never be modelled as a Protocol field.

### Organizer
Organizer is the client application layer.

It owns:
- client state
- normalized/cache data
- request lifecycle
- HTTP/WebSocket client calls
- retry/reconnect policy
- optimistic/predicted client state where appropriate
- mapping Protocol data into UI-facing view models
- mapping UI intent into Protocol requests/commands

Organizer must not contain Three.js rendering implementation or backend business logic.

### Protocol
Protocol is the canonical shared contract.

It should remain framework-neutral and side-effect-light. It must not depend on React, Three.js, HTTP server frameworks, database drivers, or persistence implementations.

### Router
Router is the server transport adapter.

It owns:
- endpoint/socket/RPC registration
- deserialization and validation
- auth/session/context extraction
- transport-level error mapping
- invoking Manager
- serializing results/events

Router must be thin. It does not own game rules, transactions, or persistence.

### Manager
Manager executes authoritative server behavior.

It owns:
- use cases/application services
- runtime game-rule enforcement
- transactions
- repositories/persistence
- server-side scheduling/ticks/jobs where relevant
- coordination of domain operations

Manager receives typed inputs and returns typed results. It must not depend on HTTP/WebSocket request objects or client UI concerns.

## Parent-child communication

Use the native `pi-subagents` supervisor channel.

Child -> Main:
- `contact_supervisor(reason: "need_decision", ...)` for blocking decisions
- `contact_supervisor(reason: "progress_update", ...)` for meaningful plan-changing progress

Main -> child:
- reply through the supervisor channel when the child is waiting
- steer/follow-up a running child when its task needs correction or new information

Do not assume sibling-to-sibling messaging exists. Main is the router.

Keep messages compact. Prefer this shape:

```text
TYPE: NEED_PROTOCOL_CHANGE | NEED_ORGANIZER_API | NEED_MANAGER_API | BLOCKED | RISK | PROGRESS
FROM: <role>
BLOCKED: yes|no
NEED: <one concrete thing>
WHY: <brief reason>
AFFECTS: <roles/files/contracts>
PROPOSAL: <optional proposed solution>
```

## Parallelism policy

Parallelize only when ownership and dependencies are clear.

Good:
- UI builds against an agreed Organizer interface while Manager implements persistence
- Organizer and Router implement opposite sides of a frozen Protocol contract
- UI and Router work in separate files

Bad:
- Organizer and Protocol both editing the same contract simultaneously
- Router and Manager both changing the same service file
- multiple agents "cleaning up" shared files at once

When file overlap is likely, serialize the work or use isolated worktrees.

## Definition of done

A multi-module task is not done until:

- the canonical Protocol matches both sides
- no role violated a forbidden dependency
- focused tests/typechecks/build checks pass
- integration behavior is verified where practical
- material review findings are resolved or explicitly accepted
- Main can explain which module owns each changed behavior

## Context discipline

Use fresh child context by default.

Persistent truth belongs in:
- source code
- Protocol schemas/types
- tests
- repository documentation
- ADRs when decisions are architectural

Do not rely on a child remembering a prior session for correctness.
