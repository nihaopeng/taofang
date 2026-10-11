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

/** Wire path for the world snapshot endpoint (GET). Transport-neutral: Router maps it. */
export const WORLD_PATH = '/api/world';

/** Wire path for the player move command (POST). Transport-neutral: Router maps it. */
export const PLAYER_MOVE_PATH = '/api/player/move';
