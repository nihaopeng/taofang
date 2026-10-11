import { ProtocolParseError } from './errors.ts';

/**
 * Cardinal movement direction.
 *
 * Semantics: `north` = y-1, `south` = y+1, `east` = x+1, `west` = x-1.
 *
 * This is a *game* semantic consumed by the `actor.move` command; it is not a
 * render concept, so it lives in the game protocol rather than the render ISA.
 */
export type MoveDirection = 'north' | 'south' | 'east' | 'west';

/** Structural guard for `MoveDirection`. */
export function isMoveDirection(value: unknown): value is MoveDirection {
  return value === 'north' || value === 'south' || value === 'east' || value === 'west';
}

/** Parse and validate `MoveDirection`, throwing `ProtocolParseError` on mismatch. */
export function parseMoveDirection(value: unknown): MoveDirection {
  if (!isMoveDirection(value)) {
    throw new ProtocolParseError('Invalid MoveDirection payload');
  }
  return value;
}
