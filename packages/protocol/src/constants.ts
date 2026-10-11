/**
 * Protocol-wide constants.
 *
 * `PROTOCOL_VERSION` is the client/server compatibility marker carried in
 * `GameInfo`. Bump it only for breaking wire changes.
 */
export const PROTOCOL_VERSION = 1;

/** Wire path for the game-info endpoint. Transport-neutral: Router maps it. */
export const GAME_INFO_PATH = '/api/game-info';

/** Wire path for the health endpoint. Transport-neutral: Router maps it. */
export const HEALTH_PATH = '/api/health';
