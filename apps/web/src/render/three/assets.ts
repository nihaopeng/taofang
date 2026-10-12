/**
 * Client ASSET CATALOGUE — `AppearanceId -> GLB asset | undefined`.
 *
 * This is the **only** place that knows an asset's URL, its model
 * scale/orientation/height fixes, or its animation clip names. Nothing here is
 * ever sent over the wire: the Game Protocol, the Manager, the Router and the
 * Organizer cannot name an asset. Swapping real art in per appearance is a change
 * to this file alone (plus dropping the `.glb` under `apps/web/public/`).
 *
 * Why it lives under `render/three/`
 * ----------------------------------
 * It is pure data (no Three.js import), but the runtime is the only consumer and
 * the lint boundary for `apps/web/src/render/three/**` forbids importing any
 * parent (`../*`). Keeping it here is what lets the runtime read it without
 * weakening that boundary.
 *
 * The map starts EMPTY on purpose: this repository ships no GLB art yet, so every
 * appearance keeps its procedural placeholder. The pipeline that would swap a
 * model in is real and exercised by tests through the injectable loader and the
 * checked-in fixture.
 *
 * Catalogue shape
 * ---------------
 * - `url`      — relative asset path (resolved against the app base) or any URL.
 * - `scale`    — art sizing. The Render ISA also carries `RenderTransform.scale`,
 *                but the bridge leaves it neutral; a catalogue `scale` is the
 *                presentation-side sizing fix and does not touch gameplay.
 * - `yawRadians` — orientation fix: rotate the imported front to this project's
 *                `+Z` front convention (`yaw = atan2(vx, vz)`).
 * - `yOffset`  — vertical anchor fix when the exported origin is not at the feet.
 * - `idleClip`/`walkClip` — clip names, kept as data. Clip *playback* (an
 *                AnimationMixer, retargeting, blending) is not implemented in this
 *                slice; the names are recorded here so a future animator has one
 *                place to look. The procedural placeholder motion is skipped once
 *                a model is loaded, so these clips never fight it.
 *
 * Extension points recorded here (not implemented in this slice):
 * - DRACO/KTX2 compressed assets: register the decoder on the loader where it is
 *   configured (`loadGlbTemplate` in `runtime.ts`), not here.
 * - Instancing per `(layer, appearance)`: the runtime's existing bucket index is
 *   the seam; an instanced realisation would consume this same catalogue.
 */

import type { AppearanceId } from '@starvalley/render-protocol';

/** How one appearance is realised as a GLB, and the presentation-side fixes it needs. */
export interface ModelAsset {
  /** Asset URL (relative to the app base, or absolute). */
  readonly url: string;
  /** Uniform-per-axis model scale; absent means no scaling. */
  readonly scale?: { readonly x: number; readonly y: number; readonly z: number };
  /** Yaw (radians) that turns the model's front to the project's local `+Z`. */
  readonly yawRadians?: number;
  /** Vertical offset (world units) that puts the model's feet at the node root. */
  readonly yOffset?: number;
  /** Rest/idle clip name in the GLB, if the asset ships one. */
  readonly idleClip?: string;
  /** Walk clip name in the GLB, if the asset ships one. */
  readonly walkClip?: string;
}

/** The catalogue type: `AppearanceId -> ModelAsset | undefined`. */
export type AppearanceModelCatalogue = Readonly<Partial<Record<AppearanceId, ModelAsset>>>;

/**
 * The catalogue. **Deliberately empty today** — no `.glb` files exist in this
 * repository yet, so every appearance renders its procedural placeholder.
 *
 * To swap in real art, add an entry, e.g.:
 *
 * ```ts
 * export const MODEL_CATALOGUE: AppearanceModelCatalogue = {
 *   [asAppearanceId('appearance.tree')]: { url: '/models/tree.glb', scale: { x: 1, y: 1, z: 1 } },
 * };
 * ```
 */
export const MODEL_CATALOGUE: AppearanceModelCatalogue = Object.freeze({});

/**
 * Brand a plain string as an `AppearanceId` for catalogue keys.
 *
 * The render ISA ships branded id *types* only. The bridge brands appearance ids
 * it derives from game semantics; this helper is the equivalent for a
 * hand-authored asset catalogue, so a literal key type-checks.
 */
export function asAppearanceId(value: string): AppearanceId {
  return value as AppearanceId;
}
