/**
 * Protocol-wide constants.
 *
 * `PROTOCOL_VERSION` is the client/server compatibility marker carried in
 * `GameInfo`. Bump it only for breaking wire changes.
 *
 * Version 9 is the phase-15 break: the world kernel converges on a
 * block-spatial model. `WorldSnapshot` drops the phase-14 world-geometry layer
 * (`surfaces`/`colliders`) and the gameplay grid (`grid`/`tiles`) and gains
 * `blockGrid` + a sparse `blocks` list of 3D integer cells; `CellCoord` becomes
 * 3D; `EntityKind` grows; the placement/block commands and the `block.changed`
 * event are added; the GameInfo payload gains the static `blockKinds`/
 * `entityKinds` presentation catalogues. The old snapshot shape is rejected by
 * the exact-key guards.
 */
export const PROTOCOL_VERSION = 9;

/** Wire path for the game-info endpoint. Transport-neutral: Router maps it. */
export const GAME_INFO_PATH = '/api/game-info';

/** Wire path for the health endpoint. Transport-neutral: Router maps it. */
export const HEALTH_PATH = '/api/health';

/** Wire path for the world snapshot endpoint (GET). Transport-neutral: Router maps it. */
export const WORLD_PATH = '/api/world';

/** Wire path for the command endpoint (POST `GameCommand`). Transport-neutral: Router maps it. */
export const COMMAND_PATH = '/api/command';

/**
 * Wire path for the world state stream (Server-Sent Events GET). Transport-neutral:
 * Router maps it. The stream emits a full `snapshot` first on every connection,
 * then `events` batches.
 */
export const STREAM_PATH = '/api/stream';
