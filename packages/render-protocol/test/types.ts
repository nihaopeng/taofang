/**
 * Type-level tests for the Render ISA.
 *
 * This file is deliberately NOT named `*.test.ts`, so Vitest ignores it while
 * `tsc -p packages/render-protocol/tsconfig.json` checks it (the tsconfig
 * includes the whole test directory). There are no runtime assertions here: the
 * compiler is the test.
 * It does two things:
 *  1. builds one literal of every `RenderCommand` member and narrows the union
 *     in an exhaustive `switch` with a `never` check, so adding a primitive
 *     breaks compilation until it is implemented;
 *  2. proves the negative space with `@ts-expect-error` cases.
 */

import type {
  AnimationId,
  AppearanceId,
  NodeId,
  Quat,
  RenderCommand,
  RenderCommandType,
  RenderFrame,
  RenderLayer,
  RenderTransform,
  Vec3,
} from '../src/index.ts';

const nodeA = 'node-a' as NodeId;
const nodeB = 'node-b' as NodeId;
const appearanceFarmer = 'appearance.farmer' as AppearanceId;
const appearanceTree = 'appearance.tree' as AppearanceId;
const animationWalk = 'animation.walk' as AnimationId;
const identityRotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
const unitScale: Vec3 = { x: 1, y: 1, z: 1 };
const transformOrigin: RenderTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: identityRotation,
  scale: unitScale,
};
const transformTarget: RenderTransform = {
  position: { x: 4, y: 0, z: 7 },
  rotation: { x: 0, y: 0.7071067811865476, z: 0, w: 0.7071067811865476 },
  scale: unitScale,
};
const baseLayer: RenderLayer = 'base';

/** One literal for every `RenderCommand` member (adding a member breaks this). */
export const nodeCreate: RenderCommand = {
  type: 'node.create',
  layer: baseLayer,
  nodeId: nodeA,
  appearance: appearanceFarmer,
  transform: transformOrigin,
  visible: true,
};
export const nodeDestroy: RenderCommand = { type: 'node.destroy', nodeId: nodeA };
export const transformSet: RenderCommand = {
  type: 'transform.set',
  nodeId: nodeA,
  transform: transformOrigin,
};
export const transformSetTarget: RenderCommand = {
  type: 'transform.setTarget',
  nodeId: nodeA,
  transform: transformTarget,
  durationMs: 150,
};
export const appearanceSet: RenderCommand = {
  type: 'appearance.set',
  nodeId: nodeA,
  appearance: appearanceTree,
};
export const visibilitySet: RenderCommand = { type: 'visibility.set', nodeId: nodeB, visible: false };
export const animationPlay: RenderCommand = {
  type: 'animation.play',
  nodeId: nodeA,
  animation: animationWalk,
  loop: true,
};

/** The ordered diff: every member is a `RenderCommand`. */
export const frame: RenderFrame = [
  nodeCreate,
  nodeDestroy,
  transformSet,
  transformSetTarget,
  appearanceSet,
  visibilitySet,
  animationPlay,
];

/**
 * Exactly the seven primitives. The list is a literal tuple and its element
 * union is compared against `RenderCommandType` below, so a future accidental
 * re-addition or removal is a compile error rather than a silently stale list.
 */
export const commandTypes = [
  'node.create',
  'node.destroy',
  'transform.set',
  'transform.setTarget',
  'appearance.set',
  'visibility.set',
  'animation.play',
] as const satisfies readonly RenderCommandType[];

type ListedCommandType = (typeof commandTypes)[number];

/** `true` only when the two unions are exactly equal. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Exported so it is not a swallowed `noUnusedLocals` case: the ISA must declare
 * exactly the seven primitives listed in `commandTypes`, no more and no fewer.
 */
export const commandTypesAreExact: Exact<RenderCommandType, ListedCommandType> = true;

/**
 * Exhaustive narrowing: the `default` branch assigns the residual union to
 * `never`, so a new primitive is a compile error here until handled.
 */
export function label(command: RenderCommand): string {
  switch (command.type) {
    case 'node.create':
      return `create:${command.nodeId}:${command.appearance}:${command.visible}`;
    case 'node.destroy':
      return `destroy:${command.nodeId}`;
    case 'transform.set':
      return `set:${command.nodeId}`;
    case 'transform.setTarget':
      return `target:${command.nodeId}:${command.durationMs}`;
    case 'appearance.set':
      return `appearance:${command.nodeId}:${command.appearance}`;
    case 'visibility.set':
      return `visible:${command.nodeId}:${command.visible}`;
    case 'animation.play':
      return `animation:${command.nodeId}:${command.animation}:${command.loop}`;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export const labels: readonly string[] = frame.map((command) => label(command));

// --- Negative cases: each line must be a compile error. ---------------------

// @ts-expect-error a 2D `{ x, y }` transform is no longer a RenderTransform (the ISA is real 3D)
export const legacy2dTransform: RenderTransform = { x: 0, y: 0 };

// @ts-expect-error a plain string is not a NodeId
export const plainAsNode: NodeId = 'node-a';

// @ts-expect-error a plain string is not an AnimationId
export const plainAsAnimation: AnimationId = 'animation.walk';

// @ts-expect-error a NodeId is not an AppearanceId
export const nodeAsAppearance: AppearanceId = nodeA;

export const misspelledType: RenderCommand = {
  // @ts-expect-error a misspelled `type` is not a RenderCommand
  type: 'node.creat',
  layer: baseLayer,
  nodeId: nodeA,
  appearance: appearanceFarmer,
  transform: transformOrigin,
  visible: true,
};

// @ts-expect-error node.create without `appearance` is not a RenderCommand
export const missingAppearance: RenderCommand = {
  type: 'node.create',
  layer: baseLayer,
  nodeId: nodeA,
  transform: transformOrigin,
  visible: true,
};

// @ts-expect-error node.create without `layer` is not a RenderCommand
// (layer is required: terrain and actors must not share an undefined depth)
export const missingLayer: RenderCommand = {
  type: 'node.create',
  nodeId: nodeA,
  appearance: appearanceFarmer,
  transform: transformOrigin,
  visible: true,
};

// @ts-expect-error an invalid layer string is not a RenderLayer
export const invalidLayer: RenderLayer = 'foreground';

// @ts-expect-error animation.play without `loop` is not a RenderCommand
export const missingLoop: RenderCommand = {
  type: 'animation.play',
  nodeId: nodeA,
  animation: animationWalk,
};
