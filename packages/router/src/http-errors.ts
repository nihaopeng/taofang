import { toProtocolError } from '@starvalley/protocol';
import type { ProtocolError, ProtocolErrorCode } from '@starvalley/protocol';

/**
 * Transport-level mapping from Protocol error codes to HTTP status codes.
 *
 * Protocol owns the machine-readable error vocabulary; Router owns how that
 * vocabulary is expressed over HTTP (see AGENTS.md: Router).
 */
const HTTP_STATUS_BY_ERROR_CODE: Record<ProtocolErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

export function mapErrorCodeToStatus(code: ProtocolErrorCode): number {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

/** Build a serialized `ProtocolError` body for the given code/message. */
export function protocolErrorBody(code: ProtocolErrorCode, message: string): ProtocolError {
  return toProtocolError(code, message);
}
