/**
 * Unit tests for the Render Bridge (node environment: no DOM, no Three.js).
 *
 * The bridge is a pure stateful mapper from Organizer `WorldState` to Render ISA
 * frames. These tests pin the diff rules, the appearance fallback, and the
 * determinism of command order. They import the bridge directly and the ISA only
 * for its types, so no runtime dependency on the Organizer or Three.js is loaded.
 */

import { describe, expect, it } from 'vitest';

import type { RenderCommand, RenderFrame } from '@starvalley/render-protocol';

import type { WorldState } from '../src/organizer/index.ts';
import { FALLBACK_APPEARANCE, createRenderBridge } from '../src/render/bridge.ts';

type Entity = WorldState['entities'][number];

function makeEntity(overrides: Partial<Entity> & { entityId: string }): Entity {
  return {
    actorId: null,
    kind: 'character',
    x: 0,
    y: 0,
    visible: true,
    ...overrides,
  };
}

function makeState(entities: readonly Entity[], overrides: Partial<WorldState> = {}): WorldState {
  return {
    status: 'ready',
    world: { width: 10, height: 8 },
    entities,
    controlledActorId: null,
    error: null,
    ...overrides,
  };
}

/** Narrow the frame to one command type, failing loudly when it is absent. */
function commandOfType<T extends RenderCommand['type']>(
  frame: RenderFrame,
  type: T,
): Extract<RenderCommand, { type: T }> {
  const found = frame.find((command) => command.type === type);
  if (found === undefined) {
    throw new Error(`a ${type} command in the frame`);
  }
  return found as Extract<RenderCommand, { type: T }>;
}

describe('render bridge diff rules', () => {
  it('emits node.create the first time an entity is seen', () => {
    const bridge = createRenderBridge();

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    expect(frame).toHaveLength(1);
    const create = commandOfType(frame, 'node.create');
    expect(create.nodeId).toBe('entity-a');
    expect(create.appearance).toBe('appearance.character');
    expect(create.transform).toEqual({ x: 3, y: 4 });
    expect(create.visible).toBe(true);
  });

  it('emits transform.setTarget with a positive duration when x/y change', () => {
    const bridge = createRenderBridge({ stepDurationMs: 120 });
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 4, y: 4 })]));

    const target = commandOfType(frame, 'transform.setTarget');
    expect(target.nodeId).toBe('entity-a');
    expect(target.transform).toEqual({ x: 4, y: 4 });
    expect(target.durationMs).toBeGreaterThan(0);
  });

  it('emits visibility.set when visible changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', visible: true })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', visible: false })]));

    const visibility = commandOfType(frame, 'visibility.set');
    expect(visibility.nodeId).toBe('entity-a');
    expect(visibility.visible).toBe(false);
  });

  it('emits appearance.set when kind changes', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'character' })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'tree' })]));

    const appearance = commandOfType(frame, 'appearance.set');
    expect(appearance.nodeId).toBe('entity-a');
    expect(appearance.appearance).toBe(FALLBACK_APPEARANCE);
  });

  it('emits node.destroy when an entity disappears', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-a' }),
        makeEntity({ entityId: 'entity-b' }),
      ]),
    );

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a' })]));

    expect(frame).toHaveLength(1);
    const destroy = commandOfType(frame, 'node.destroy');
    expect(destroy.nodeId).toBe('entity-b');
  });

  it('emits an empty frame when nothing changed', () => {
    const bridge = createRenderBridge();
    const state = makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]);
    bridge.frameFor(state);

    // A fresh state object with equal values is still "unchanged".
    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', x: 3, y: 4 })]));

    expect(frame).toEqual([]);
  });
});

describe('render bridge fallback appearance', () => {
  it('does not throw for an unknown kind and uses the documented fallback', () => {
    const bridge = createRenderBridge();

    let frame: RenderFrame = [];
    expect(() => {
      frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));
    }).not.toThrow();

    const create = commandOfType(frame, 'node.create');
    expect(create.appearance).toBe(FALLBACK_APPEARANCE);
  });

  it('keeps the node alive (no destroy) when only the kind is unknown', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));

    const frame = bridge.frameFor(makeState([makeEntity({ entityId: 'entity-a', kind: 'crop' })]));

    expect(frame).toEqual([]);
  });
});

describe('render bridge reset and determinism', () => {
  it('re-emits node.create after reset', () => {
    const bridge = createRenderBridge();
    const state = makeState([makeEntity({ entityId: 'entity-a' })]);
    bridge.frameFor(state);

    bridge.reset();
    const frame = bridge.frameFor(state);

    const create = commandOfType(frame, 'node.create');
    expect(create.nodeId).toBe('entity-a');
  });

  it('orders create commands deterministically by entityId regardless of input order', () => {
    const first = createRenderBridge();
    const second = createRenderBridge();

    const forward = first.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-a' }),
        makeEntity({ entityId: 'entity-b' }),
        makeEntity({ entityId: 'entity-c' }),
      ]),
    );
    const reversed = second.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-c' }),
        makeEntity({ entityId: 'entity-b' }),
        makeEntity({ entityId: 'entity-a' }),
      ]),
    );

    expect(forward).toEqual(reversed);
    expect(forward.map((command) => command.nodeId)).toEqual([
      'entity-a',
      'entity-b',
      'entity-c',
    ]);
  });

  it('orders mixed updates and destroys deterministically', () => {
    const bridge = createRenderBridge();
    bridge.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-a', x: 0, y: 0 }),
        makeEntity({ entityId: 'entity-b', x: 0, y: 0 }),
        makeEntity({ entityId: 'entity-c', x: 0, y: 0 }),
      ]),
    );

    const frame = bridge.frameFor(
      makeState([
        makeEntity({ entityId: 'entity-c', x: 1, y: 0 }),
        makeEntity({ entityId: 'entity-a', x: 1, y: 0 }),
      ]),
    );

    expect(frame.map((command) => `${command.type}:${command.nodeId}`)).toEqual([
      'transform.setTarget:entity-a',
      'transform.setTarget:entity-c',
      'node.destroy:entity-b',
    ]);
  });
});
