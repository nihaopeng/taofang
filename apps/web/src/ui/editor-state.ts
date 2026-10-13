/**
 * Presentational state and pure helpers for the in-world editor.
 *
 * This module owns NO gameplay rule and NO transport. It describes what the
 * editor currently has selected, how a candidate placement is turned into a
 * ghost spec, and the pure yaw helpers the palettes and the `R` shortcut use.
 * Placement legality (support, occupancy, terrain permission, permissions) is
 * never computed here: the ghost's `valid` field is copied verbatim from the
 * server's verdict.
 *
 * `PlacementGhost` is imported as a TYPE only, so this module stays runtime-free
 * (no Three.js) and is trivially unit-testable.
 */

import type { PlacementValidationViewModel, Vec3ViewModel } from '../organizer';
import type { PlacementGhost } from '../render/three/runtime';

/** What the editor currently has armed. Purely presentational. */
export type EditorSelection =
  | { readonly mode: 'none' }
  | { readonly mode: 'block'; readonly kind: string; readonly orientation: number }
  | { readonly mode: 'entity'; readonly kind: string; readonly yawDegrees: number };

/** The closed set of block yaw steps, matching the frozen contract. */
export const BLOCK_YAW_STEPS: readonly number[] = [0, 90, 180, 270];

/** Yaw about `+Y` as a quaternion (degrees), the same convention the bridge uses. */
export function yawQuat(degrees: number): { x: number; y: number; z: number; w: number } {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Advance yaw to the next allowed step, cycling. When `current` is not in
 * `allowed` (or the list is empty) the first step (or `current`) is returned.
 * Pure; the `R` shortcut only calls it when the kind actually has a choice.
 */
export function nextYawStep(current: number, allowed: readonly number[]): number {
  if (allowed.length === 0) {
    return current;
  }
  const index = allowed.indexOf(current);
  return allowed[(index + 1) % allowed.length] ?? current;
}

/**
 * The geometry of a pending placement, independent of the server verdict. The
 * position/rotation are the client's snapped candidate; `buildGhostSpec` swaps in
 * the server's `resolvedTransform` once it arrives.
 */
export interface GhostCandidate {
  readonly position: Vec3ViewModel;
  readonly rotation: { x: number; y: number; z: number; w: number };
  readonly footprintX: number;
  readonly footprintZ: number;
  readonly height: number;
  /**
   * Whether `position` anchors the ghost box at its base (default) or its
   * centre. A block node root is the cell centre, so a block candidate uses
   * `'center'`; an entity's transform is its base.
   */
  readonly pivot: 'base' | 'center';
}

/**
 * Build the runtime ghost spec from the candidate and the (possibly pending)
 * server verdict.
 *
 * The ONLY thing the verdict contributes to the ghost is `valid` and, when the
 * placement is valid, the server's `resolvedTransform` and `occupiedCells`. There
 * is deliberately no client-side fallback rule: with no verdict the ghost is
 * neutral, and an invalid verdict is red even when the client might see the cell
 * as free.
 */
export function buildGhostSpec(
  candidate: GhostCandidate,
  verdict: PlacementValidationViewModel | null,
): PlacementGhost {
  const resolved = verdict !== null && verdict.valid ? verdict.resolvedTransform : null;
  return {
    position: { ...(resolved?.position ?? candidate.position) },
    rotation: { ...(resolved?.rotation ?? candidate.rotation) },
    footprintX: candidate.footprintX,
    footprintZ: candidate.footprintZ,
    height: candidate.height,
    pivot: candidate.pivot,
    valid: verdict === null ? null : verdict.valid,
    occupiedCells: verdict?.occupiedCells.map((cell) => ({ ...cell })) ?? [],
  };
}
