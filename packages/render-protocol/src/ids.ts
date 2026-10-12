/**
 * Nominal ids for the Render ISA.
 *
 * These are the same brand technique used by the game protocol's `identity.ts`:
 * a non-exported `unique symbol` brand makes each id mutually non-assignable and
 * not assignable from a plain `string`. There are deliberately **no runtime
 * guards or parsers here**: the render ISA is applied in-process and is typed,
 * not untrusted wire data (guards exist for untrusted wire data only).
 *
 * A `NodeId` is deliberately NOT an `EntityId`. Game identity stops at the
 * render bridge, which maps entities to nodes; the renderer must not know game
 * identity. Likewise `AppearanceId` is an opaque catalogue key owned by the
 * runtime/bridge — the ISA never inspects it.
 */

declare const nodeIdBrand: unique symbol;
declare const appearanceIdBrand: unique symbol;
declare const animationIdBrand: unique symbol;

/** Identifier of a render node. A `NodeId` is not an entity id and not any other id. */
export type NodeId = string & { readonly [nodeIdBrand]: true };

/** Opaque identifier of an appearance in the runtime's catalogue. */
export type AppearanceId = string & { readonly [appearanceIdBrand]: true };

/** Opaque identifier of an animation in the runtime's catalogue. */
export type AnimationId = string & { readonly [animationIdBrand]: true };
