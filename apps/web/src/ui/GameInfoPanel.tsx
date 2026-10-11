import { loadGameInfo, useGameInfo } from '../organizer';

/**
 * Pure presentation of the Organizer's game-info state.
 *
 * Renders only the presentation-ready view model; it never sees protocol DTOs,
 * `Response` objects, or raw error internals. The only intent it emits is
 * `loadGameInfo()`, and it does not know how that intent reaches the server.
 */
export function GameInfoPanel() {
  const state = useGameInfo();

  return (
    <section
      className="game-info"
      data-testid="game-info-panel"
      data-status={state.status}
    >
      <h2 className="game-info__heading">Game server</h2>
      {state.status === 'connected' && state.data !== null ? (
        <dl className="game-info__details">
          <dt className="game-info__term">Game</dt>
          <dd className="game-info__value">{state.data.gameName}</dd>
          <dt className="game-info__term">Server version</dt>
          <dd className="game-info__value">{state.data.serverVersion}</dd>
          <dt className="game-info__term">Last synced</dt>
          <dd className="game-info__value">{state.data.lastSyncedAt}</dd>
        </dl>
      ) : state.status === 'error' ? (
        <div className="game-info__error" role="alert">
          <p className="game-info__message">{state.error}</p>
          <button
            className="game-info__retry"
            type="button"
            onClick={() => {
              void loadGameInfo();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <p className="game-info__loading" role="status">
          Contacting server…
        </p>
      )}
    </section>
  );
}
