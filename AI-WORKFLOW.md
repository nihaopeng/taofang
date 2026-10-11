# Bootstrapping the Web Stardew AI Development Workflow

This repository is configured for one Main Pi session coordinating five project-local specialist subagents:

```text
Main / Coordinator
├── ui
├── organizer
├── protocol
├── router
└── manager
```

The project-level policy is in `AGENTS.md`.
Agent definitions are in `.pi/agents/*.md`.

## 1. Install Pi

On macOS/Linux:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Or with npm (Node.js 22.19+):

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Authenticate in Pi with your preferred supported provider:

```bash
pi
```

Then use `/login` if needed and select a model with `/model`.

## 2. Install pi-subagents

From your project root:

```bash
pi install npm:pi-subagents
```

You can verify installed packages with:

```bash
pi list
```

Restart Pi after installation if it was already open.

## 3. Put the workflow files in the repository

Required:

```text
your-repo/
├── AGENTS.md
└── .pi/
    └── agents/
        ├── ui.md
        ├── organizer.md
        ├── protocol.md
        ├── router.md
        └── manager.md
```

`AI-WORKFLOW.md` is only operator documentation; Pi does not require it.

If Pi asks whether you trust the project, trust it only after you have reviewed the repository and these instructions.

## 4. Start Main

Always start Pi from the repository root:

```bash
cd /path/to/your-repo
pi
```

`AGENTS.md` authorizes Main to use subagents for repository implementation work.

The five custom agents use:

- `advertise: true` so Main can discover them
- `defaultContext: fresh` to keep child context isolated
- `inheritProjectContext: true` so they receive the shared architecture policy
- `inheritSkills: false` so unrelated global/project skills do not flood their context
- `maxSubagentDepth: 0` so specialists do not create their own organizations

## 5. Verify the setup

Inside Pi:

```text
Check whether subagents are configured correctly.
```

or:

```text
/subagents-doctor
```

Then:

```text
Show me the available subagents.
```

You should see the project roles:

```text
ui
organizer
protocol
router
manager
```

along with any builtin agents shipped by the extension.

For active/background work:

```text
/subagents-fleet
```

## 6. First real prompt

Use Main as your only normal human entry point.

Example:

```text
Implement crop planting end to end.

Use the repository's multi-agent policy.
First inspect the existing architecture and acceptance surface.
Delegate work to the owning agents.
If a client/server contract change is needed, have protocol establish the minimum contract first.
Then parallelize disjoint UI/Organizer/Router/Manager work where safe.
Route child blockers through the supervisor channel.
Run relevant tests/typechecks and a fresh review before declaring the task complete.

Acceptance:
- player can choose a seed and plant a valid tile
- server is authoritative
- inventory and crop creation are atomic
- client updates correctly after success
- failures produce a stable user-visible state
```

Main should decompose and delegate instead of implementing all layers itself.

## 7. Expected lifecycle

Typical cross-stack feature:

```text
User
 │
 ▼
Main
 │
 ├─> protocol
 │      └─ contract ready
 │
 ├──────────── parallel when safe ─────────────┐
 │                                             │
 ├─> ui                                        │
 ├─> organizer                                 │
 ├─> router                                    │
 └─> manager                                   │
                                               │
                    blockers/questions ───────> Main
                                               │
Main <──────────────── results ────────────────┘
 │
 ├─ integration checks
 ├─ fresh review
 ├─ fixes routed to owner
 ▼
final acceptance
```

## 8. How child communication works

Do not design around sibling chat.

A child that needs another module uses the supervisor path and sends Main a structured request.

Example from Organizer:

```text
TYPE: NEED_PROTOCOL_CHANGE
FROM: organizer
BLOCKED: yes
NEED: CropState needs growthStage
WHY: client cannot render authoritative crop progression
AFFECTS: protocol, router, manager, ui
PROPOSAL: add growthStage as a serialized enum
```

Main then sends/spawns the appropriate owner.

This keeps:
- authority explicit
- cross-module decisions visible
- child contexts isolated
- Main focused on routing rather than implementation details

## 9. Day-to-day prompts

Feature:

```text
Implement <feature>. Use the project multi-agent workflow and delegate by ownership. Protocol first if the boundary changes. Parallelize only disjoint work. Integrate, test, and review.
```

Bug:

```text
Investigate <bug>. Use the relevant owners. Do not assume which layer is wrong. Trace UI -> Organizer -> Protocol -> Router -> Manager, then assign the fix to the actual owner and review the result.
```

Refactor:

```text
Refactor <area> without changing behavior. Keep ownership boundaries intact. Delegate only to affected owners, run focused verification, and use a fresh reviewer for boundary violations.
```

Architecture change:

```text
Evaluate this architecture change before editing. Ask the affected owners for bounded analysis, have Protocol assess cross-boundary impact, then Main should synthesize one plan for approval.
```

## 10. When to add Skills later

Do not add module Skills just because Skills exist.

Keep each role in `.pi/agents/<role>.md` until a role accumulates large reusable knowledge such as:

- Three.js performance cookbook
- state-management migration playbook
- protocol compatibility/versioning handbook
- router security/auth checklist
- database/performance runbooks

Then move large HOW-to material into a private role Skill and keep the agent file focused on:

```text
WHO
SCOPE
AUTHORITY
BOUNDARIES
ESCALATION
DONE
```

## 11. Repository path customization

The supplied agent files deliberately describe conceptual ownership rather than forcing a specific folder layout.

Once the codebase stabilizes, tighten each agent with exact paths, for example:

```text
ui:
  apps/web/src/ui/**
  apps/web/src/render/**

organizer:
  apps/web/src/state/**
  apps/web/src/services/**
  apps/web/src/sync/**

protocol:
  packages/protocol/**

router:
  apps/server/src/routes/**
  apps/server/src/ws/**

manager:
  apps/server/src/managers/**
  apps/server/src/domain/**
  apps/server/src/repositories/**
```

Exact paths make delegation safer and reduce accidental overlap.

## 12. Important operating rule

Do not keep five permanent child sessions alive merely because there are five roles.

Treat the `.md` files as durable **role definitions** and spawn a fresh role session for each bounded task.

The durable organization is the repository policy and agent definitions; the individual child session is replaceable.
