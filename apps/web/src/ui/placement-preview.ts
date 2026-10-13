/**
 * The placement-preview controller: the "validate only on change" + stale-answer
 * gate for the in-world editor.
 *
 * It is deliberately React-free and timer-free so its behaviour is exactly
 * testable with a counting spy:
 *
 * - `setCandidate(candidate)` calls `validate` ONLY when the candidate key
 *   (kind + yaw + snapped position) actually changes. Moving the pointer within
 *   one snapped cell therefore adds zero requests.
 * - A changed candidate immediately resets the preview to neutral (`onVerdict(null)`)
 *   so a previous green/red ghost can never linger over a new candidate.
 * - Every request carries a generation number. A response whose generation is no
 *   longer current is DISCARDED and never delivered: a superseded candidate's
 *   verdict cannot paint the ghost.
 *
 * It makes no placement decision itself; `validate` is the Organizer's
 * `entity.validatePlacement` query and the verdict it resolves with is the
 * server's.
 */

import type { PlacementValidationViewModel, Vec3ViewModel } from '../organizer';

/** A snapped placement candidate. `position` is already on the footprint lattice. */
export interface PlacementCandidate {
  readonly kind: string;
  readonly position: Vec3ViewModel;
  readonly yawDegrees: number;
}

/** Stable key of a candidate request. Equal keys are the same request. */
export function placementCandidateKey(candidate: PlacementCandidate): string {
  const { x, y, z } = candidate.position;
  return `${candidate.kind}|${candidate.yawDegrees}|${x},${y},${z}`;
}

/** Construction-time dependencies. */
export interface PlacementPreviewDeps {
  /** The Organizer's placement preview query (server-authoritative). */
  readonly validate: (
    kind: string,
    position: Vec3ViewModel,
    yawDegrees: number,
  ) => Promise<PlacementValidationViewModel | null>;
  /** Delivered with the current verdict, or `null` while pending/neutral. */
  readonly onVerdict: (verdict: PlacementValidationViewModel | null) => void;
}

/** Imperative surface the editor component drives. */
export interface PlacementPreview {
  /** Request a preview for a candidate, or clear it with `null`. */
  setCandidate(candidate: PlacementCandidate | null): void;
  /** Drop any pending preview without requesting one. */
  clear(): void;
}

/** Create a preview controller. */
export function createPlacementPreview(deps: PlacementPreviewDeps): PlacementPreview {
  let generation = 0;
  let lastKey: string | null = null;

  return {
    setCandidate(candidate) {
      if (candidate === null) {
        generation += 1;
        lastKey = null;
        deps.onVerdict(null);
        return;
      }

      const key = placementCandidateKey(candidate);
      if (key === lastKey) {
        // Same request as the last one: never re-ask, never re-paint.
        return;
      }
      lastKey = key;

      const requestGeneration = generation + 1;
      generation = requestGeneration;
      // A new candidate is pending: neutralise any previous verdict right away.
      deps.onVerdict(null);

      void deps
        .validate(candidate.kind, candidate.position, candidate.yawDegrees)
        .then((verdict) => {
          if (requestGeneration !== generation) {
            // Superseded by a newer candidate: discard this response.
            return;
          }
          deps.onVerdict(verdict);
        })
        .catch(() => {
          if (requestGeneration !== generation) {
            return;
          }
          deps.onVerdict(null);
        });
    },

    clear() {
      generation += 1;
      lastKey = null;
      deps.onVerdict(null);
    },
  };
}
