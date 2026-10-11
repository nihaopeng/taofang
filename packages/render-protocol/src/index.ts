/**
 * `@starvalley/render-protocol` — the Render ISA.
 *
 * Types only, framework-free and dependency-free: no Three.js, no React, no
 * Node, no game protocol. A render runtime (for example the Three.js executor)
 * consumes `RenderFrame`s produced by the bridge. The ISA is in-process and
 * typed, so it intentionally ships no runtime guards.
 */

export type { AppearanceId, NodeId } from './ids.ts';

export type {
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
