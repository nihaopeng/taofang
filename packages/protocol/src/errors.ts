/**
 * Shared error contract.
 *
 * `ProtocolErrorCode` is the machine-readable cross-boundary error vocabulary.
 * Mapping a code to an HTTP status (or any other transport signal) is Router's
 * job, not Protocol's.
 */

/** Machine-readable error codes carried in `ProtocolError`. */
export type ProtocolErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
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
