import { useEffect, useRef } from 'react';

import { loadWorld, moveActor, useWorld } from '../organizer';
import type { MoveDirection } from '../organizer';
import { SceneView } from './SceneView';

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
 * Presentation of the Organizer's world/actor state.
 *
 * The world itself is rendered by `<SceneView />` (Three.js executing the Render
 * ISA). This component keeps only the HUD: directional intent (buttons +
 * keyboard), the loading affordance, the error affordance with `Retry`, and a
 * short status line for the controlled actor. It never calls the backend: every
 * intent goes through `moveActor` / `loadWorld` from the Organizer. The UI
 * deliberately does not know (or send) which actor it controls — that identity
 * is resolved by the server from transport context.
 */
export function WorldView() {
  const state = useWorld();
  const { status, entities, controlledActorId, error } = state;

  // Movement is only meaningful once an authoritative controlled actor exists.
  // Keeping this in a ref lets the `keydown` listener attach exactly once (and
  // detach on unmount) instead of being re-registered on every state transition.
  const canMove = status === 'ready' && controlledActorId !== null;
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
      void moveActor(direction);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // The controlled entity is the one linked to the controlled actor. It is
  // derived from Organizer state; the UI invents no identity of its own.
  const controlledEntity =
    controlledActorId === null
      ? null
      : (entities.find((entity) => entity.actorId === controlledActorId) ?? null);

  return (
    <section className="world" data-testid="world-panel" data-status={status}>
      <h2 className="world__heading">World</h2>

      <SceneView />

      {controlledEntity !== null ? (
        <p className="world__actor-info" data-testid="controlled-actor-info">
          <span className="world__actor-coords">
            ({controlledEntity.x}, {controlledEntity.y})
          </span>
        </p>
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
              void moveActor(direction);
            }}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
