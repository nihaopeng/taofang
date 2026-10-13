/**
 * Unit tests for the placement-preview controller.
 *
 * These prove the two hard requirements of the in-world editor ghost with a
 * counting spy, without React or a DOM:
 *
 *  - `validate` is called ONLY when the candidate key (kind + yaw + snapped
 *    position) changes: moving the pointer within one snapped cell adds zero
 *    calls;
 *  - a response for a superseded candidate is discarded and can never paint the
 *    ghost.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PlacementValidationViewModel } from '../src/organizer/index.ts';
import {
  createPlacementPreview,
  placementCandidateKey,
} from '../src/ui/placement-preview.ts';
import type { PlacementCandidate } from '../src/ui/placement-preview.ts';

function verdict(
  valid: boolean,
  reason: string | null = valid ? null : 'blocked by the server',
): PlacementValidationViewModel {
  return {
    valid,
    reason,
    occupiedCells: [],
    resolvedTransform: valid
      ? { position: { x: 0.5, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
      : null,
  };
}

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    kind: 'tree',
    position: { x: 0.5, y: 0, z: 0.5 },
    yawDegrees: 0,
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue enough for a resolved `.then` chain to run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('placementCandidateKey', () => {
  it('is stable for the same kind/yaw/snapped position and distinct otherwise', () => {
    expect(placementCandidateKey(candidate())).toBe(placementCandidateKey(candidate()));
    expect(placementCandidateKey(candidate({ kind: 'rock' }))).not.toBe(
      placementCandidateKey(candidate()),
    );
    expect(placementCandidateKey(candidate({ yawDegrees: 90 }))).not.toBe(
      placementCandidateKey(candidate()),
    );
    expect(
      placementCandidateKey(candidate({ position: { x: 1.5, y: 0, z: 0.5 } })),
    ).not.toBe(placementCandidateKey(candidate()));
  });
});

describe('createPlacementPreview validate-on-change', () => {
  it('asks the server once and never again for an unchanged candidate', async () => {
    const validate = vi.fn(async () => verdict(true));
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    for (let i = 0; i < 50; i += 1) {
      // The pointer moved 50 times but stayed inside one snapped cell.
      preview.setCandidate(candidate());
    }
    await flush();

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith('tree', { x: 0.5, y: 0, z: 0.5 }, 0);
  });

  it('asks again only when the kind, the yaw, or the snapped position changes', async () => {
    const validate = vi.fn(async () => verdict(true));
    const preview = createPlacementPreview({ validate, onVerdict: vi.fn() });

    preview.setCandidate(candidate());
    await flush();
    expect(validate).toHaveBeenCalledTimes(1);

    // Kind change -> new request.
    preview.setCandidate(candidate({ kind: 'rock' }));
    await flush();
    expect(validate).toHaveBeenCalledTimes(2);

    // Yaw change -> new request.
    preview.setCandidate(candidate({ kind: 'rock', yawDegrees: 90 }));
    await flush();
    expect(validate).toHaveBeenCalledTimes(3);

    // Snapped-position change -> new request.
    preview.setCandidate(candidate({ kind: 'rock', yawDegrees: 90, position: { x: 1.5, y: 0, z: 0.5 } }));
    await flush();
    expect(validate).toHaveBeenCalledTimes(4);

    // Repeating the same candidate -> no request.
    preview.setCandidate(candidate({ kind: 'rock', yawDegrees: 90, position: { x: 1.5, y: 0, z: 0.5 } }));
    await flush();
    expect(validate).toHaveBeenCalledTimes(4);
  });

  it('neutralises the ghost while a request is pending and delivers the verdict', async () => {
    const pending = deferred<PlacementValidationViewModel | null>();
    const validate = vi.fn(() => pending.promise);
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    preview.setCandidate(candidate());
    // Pending: neutral, so a previous colour can never linger.
    expect(onVerdict).toHaveBeenLastCalledWith(null);

    pending.resolve(verdict(true));
    await flush();
    expect(onVerdict).toHaveBeenLastCalledWith(expect.objectContaining({ valid: true }));
  });

  it('delivers a neutral verdict when the query rejects', async () => {
    const pending = deferred<PlacementValidationViewModel | null>();
    const validate = vi.fn(() => pending.promise);
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    preview.setCandidate(candidate());
    pending.reject(new Error('network'));
    await flush();
    expect(onVerdict).toHaveBeenLastCalledWith(null);
  });

  it('clears to neutral without asking the server', () => {
    const validate = vi.fn(async () => verdict(true));
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    preview.setCandidate(candidate());
    expect(validate).toHaveBeenCalledTimes(1);

    preview.clear();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(onVerdict).toHaveBeenLastCalledWith(null);

    preview.setCandidate(null);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(onVerdict).toHaveBeenLastCalledWith(null);
  });
});

describe('createPlacementPreview stale-response discard', () => {
  it('never paints a verdict belonging to a superseded candidate', async () => {
    const firstRequest = deferred<PlacementValidationViewModel | null>();
    const secondRequest = deferred<PlacementValidationViewModel | null>();
    const validate = vi
      .fn<() => Promise<PlacementValidationViewModel | null>>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    preview.setCandidate(candidate({ kind: 'tree' }));
    preview.setCandidate(candidate({ kind: 'rock' }));
    expect(validate).toHaveBeenCalledTimes(2);

    // The FIRST (superseded) response arrives after the second was requested.
    firstRequest.resolve(verdict(false, 'stale verdict'));
    await flush();
    expect(onVerdict).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stale verdict' }),
    );
    // Still only the two pending neutralisations; the stale answer was discarded.
    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(onVerdict).toHaveBeenLastCalledWith(null);

    // The current candidate's answer IS delivered.
    secondRequest.resolve(verdict(true));
    await flush();
    expect(onVerdict).toHaveBeenLastCalledWith(expect.objectContaining({ valid: true }));
    expect(onVerdict).toHaveBeenCalledTimes(3);
  });

  it('discards a superseded rejection too', async () => {
    const firstRequest = deferred<PlacementValidationViewModel | null>();
    const secondRequest = deferred<PlacementValidationViewModel | null>();
    const validate = vi
      .fn<() => Promise<PlacementValidationViewModel | null>>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);
    const onVerdict = vi.fn();
    const preview = createPlacementPreview({ validate, onVerdict });

    preview.setCandidate(candidate({ kind: 'tree' }));
    // Supersede before the first settles, then reject it. The second request is
    // deliberately left pending so only the stale rejection is under test.
    preview.setCandidate(candidate({ kind: 'chest' }));
    firstRequest.reject(new Error('late failure'));
    await flush();

    // The rejection neutralised nothing extra: the last call is the pending
    // neutral from the second candidate.
    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(onVerdict).toHaveBeenLastCalledWith(null);
  });
});
