import { useEffect } from 'react';

import { loadGameInfo } from '../organizer';
import { GameInfoPanel } from './GameInfoPanel';

/**
 * Page shell. On mount it emits the Organizer intent to load game info; the
 * panel below renders whatever state the Organizer exposes.
 */
export function App() {
  useEffect(() => {
    void loadGameInfo();
  }, []);

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Starvalley</h1>
        <p className="app__subtitle">Web Stardew — phase 1 skeleton</p>
      </header>
      <GameInfoPanel />
    </main>
  );
}
