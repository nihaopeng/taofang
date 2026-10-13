import { ProtocolParseError } from './errors.ts';
import { isCellCoord } from './grid.ts';
import type { CellCoord } from './grid.ts';
import { hasExactKeys, isRecord } from './internal.ts';

/**
 * Closed union of block kinds: the vocabulary of the discrete Block World.
 *
 * `air` is the ABSENCE of a block, not a renderable kind: a `WorldSnapshot`
 * never carries an `air` entry (absent means air), while a mutating command may
 * name `air` to mean "remove the block here". That asymmetry is enforced by the
 * snapshot guard, not by this union.
 *
 * These are spatial/topology labels only. This contract deliberately borrows
 * the *idea* of a discrete block world, never Minecraft content, code or art:
 * no collision shape, no support/occupancy/permission rule, and no
 * appearance/material/asset information is attached to a kind here.
 */
export type BlockKind =
  | 'air'
  | 'grass'
  | 'soil'
  | 'stone'
  | 'path'
  | 'water'
  | 'slab'
  | 'stairs'
  | 'ramp';

/**
 * A yaw step in degrees: exactly `0 | 90 | 180 | 270`.
 *
 * Block orientation is a yaw step ({@link BlockOrientation} aliases this type).
 * The set is closed so an orientation is always one of the four quarter turns.
 */
export type YawStep = 0 | 90 | 180 | 270;

/** A block's orientation is a yaw step. Required (default `0`) for every block. */
export type BlockOrientation = YawStep;

/**
 * One discrete block in the world topology: an absolute integer {@link
 * CellCoord}, a {@link BlockKind}, and a required {@link BlockOrientation}.
 *
 * `orientation` is **required, not optional**: the default for a
 * non-directional block is yaw `0`. Making it explicit keeps the guard
 * exact-key with no optional-key special case, and it means a directional block
 * (`stairs`, `ramp`, `slab`) never silently loses its facing.
 */
export interface BlockState {
  /** Absolute integer cell, not chunk-local. */
  coord: CellCoord;
  kind: BlockKind;
  orientation: BlockOrientation;
}

const BLOCK_STATE_KEYS = ['coord', 'kind', 'orientation'] as const;

/** Structural guard for `BlockKind` (exactly the closed union above). */
export function isBlockKind(value: unknown): value is BlockKind {
  return (
    value === 'air' ||
    value === 'grass' ||
    value === 'soil' ||
    value === 'stone' ||
    value === 'path' ||
    value === 'water' ||
    value === 'slab' ||
    value === 'stairs' ||
    value === 'ramp'
  );
}

/** Parse and validate `BlockKind`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockKind(value: unknown): BlockKind {
  if (!isBlockKind(value)) {
    throw new ProtocolParseError('Invalid BlockKind payload');
  }
  return value;
}

/** Structural guard for `YawStep` (exactly one of `0 | 90 | 180 | 270`). */
export function isYawStep(value: unknown): value is YawStep {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

/** Parse and validate `YawStep`, throwing `ProtocolParseError` on mismatch. */
export function parseYawStep(value: unknown): YawStep {
  if (!isYawStep(value)) {
    throw new ProtocolParseError('Invalid YawStep payload');
  }
  return value;
}

/** Structural guard for `BlockOrientation` (a `YawStep`). */
export function isBlockOrientation(value: unknown): value is BlockOrientation {
  return isYawStep(value);
}

/** Parse and validate `BlockOrientation`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockOrientation(value: unknown): BlockOrientation {
  if (!isBlockOrientation(value)) {
    throw new ProtocolParseError('Invalid BlockOrientation payload');
  }
  return value;
}

/**
 * Structural guard for `BlockState` (exactly `{ coord, kind, orientation }`).
 *
 * `kind` may be `air` here: a block-change event uses `air` to mean removed. The
 * snapshot's sparse `blocks` list rejects `air` separately.
 */
export function isBlockState(value: unknown): value is BlockState {
  if (!isRecord(value) || !hasExactKeys(value, BLOCK_STATE_KEYS)) {
    return false;
  }
  return (
    isCellCoord(value.coord) && isBlockKind(value.kind) && isBlockOrientation(value.orientation)
  );
}

/** Parse and validate `BlockState`, throwing `ProtocolParseError` on mismatch. */
export function parseBlockState(value: unknown): BlockState {
  if (!isBlockState(value)) {
    throw new ProtocolParseError('Invalid BlockState payload');
  }
  return value;
}
