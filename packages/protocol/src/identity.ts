import { ProtocolParseError } from './errors.ts';
import { isNonEmptyString } from './internal.ts';

/**
 * Nominal identity types.
 *
 * Web Stardew deliberately separates four identity concepts that answer
 * different questions. They are **distinct nominal (branded) types**: mutually
 * non-assignable and not assignable from a plain `string`. This prevents an id
 * from silently drifting across a boundary it does not belong to — in
 * particular, it stops `ActorId` from becoming a universal id.
 *
 * | Type       | Answers                                              | In the world? | On the wire today? |
 * | ---------- | ---------------------------------------------------- | ------------- | ------------------ |
 * | `EntityId` | "this *thing* exists" (any world object)             | yes           | no                 |
 * | `ActorId`  | "this *thing that can act* is who" (command subject) | yes           | yes (movement)     |
 * | `PlayerId` | "this *human/session* is who" (auth principal)       | **no**        | **no**             |
 * | `WorldId`  | "this world is which" (snapshot scope)               | n/a           | yes (snapshot)     |
 *
 * Runtime behaviour of all four is identical: a non-empty string.
 *
 * `PlayerId` is **not a wire field today**: it is vocabulary reserved for the
 * session slice. The relation below is reserved, not implemented; it is
 * deliberately not encoded as a wire field.
 *
 * ```text
 * PlayerId (authentication principal, out of world)
 *    │ controls
 *    ▼
 * ActorId (a thing that can act, in world)
 *    │ identifies
 *    ▼
 * Entity  (any world object, referenced through its EntityId)
 * ```
 *
 * The brands use non-exported `unique symbol`s, so code outside this module
 * cannot manufacture one except through the exported `parse*` helpers.
 */

declare const entityIdBrand: unique symbol;
declare const actorIdBrand: unique symbol;
declare const playerIdBrand: unique symbol;
declare const worldIdBrand: unique symbol;

/** Identifier of any world object (tiles, objects, crops, ...). Non-empty string. */
export type EntityId = string & { readonly [entityIdBrand]: true };

/** Identifier of a thing that can act — the subject of a command. Non-empty string. */
export type ActorId = string & { readonly [actorIdBrand]: true };

/** Identifier of an authentication principal, outside the world. Non-empty string. */
export type PlayerId = string & { readonly [playerIdBrand]: true };

/** Identifier of a world (a snapshot's scope). Non-empty string. */
export type WorldId = string & { readonly [worldIdBrand]: true };

/** Structural/runtime guard for `EntityId`: any non-empty string. */
export function isEntityId(value: unknown): value is EntityId {
  return isNonEmptyString(value);
}

/** Parse and validate `EntityId`, throwing `ProtocolParseError` on mismatch. */
export function parseEntityId(value: unknown): EntityId {
  if (!isEntityId(value)) {
    throw new ProtocolParseError('Invalid EntityId payload');
  }
  return value;
}

/** Structural/runtime guard for `ActorId`: any non-empty string. */
export function isActorId(value: unknown): value is ActorId {
  return isNonEmptyString(value);
}

/** Parse and validate `ActorId`, throwing `ProtocolParseError` on mismatch. */
export function parseActorId(value: unknown): ActorId {
  if (!isActorId(value)) {
    throw new ProtocolParseError('Invalid ActorId payload');
  }
  return value;
}

/** Structural/runtime guard for `PlayerId`: any non-empty string. */
export function isPlayerId(value: unknown): value is PlayerId {
  return isNonEmptyString(value);
}

/** Parse and validate `PlayerId`, throwing `ProtocolParseError` on mismatch. */
export function parsePlayerId(value: unknown): PlayerId {
  if (!isPlayerId(value)) {
    throw new ProtocolParseError('Invalid PlayerId payload');
  }
  return value;
}

/** Structural/runtime guard for `WorldId`: any non-empty string. */
export function isWorldId(value: unknown): value is WorldId {
  return isNonEmptyString(value);
}

/** Parse and validate `WorldId`, throwing `ProtocolParseError` on mismatch. */
export function parseWorldId(value: unknown): WorldId {
  if (!isWorldId(value)) {
    throw new ProtocolParseError('Invalid WorldId payload');
  }
  return value;
}
