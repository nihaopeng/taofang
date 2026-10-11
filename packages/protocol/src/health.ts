import { ProtocolParseError } from './errors.ts';
import { hasExactKeys, isIsoUtcString, isNonNegativeFiniteNumber, isRecord } from './internal.ts';

/** Server liveness payload. */
export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
  /** ISO-8601 UTC timestamp. */
  serverTime: string;
}

const HEALTH_STATUS_KEYS = ['status', 'uptimeSeconds', 'serverTime'] as const;

/**
 * Structural guard for `HealthStatus`.
 *
 * `uptimeSeconds` must be a finite, non-negative number. `serverTime` must be a
 * strict ISO-8601 UTC timestamp.
 */
export function isHealthStatus(value: unknown): value is HealthStatus {
  if (!isRecord(value) || !hasExactKeys(value, HEALTH_STATUS_KEYS)) {
    return false;
  }
  return (
    value.status === 'ok' &&
    isNonNegativeFiniteNumber(value.uptimeSeconds) &&
    isIsoUtcString(value.serverTime)
  );
}

/** Parse and validate `HealthStatus`, throwing `ProtocolParseError` on mismatch. */
export function parseHealthStatus(value: unknown): HealthStatus {
  if (!isHealthStatus(value)) {
    throw new ProtocolParseError('Invalid HealthStatus payload');
  }
  return value;
}
