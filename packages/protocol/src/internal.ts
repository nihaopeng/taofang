/**
 * Internal, dependency-free validation primitives shared by the public guards.
 * Not part of the public API.
 */

/** Narrow `unknown` to a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate that `value` has exactly the given own enumerable keys: no missing
 * required fields and no unknown extra fields.
 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Strict ISO-8601 UTC timestamp check: `YYYY-MM-DDThh:mm:ss[.sss]Z`.
 * Rejects non-UTC offsets, date-only strings, and calendar overflow
 * (e.g. `2025-02-30T00:00:00Z`).
 */
export function isIsoUtcString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const match = ISO_UTC_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const [, year, month, day, hour, minute, second, fraction] = match;
  const milliseconds = Number((fraction ?? '').padEnd(3, '0'));

  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), milliseconds);

  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second) &&
    date.getUTCMilliseconds() === milliseconds
  );
}

/** Validate a finite integer (any sign; callers add sign constraints if needed). */
export function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/** Validate a finite, non-negative number. */
export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
