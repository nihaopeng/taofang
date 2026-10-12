/**
 * Shared error contract.
 *
 * `ProtocolErrorCode` is the machine-readable cross-boundary error vocabulary.
 * Mapping a code to an HTTP status (or any other transport signal) is Router's
 * job, not Protocol's.
 */

/**
 * Machine-readable error codes carried in `ProtocolError`.
 *
 * `CONFLICT` means the request itself was well-formed and valid, but it is
 * **illegal against the CURRENT world state** — e.g. an interaction target that
 * is out of range or not interactable. It must be distinguishable from a
 * malformed payload (`BAD_REQUEST`) and, crucially, from "accepted but nothing
 * happened": a refused-but-valid request currently yields an empty `events`
 * delta in `GameEventBatch`, which cannot express the difference. No event is
 * introduced for this; it stays on the existing error path. Mapping a code to a
 * transport status (409 for `CONFLICT`) is Router's job, not Protocol's.
 */
export type ProtocolErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

/** Serialized error payload for any failed request. */
export interface ProtocolError {
  error: {
    code: ProtocolErrorCode;
    message: string;
  };
}

/**
 * Thrown by `parse*` helpers when a value does not match its contract.
 *
 * `code` defaults to `'BAD_REQUEST'`; callers may override it when the parse
 * failure maps to a more specific transport-visible error.
 */
export class ProtocolParseError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(message: string, code: ProtocolErrorCode = 'BAD_REQUEST') {
    super(message);
    this.name = 'ProtocolParseError';
    this.code = code;
  }
}

/** Build a serializable `ProtocolError` payload. */
export function toProtocolError(code: ProtocolErrorCode, message: string): ProtocolError {
  return { error: { code, message } };
}
