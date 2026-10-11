/**
 * The Render Bridge: Organizer world state -> Render ISA frames.
 *
 * This module is pure and framework-free. It maps *client application state*
 * (the Organizer's `WorldState`) into the in-process Render ISA, and it owns the
 * only piece of knowledge a stateless mapper cannot have: which render nodes
 * currently exist. That lets it emit a **diff** (create/update/destroy) instead
 * of replaying the whole scene on every state change.
 *
 * Boundaries (enforced by `eslint.config.js`):
 * - No `three`: the bridge decides *what* the scene should contain, never *how*
 *   a particular runtime draws it.
 * - No game protocol, no backend, no UI components: it consumes only the
 *   Organizer barrel and the render ISA types.
 * - No clock: `frameFor` is a pure function of `(state, previously-known nodes)`
 *   so it is deterministic and unit-testable without timers.
 *
 * Identity: a render `NodeId` is derived from the game `entityId`, but the two
 * are deliberately different types. The renderer must not be able to read game
 * identity (it receives only `NodeId`); game identity stops here.
 */

import type { AppearanceId, NodeId, RenderCommand, RenderFrame } from '@starvalley/render-protocol';

import type { WorldState } from '../organizer';

// Re-export the ISA surface the UI is allowed to see. UI components must not
// import `@starvalley/render-protocol` directly (lint enforces it), so the
// bridge is their single entry point to the render primitives.
export type { RenderCommand, RenderFrame } from '@starvalley/render-protocol';

/**
 * Default duration for interpolating an authoritative transform target. This is
 * presentation-only smoothing: the target already came from the server, so
 * easing toward it is not client prediction.
 */
const DEFAULT_STEP_DURATION_MS = 120;

/**
 * Appearance catalogue: game `kind` -> opaque render `AppearanceId`.
 *
 * The runtime owns what an appearance id *looks like*; the bridge only chooses
 * the id. Adding an entity kind is a game-protocol change; the bridge gains an
 * entry here independently.
 */
const APPEARANCE_BY_KIND: Readonly<Record<string, AppearanceId>> = {
  character: asAppearanceId('appearance.character'),
};

/**
 * Documented fallback for a `kind` the catalogue does not know.
 *
 * A new server-side kind must never crash the client: an unknown kind renders as
 * this appearance until a catalogue entry is added here. It is intentionally a
 * visible "unknown" look rather than a silent blank.
 */
export const FALLBACK_APPEARANCE: AppearanceId = asAppearanceId('appearance.fallback');

/**
 * Every appearance id the bridge can emit: one per known kind plus the fallback.
 *
 * Exported so the runtime can bind its own colour catalogue to it: a rename on
 * either side becomes a test failure instead of a silent fallback colour. A new
 * kind added to {@link APPEARANCE_BY_KIND} grows this list automatically.
 */
export const BRIDGE_APPEARANCES: readonly AppearanceId[] = [
  ...new Set([...Object.values(APPEARANCE_BY_KIND), FALLBACK_APPEARANCE]),
];

/**
 * The Render ISA ships branded id *types* only (no runtime constructors), so the
 * bridge performs the branding at the one point where it is legitimate: the
 * Organizer/ISA boundary. Downstream, a `NodeId` is opaque.
 */
function asNodeId(entityId: string): NodeId {
  return entityId as NodeId;
}

function asAppearanceId(value: string): AppearanceId {
  return value as AppearanceId;
}

/** Resolve the catalogue appearance for a kind, falling back for unknown kinds. */
function appearanceForKind(kind: string): AppearanceId {
  return APPEARANCE_BY_KIND[kind] ?? FALLBACK_APPEARANCE;
}

/** The render state the bridge believes exists for one node. */
interface KnownNode {
  appearance: AppearanceId;
  x: number;
  y: number;
  visible: boolean;
}

/**
 * Deterministic ascending order by `entityId`. The Organizer already normalises
 * entity order, but the bridge does not rely on it: the frame's command order is
 * part of its contract.
 */
function byEntityId(
  a: WorldState['entities'][number],
  b: WorldState['entities'][number],
): number {
  if (a.entityId < b.entityId) {
    return -1;
  }
  if (a.entityId > b.entityId) {
    return 1;
  }
  return 0;
}

/** Stateful mapper from `WorldState` to ordered render frames. */
export interface RenderBridge {
  /** Produce the diff needed to move the runtime from its previous frame to this state. */
  frameFor(state: WorldState): RenderFrame;
  /** Forget every known node, so the next call re-emits `node.create` for all entities. */
  reset(): void;
}

/**
 * Create a fresh bridge. `stepDurationMs` is the interpolation duration attached
 * to `transform.setTarget` (defaults to {@link DEFAULT_STEP_DURATION_MS}).
 */
export function createRenderBridge(options?: { stepDurationMs?: number }): RenderBridge {
  const stepDurationMs = options?.stepDurationMs ?? DEFAULT_STEP_DURATION_MS;
  const known = new Map<string, KnownNode>();

  return {
    frameFor(state: WorldState): RenderFrame {
      const commands: RenderCommand[] = [];
      const seen = new Set<string>();

      for (const entity of [...state.entities].sort(byEntityId)) {
        const nodeId = asNodeId(entity.entityId);
        const appearance = appearanceForKind(entity.kind);
        seen.add(entity.entityId);

        const previous = known.get(entity.entityId);

        if (previous === undefined) {
          // First sight: materialise the node with its authoritative transform.
          commands.push({
            type: 'node.create',
            nodeId,
            appearance,
            transform: { x: entity.x, y: entity.y },
            visible: entity.visible,
          });
          known.set(entity.entityId, {
            appearance,
            x: entity.x,
            y: entity.y,
            visible: entity.visible,
          });
          continue;
        }

        if (previous.x !== entity.x || previous.y !== entity.y) {
          // The new position is authoritative; the runtime may interpolate to it.
          commands.push({
            type: 'transform.setTarget',
            nodeId,
            transform: { x: entity.x, y: entity.y },
            durationMs: stepDurationMs,
          });
          previous.x = entity.x;
          previous.y = entity.y;
        }

        if (previous.visible !== entity.visible) {
          commands.push({ type: 'visibility.set', nodeId, visible: entity.visible });
          previous.visible = entity.visible;
        }

        if (previous.appearance !== appearance) {
          commands.push({ type: 'appearance.set', nodeId, appearance });
          previous.appearance = appearance;
        }
      }

      // Any known node with no matching entity left the world. Destroy it in a
      // deterministic id order so the frame is stable across runs.
      const removed = [...known.keys()].filter((entityId) => !seen.has(entityId)).sort();
      for (const entityId of removed) {
        commands.push({ type: 'node.destroy', nodeId: asNodeId(entityId) });
        known.delete(entityId);
      }

      return commands;
    },

    reset(): void {
      known.clear();
    },
  };
}
