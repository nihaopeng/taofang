/**
 * `@starvalley/render-protocol` — the Render ISA.
 *
 * Types only, framework-free and dependency-free: no Three.js, no React, no
 * Node, no game protocol. A render runtime (for example the Three.js executor)
 * consumes `RenderFrame`s produced by the bridge. The ISA is in-process and
 * typed, so it intentionally ships no runtime guards.
 *
 * The only external dependency is the neutral `@starvalley/math` package, whose
 * `Vec3`/`Quat` types make the render transform real 3D. `Vec3`/`Quat` are
 * re-exported here so render consumers keep a single import site.
 */

export type { Quat, Vec3 } from '@starvalley/math';

export type { AnimationId, AppearanceId, NodeId } from './ids.ts';

export type {
  AnimationPlayCommand,
  AppearanceSetCommand,
  NodeCreateCommand,
  NodeDestroyCommand,
  RenderCommand,
  RenderCommandType,
  RenderFrame,
  RenderLayer,
  RenderTransform,
  TransformSetCommand,
  TransformSetTargetCommand,
  VisibilitySetCommand,
} from './commands.ts';
