/**
 * Client ASSET CATALOGUE — `AppearanceId -> AssetDescriptor | undefined`.
 *
 * This is the **only** place that knows an asset's URL, its model scale, its
 * orientation/height fixes, or the names of its animation clips. Nothing here is
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
 * The catalogue starts EMPTY on purpose: this repository ships no GLB art yet, so
 * every appearance keeps its procedural placeholder. The pipeline that would swap
 * a model in is real and exercised by tests through the injectable loader and the
 * checked-in fixture.
 *
 * Descriptor shape
 * ----------------
 * ```ts
 * interface AssetDescriptor {
 *   url: string;
 *   scale?: Vec3;                 // art sizing; presentation only
 *   yOffset?: number;             // vertical anchor fix (feet at the node root)
 *   yawOffsetRadians?: number;    // turn the art's front to the local +Z front
 *   clips?: { idle?; walk?; interact? };  // clip names for the AnimationMixer
 * }
 * ```
 *
 * A descriptor is **presentation metadata**. Changing one (or removing one) can
 * only change how a node is drawn; it can never move, add, remove or invalidate
 * an authoritative entity, a collider, or any occupancy concept. That property
 * is pinned by `asset-swap.test.ts`.
 *
 * Extension points recorded here (not implemented in this slice):
 * - DRACO/KTX2 compressed assets: register the decoder on the loader where it is
 *   configured (`loadGlbTemplate` in `runtime.ts`), not here.
 * - Instancing per `(layer, appearance)`: the runtime's existing bucket index is
 *   the seam; an instanced realisation would consume this same catalogue.
 */

import type { AppearanceId } from '@starvalley/render-protocol';

/** Named animation slots an appearance's GLB may provide. */
export interface AssetClips {
  /** Rest/idle clip name in the GLB, if the asset ships one. */
  readonly idle?: string;
  /** Walk/run clip name in the GLB, if the asset ships one. */
  readonly walk?: string;
  /** Interaction clip name in the GLB, if the asset ships one. */
  readonly interact?: string;
}

/** How one appearance is realised as a GLB, and the presentation-side fixes it needs. */
export interface AssetDescriptor {
  /** Asset URL (relative to the app base, or absolute). */
  readonly url: string;
  /** Per-axis model scale; absent means no scaling. */
  readonly scale?: { readonly x: number; readonly y: number; readonly z: number };
  /** Vertical offset (world units) that puts the model's feet at the node root. */
  readonly yOffset?: number;
  /** Yaw (radians) that turns the model's front to the project's local `+Z`. */
  readonly yawOffsetRadians?: number;
  /** Named animation clips the mixer can play for this appearance. */
  readonly clips?: AssetClips;
}

/** Back-compat alias: the runtime historically called a descriptor a `ModelAsset`. */
export type ModelAsset = AssetDescriptor;

/** The catalogue type: `AppearanceId -> AssetDescriptor | undefined`. */
export type AppearanceModelCatalogue = Readonly<Partial<Record<AppearanceId, AssetDescriptor>>>;

/**
 * The appearance slots the GLB pipeline recognises. Each has a procedural
 * placeholder in the runtime, so registering a descriptor is purely additive
 * presentation. Kept as data so a coverage test can pin that every slot has a
 * placeholder and (optionally) an asset descriptor.
 */
export const ENTITY_APPEARANCE_SLOTS: readonly AppearanceId[] = Object.freeze([
  asAppearanceId('appearance.character'),
  asAppearanceId('appearance.tree'),
  asAppearanceId('appearance.rock'),
  asAppearanceId('appearance.chest'),
  asAppearanceId('appearance.building'),
]);

/**
 * The catalogue. **Deliberately empty today** — no `.glb` files exist in this
 * repository yet, so every appearance renders its procedural placeholder.
 *
 * To swap in real art, add an entry, e.g.:
 *
 * ```ts
 * export const MODEL_CATALOGUE: AppearanceModelCatalogue = {
 *   [asAppearanceId('appearance.tree')]: {
 *     url: '/models/tree.glb',
 *     scale: { x: 1, y: 1, z: 1 },
 *     clips: { idle: 'Tree_Idle' },
 *   },
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
