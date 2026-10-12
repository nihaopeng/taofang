import { isGameEventBatch } from './command.ts';
import type { GameEventBatch } from './command.ts';
import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isRecord } from './internal.ts';
import { isWorldSnapshot } from './world.ts';
import type { WorldSnapshot } from './world.ts';

/**
 * One frame of the world state stream (`STREAM_PATH`).
 *
 * The stream sends a full `snapshot` **first on every connection** to close the
 * connect race, then `events` batches as the authoritative world changes. The
 * envelope is a discriminated union on `type`; there is no catch-all.
 */
export type WorldStreamMessage =
  | { type: 'snapshot'; snapshot: WorldSnapshot }
  | { type: 'events'; batch: GameEventBatch };

const SNAPSHOT_MESSAGE_KEYS = ['type', 'snapshot'] as const;
const EVENTS_MESSAGE_KEYS = ['type', 'batch'] as const;

/** Structural guard for the `snapshot` stream message (internal; answer via the union guard). */
function isSnapshotStreamMessage(
  value: unknown,
): value is Extract<WorldStreamMessage, { type: 'snapshot' }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, SNAPSHOT_MESSAGE_KEYS) &&
    value.type === 'snapshot' &&
    isWorldSnapshot(value.snapshot)
  );
}

/** Structural guard for the `events` stream message (internal; answer via the union guard). */
function isEventsStreamMessage(
  value: unknown,
): value is Extract<WorldStreamMessage, { type: 'events' }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, EVENTS_MESSAGE_KEYS) &&
    value.type === 'events' &&
    isGameEventBatch(value.batch)
  );
}

/** Parse the `snapshot` stream message (internal; throw via the union parser). */
function parseSnapshotStreamMessage(
  value: unknown,
): Extract<WorldStreamMessage, { type: 'snapshot' }> {
  if (!isSnapshotStreamMessage(value)) {
    throw new ProtocolParseError('Invalid snapshot WorldStreamMessage payload');
  }
  return value;
}

/** Parse the `events` stream message (internal; throw via the union parser). */
function parseEventsStreamMessage(
  value: unknown,
): Extract<WorldStreamMessage, { type: 'events' }> {
  if (!isEventsStreamMessage(value)) {
    throw new ProtocolParseError('Invalid events WorldStreamMessage payload');
  }
  return value;
}

/**
 * Structural guard for `WorldStreamMessage`.
 *
 * Dispatches on the `type` discriminant. An unknown `type` (or any malformed
 * payload) is rejected; there is no catch-all message shape.
 */
export function isWorldStreamMessage(value: unknown): value is WorldStreamMessage {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'snapshot':
      return isSnapshotStreamMessage(value);
    case 'events':
      return isEventsStreamMessage(value);
    default:
      return false;
  }
}

/**
 * Parse and validate `WorldStreamMessage`, throwing `ProtocolParseError` on
 * mismatch. Dispatches on `type` so callers receive the narrowed union member.
 */
export function parseWorldStreamMessage(value: unknown): WorldStreamMessage {
  if (isRecord(value)) {
    switch (value.type) {
      case 'snapshot':
        return parseSnapshotStreamMessage(value);
      case 'events':
        return parseEventsStreamMessage(value);
      default:
        break;
    }
  }
  throw new ProtocolParseError('Invalid WorldStreamMessage payload');
}
