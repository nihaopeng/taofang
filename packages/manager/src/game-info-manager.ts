import { PROTOCOL_VERSION } from '@starvalley/protocol';
import type {
  BlockKind,
  BlockKindInfo,
  EntityKind,
  EntityKindInfo,
  GameInfo,
  HealthStatus,
} from '@starvalley/protocol';

import { BLOCK_DEFINITIONS } from './blocks.ts';
import { ENTITY_DEFINITIONS } from './entities.ts';
import { DEFAULT_ACTOR_HEIGHT } from './entities.ts';

/**
 * Version of the authoritative server build, surfaced through `GameInfo` so
 * clients can display and reason about which server they are talking to.
 */
export const SERVER_VERSION = '0.1.0';

const DEFAULT_GAME_NAME = 'Starvalley';

const BLOCK_KINDS: readonly BlockKind[] = Object.keys(BLOCK_DEFINITIONS) as BlockKind[];

const ENTITY_KINDS: readonly EntityKind[] = Object.keys(ENTITY_DEFINITIONS) as EntityKind[];

/**
 * A block is orientable when its collision shape is directional. The rule lives
 * with the shape definition (one owner), never as a hardcoded kind list, so a
 * new directional shape is orientable automatically.
 */
function isOrientableBlock(kind: BlockKind): boolean {
  const shape = BLOCK_DEFINITIONS[kind].collisionShape.type;
  return shape === 'stair' || shape === 'ramp';
}

/**
 * Declarative, presentation-only block catalogue for `GET /api/game-info`.
 * It carries NO collision shape and NO rule: only the kind and whether a
 * non-default orientation is meaningful.
 */
export const BLOCK_KIND_INFOS: readonly BlockKindInfo[] = BLOCK_KINDS.map((kind) => ({
  kind,
  orientable: isOrientableBlock(kind),
}));

/**
 * Declarative, presentation-only entity catalogue for `GET /api/game-info`.
 * It carries NO collider and NO rule: only the footprint/height/yaw/pivot
 * geometry a client needs to draw a placement ghost. `character` is not
 * placeable and is given its body geometry so the catalogue stays total.
 */
export const ENTITY_KIND_INFOS: readonly EntityKindInfo[] = ENTITY_KINDS.map((kind) => {
  const placement = ENTITY_DEFINITIONS[kind].placement;
  if (placement === undefined) {
    return {
      kind,
      footprintX: 1,
      footprintZ: 1,
      height: DEFAULT_ACTOR_HEIGHT,
      allowedYawSteps: [0, 90, 180, 270],
      pivot: 'center',
    };
  }
  return {
    kind,
    footprintX: placement.footprint.x,
    footprintZ: placement.footprint.z,
    height: placement.height,
    allowedYawSteps: [...placement.allowedYawSteps],
    pivot: 'center',
  };
});

/** Read-only, transport-neutral access to server identity and liveness. */
export interface GameInfoManager {
  /** Server identity plus a fresh protocol-compatible timestamp. */
  getGameInfo(): GameInfo;
  /** The static presentation block catalogue (fresh copies). */
  getBlockKinds(): BlockKindInfo[];
  /** The static presentation entity catalogue (fresh copies). */
  getEntityKinds(): EntityKindInfo[];
  /**
   * Liveness payload. `now` defaults to the current clock time; injecting it
   * keeps uptime computation deterministic and testable.
   */
  getHealth(now?: Date): HealthStatus;
}

/** Construction-time dependencies for {@link createGameInfoManager}. */
export interface CreateGameInfoManagerDeps {
  /** Time source. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Server start instant. Defaults to `clock()` evaluated once at creation. */
  startedAt?: Date;
  /** Display name for this server. Defaults to `'Starvalley'`. */
  gameName?: string;
  /** Server build version. Defaults to {@link SERVER_VERSION}. */
  serverVersion?: string;
}

/**
 * Create an authoritative `GameInfoManager`.
 *
 * Pure and synchronous: no I/O, no transport, no persistence. All state
 * (clock, start instant, identity strings) is captured at creation, and each
 * call returns a fresh Protocol-shaped DTO.
 */
export function createGameInfoManager(deps: CreateGameInfoManagerDeps = {}): GameInfoManager {
  const clock = deps.clock ?? ((): Date => new Date());
  const startedAt = deps.startedAt ?? clock();
  const gameName = deps.gameName ?? DEFAULT_GAME_NAME;
  const serverVersion = deps.serverVersion ?? SERVER_VERSION;

  return {
    getGameInfo(): GameInfo {
      return {
        gameName,
        serverVersion,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: clock().toISOString(),
      };
    },

    getBlockKinds(): BlockKindInfo[] {
      return BLOCK_KIND_INFOS.map((entry) => ({ ...entry }));
    },

    getEntityKinds(): EntityKindInfo[] {
      return ENTITY_KIND_INFOS.map((entry) => ({
        ...entry,
        allowedYawSteps: [...entry.allowedYawSteps],
      }));
    },

    getHealth(now: Date = clock()): HealthStatus {
      const uptimeSeconds = Math.max(
        0,
        Math.floor((now.getTime() - startedAt.getTime()) / 1000),
      );
      return {
        status: 'ok',
        uptimeSeconds,
        serverTime: now.toISOString(),
      };
    },
  };
}
