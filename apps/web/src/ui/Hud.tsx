/**
 * The HTML HUD layer drawn OVER the world canvas.
 *
 * Boundary (AGENTS.md: UI)
 * ------------------------
 * This is presentation only. It renders DOM/CSS above the WebGL canvas; it does
 * not draw the world and it owns no world/entity state. It must never import
 * `@starvalley/protocol`, `@starvalley/render-protocol`, the Router / Manager /
 * Server packages, or call `fetch` / WebSocket. It also never reaches into the
 * render runtime's internals.
 *
 * The only state here is **presentational**: which tool slot is highlighted and
 * whether the bag panel is open. No gameplay meaning is attached to either, and
 * no item, count or inventory is invented.
 *
 * FUTURE DATA RULE
 * ----------------
 * Any real HUD data (inventory, hotbar contents, the selected tool's
 * authoritative state) or any real action (use tool, drop item) MUST be wired
 * through the Organizer: state comes IN as a view model / selector and actions
 * go OUT as Organizer intents. The HUD must not become a second source of truth
 * for world/entity state, and must not call the backend itself.
 */
import { useState } from 'react';

import type { StreamStatus } from '../organizer';

/**
 * A tool slot. The labels are placeholder affordances with accessible names;
 * they do not imply that any tool action exists yet.
 */
interface ToolSlot {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
}

const TOOL_SLOTS: readonly ToolSlot[] = [
  { id: 'hoe', label: 'Hoe', glyph: '\u26cf' },
  { id: 'watering-can', label: 'Watering can', glyph: '\u{1F6BF}' },
  { id: 'axe', label: 'Axe', glyph: '\u{1FA93}' },
  { id: 'seeds', label: 'Seeds', glyph: '\u{1F331}' },
];

/** Short, user-presentable label for the realtime stream lifecycle. */
const STREAM_LABEL: Readonly<Record<StreamStatus, string>> = {
  idle: 'Stream idle',
  connecting: 'Connecting…',
  live: 'Live',
  error: 'Connection lost',
};

export interface HudProps {
  /** Realtime stream lifecycle; display only. */
  streamStatus: StreamStatus;
  /** Transient Organizer refusal message, or `null`; display only. */
  notice: string | null;
}

/**
 * Presentational HUD chrome: a tool toolbar, a bag button + panel, and the
 * server connection / notice readouts. It receives only display values, exposes
 * no imperative surface, and cannot reach the canvas, the runtime or the
 * backend; the overlay itself is `pointer-events: none` in CSS so canvas
 * drag/click/wheel still pass through everywhere except the controls.
 */
export function Hud(props: HudProps) {
  const { streamStatus, notice } = props;
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [bagOpen, setBagOpen] = useState(false);

  return (
    <div className="world__hud" role="group" aria-label="World overlay" data-testid="world-hud">
      <div className="world__hud-top">
        <div className="world__toolbar" role="toolbar" aria-label="Tools" data-testid="world-toolbar">
          {TOOL_SLOTS.map((slot) => {
            const selected = slot.id === selectedToolId;
            return (
              <button
                key={slot.id}
                type="button"
                className="world__hud-control world__tool"
                aria-label={slot.label}
                aria-pressed={selected}
                data-testid={`tool-${slot.id}`}
                onClick={() => {
                  // Presentational only: this highlights/deselects a slot. It arms
                  // no world action and never reaches the Organizer or the runtime.
                  setSelectedToolId((current) => (current === slot.id ? null : slot.id));
                }}
              >
                <span aria-hidden="true">{slot.glyph}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="world__hud-control world__bag-button"
          aria-label="Bag"
          aria-expanded={bagOpen}
          aria-controls="world-bag-panel"
          data-testid="bag-button"
          onClick={() => {
            setBagOpen((open) => !open);
          }}
        >
          <span aria-hidden="true">{'\u{1F392}'}</span>
          <span className="world__bag-button-label">Bag</span>
        </button>
      </div>

      <p
        className="world__hud-status world__stream"
        data-testid="world-stream-status"
        data-stream-status={streamStatus}
      >
        {STREAM_LABEL[streamStatus]}
      </p>

      {/*
        A rejected intent (out of range / not interactable / target gone) is a
        short, transient message, not a broken-world error; the Organizer clears
        it on the next successful intent. Display-only.
      */}
      {notice !== null ? (
        <p className="world__hud-status world__notice" role="status" data-testid="world-notice">
          {notice}
        </p>
      ) : null}

      {bagOpen ? (
        <div
          id="world-bag-panel"
          className="world__hud-control world__bag-panel"
          data-testid="bag-panel"
        >
          <h3 className="world__bag-heading">Bag</h3>
          <p className="world__bag-empty">Inventory is not implemented yet.</p>
          <p className="world__bag-note">
            No items or counts are shown because there is no authoritative inventory on the
            server yet.
          </p>
        </div>
      ) : null}
    </div>
  );
}
