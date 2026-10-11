import type { AppearanceId, NodeId } from './ids.ts';

/**
 * Render-space layer bucket. It names no game object: it exists because
 * terrain and actors would otherwise be created at the same depth, leaving draw
 * order undefined (the actor can be drawn under the tiles). A layer is also the
 * natural key for later batching/instancing.
 */
export type RenderLayer = 'base' | 'object';

/**
 * Integer coordinates for the render scene. This is a render-space value, not a
 * game tile coordinate; the bridge chooses the mapping.
 */
export interface RenderTransform {
  x: number;
  y: number;
}

/** Create a node with an initial transform and visibility. */
export interface NodeCreateCommand {
  type: 'node.create';
  layer: RenderLayer;
  nodeId: NodeId;
  appearance: AppearanceId;
  transform: RenderTransform;
  visible: boolean;
}

/** Remove a node; all render state associated with it is discarded. */
export interface NodeDestroyCommand {
  type: 'node.destroy';
  nodeId: NodeId;
}

/**
 * Snap a node's transform instantly (spawn, teleport, authoritative correction).
 *
 * Instant by definition: the runtime applies it in the same frame.
 */
export interface TransformSetCommand {
  type: 'transform.set';
  nodeId: NodeId;
  transform: RenderTransform;
}

/**
 * Ask the runtime to interpolate the node toward an authoritative target over
 * `durationMs`.
 *
 * The target is authoritative (it came from the server); interpolating toward it
 * on the render side is not client prediction.
 */
export interface TransformSetTargetCommand {
  type: 'transform.setTarget';
  nodeId: NodeId;
  transform: RenderTransform;
  durationMs: number;
}

/** Swap a node's appearance to another catalogue entry. */
export interface AppearanceSetCommand {
  type: 'appearance.set';
  nodeId: NodeId;
  appearance: AppearanceId;
}

/** Show or hide a node. */
export interface VisibilitySetCommand {
  type: 'visibility.set';
  nodeId: NodeId;
  visible: boolean;
}

/**
 * The Render ISA: a discriminated union of render primitives.
 *
 * It says *what the scene should contain*, never *how* a particular runtime does
 * it. No `Object3D`, `Vector3`, matrix, or material type appears here. A runtime
 * must switch exhaustively over `type` (with a `never` check), so adding a
 * primitive is a compile error in every runtime until it is implemented.
 */
export type RenderCommand =
  | NodeCreateCommand
  | NodeDestroyCommand
  | TransformSetCommand
  | TransformSetTargetCommand
  | AppearanceSetCommand
  | VisibilitySetCommand;

/** The `type` discriminant of every render primitive. */
export type RenderCommandType = RenderCommand['type'];

/**
 * An ordered diff: render commands are applied in order, so a frame can create,
 * position, and then re-appear a node.
 */
export type RenderFrame = readonly RenderCommand[];
