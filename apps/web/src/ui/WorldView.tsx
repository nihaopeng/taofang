import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';

import { loadWorld, movePlayer, useWorld } from '../organizer';
import type { MoveDirection } from '../organizer';

/** Direction controls, in a stable order, with accessible names. */
const DIRECTIONS: ReadonlyArray<{ direction: MoveDirection; label: string; glyph: string }> = [
  { direction: 'north', label: 'Move north', glyph: '↑' },
  { direction: 'south', label: 'Move south', glyph: '↓' },
  { direction: 'west', label: 'Move west', glyph: '←' },
  { direction: 'east', label: 'Move east', glyph: '→' },
];

/**
 * Physical key -> movement intent. Arrows plus WASD, case-insensitive so the
 * mapping still works when Shift or CapsLock is on.
 */
const KEY_TO_DIRECTION: Readonly<Record<string, MoveDirection | undefined>> = {
  ArrowUp: 'north',
  ArrowDown: 'south',
  ArrowLeft: 'west',
  ArrowRight: 'east',
  w: 'north',
  W: 'north',
  s: 'south',
  S: 'south',
  a: 'west',
  A: 'west',
  d: 'east',
  D: 'east',
};

/**
 * Pure presentation of the Organizer's world/player state.
 *
 * Renders a `width x height` tile grid plus a marker at the authoritative player
 * tile, collects directional intent (buttons + keyboard), and shows loading /
 * error affordances. It never calls the backend: every intent goes through
 * `movePlayer` / `loadWorld` from the Organizer.
 */
export function WorldView() {
  const state = useWorld();
  const { status, world, player, error } = state;

  // Movement is only meaningful once an authoritative player exists. Keeping
  // this in a ref lets the `keydown` listener attach exactly once (and detach on
  // unmount) instead of being re-registered on every state transition.
  const canMove = status === 'ready' && player !== null;
  const canMoveRef = useRef(canMove);
  canMoveRef.current = canMove;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Let browser/OS shortcuts through untouched.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      // One step per physical press. Continuous movement while a key is held is
      // deliberately deferred to the input/prediction slice; honoring
      // `event.repeat` here would emit a request at the OS key-repeat rate.
      if (event.repeat) {
        return;
      }

      const direction = KEY_TO_DIRECTION[event.key];
      if (direction === undefined) {
        return;
      }

      // Arrow keys would otherwise scroll the page.
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
      }

      if (!canMoveRef.current) {
        return;
      }
      void movePlayer(direction);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Tiles are pure decoration keyed by tile coordinate; rebuilding only when the
  // world dimensions change keeps normal movement renders allocation-light.
  const tiles = useMemo(() => {
    if (world === null) {
      return null;
    }
    const cells = [];
    for (let y = 0; y < world.height; y += 1) {
      for (let x = 0; x < world.width; x += 1) {
        cells.push(<div key={`${x},${y}`} className="world__tile" />);
      }
    }
    return cells;
  }, [world]);

  const boardStyle: CSSProperties | undefined =
    world === null
      ? undefined
      : {
          gridTemplateColumns: `repeat(${world.width}, 1fr)`,
          aspectRatio: `${world.width} / ${world.height}`,
        };

  const playerStyle: CSSProperties | undefined =
    world === null || player === null
      ? undefined
      : {
          left: `${(player.x / world.width) * 100}%`,
          top: `${(player.y / world.height) * 100}%`,
          width: `${100 / world.width}%`,
          height: `${100 / world.height}%`,
        };

  return (
    <section className="world" data-testid="world-panel" data-status={status}>
      <h2 className="world__heading">World</h2>

      {player !== null ? (
        <p className="world__player-info" data-testid="player-info">
          <span className="world__player-name">{player.name}</span>{' '}
          <span className="world__player-coords">
            ({player.x}, {player.y})
          </span>
        </p>
      ) : null}

      {world !== null && player !== null ? (
        <div
          className="world__board"
          data-testid="world-grid"
          data-width={world.width}
          data-height={world.height}
          style={boardStyle}
        >
          {tiles}
          <div
            className="world__player"
            data-testid="player"
            data-x={player.x}
            data-y={player.y}
            style={playerStyle}
          />
        </div>
      ) : null}

      {status === 'idle' || status === 'loading' ? (
        <p className="world__loading" role="status">
          Loading world…
        </p>
      ) : null}

      {error !== null ? (
        <div className="world__error" role="alert">
          <p className="world__message">{error}</p>
          <button
            className="world__retry"
            type="button"
            onClick={() => {
              void loadWorld();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="world__controls">
        {DIRECTIONS.map(({ direction, label, glyph }) => (
          <button
            key={direction}
            className="world__control"
            type="button"
            aria-label={label}
            data-testid={`move-${direction}`}
            disabled={!canMove}
            onClick={() => {
              void movePlayer(direction);
            }}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
