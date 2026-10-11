import { useEffect } from 'react';

import { loadGameInfo, loadWorld } from '../organizer';
import { GameInfoPanel } from './GameInfoPanel';
import { WorldView } from './WorldView';

/**
 * Page shell. On mount it emits the Organizer intents to load game info and the
 * world; the panels below render whatever state the Organizer exposes. The two
 * loads are independent resources, so they get separate effects.
 */
export function App() {
  useEffect(() => {
    void loadGameInfo();
  }, []);

  useEffect(() => {
    void loadWorld();
  }, []);

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Starvalley</h1>
        <p className="app__subtitle">Server-authoritative world, player, and movement</p>
      </header>
      <GameInfoPanel />
      <WorldView />
    </main>
  );
}
