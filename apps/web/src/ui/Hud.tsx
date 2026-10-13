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
 * The only state here is **presentational**: which tool slot is highlighted,
 * whether the bag panel is open, and whether the settings panel is open. No
 * gameplay meaning is attached to any of them, and no item, count or inventory is
 * invented.
 *
 * FUTURE DATA RULE
 * ----------------
 * Any real HUD data (inventory, hotbar contents, the selected tool's
 * authoritative state) or any real action (use tool, drop item) MUST be wired
 * through the Organizer: state comes IN as a view model / selector and actions
 * go OUT as Organizer intents. The HUD must not become a second source of truth
 * for world/entity state, and must not call the backend itself.
 *
 * CAMERA RIG RULE (hard)
 * ----------------------
 * Camera rig parameters — pitch, zoom and yaw — are **presentation**, not game
 * state. They are NOT Organizer data and must NEVER become a Protocol field. The
 * in-world settings panel therefore drives the render rig straight through the
 * rig API (`setCameraPitch`) via the `onPitchChange` callback it is handed; it
 * emits no Organizer intent. Gameplay actions (move/interact) remain the only
 * things that go through the Organizer.
 */
import { useRef, useState } from 'react';

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
  /** Live camera pitch, in degrees, as reported by the render rig. */
  pitchDegrees: number;
  /** The rig's clamp range, in degrees (`RENDER_CAMERA` min/max). */
  pitchRange: { readonly min: number; readonly max: number };
  /** Pitch a reload resets to; stated plainly because nothing is persisted. */
  defaultPitchDegrees: number;
  /** Drive the render rig's pitch directly. Never an Organizer intent. */
  onPitchChange: (degrees: number) => void;
}

/**
 * Presentational HUD chrome: a tool toolbar, a bag button + panel, the in-world
 * settings button + camera-pitch panel, and the server connection / notice
 * readouts. It receives display values and one presentation callback
 * (`onPitchChange`), exposes no other imperative surface, and cannot reach the
 * canvas, the runtime or the backend; the overlay itself is `pointer-events:
 * none` in CSS so canvas drag/click/wheel still pass through everywhere except
 * the controls.
 *
 * Pitch persistence: there is NONE. The value lives in the render rig and resets
 * to the default on reload; the panel says so rather than pretending otherwise.
 */
export function Hud(props: HudProps) {
  const { streamStatus, notice, pitchDegrees, pitchRange, defaultPitchDegrees, onPitchChange } =
    props;
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [bagOpen, setBagOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const closeSettings = (): void => {
    setSettingsOpen(false);
    // Return focus to the control that opened the panel so keyboard users do not
    // lose their place when Escape closes it.
    settingsButtonRef.current?.focus();
  };

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

        <div className="world__hud-actions">
          {/*
            The settings panel holds ONLY camera-rig presentation controls (the
            pitch today). It is a real keyboard-reachable form control set: the
            button is focusable, the slider is a native range input, and Escape
            closes the panel. It emits no Organizer intent.
          */}
          <div
            className="world__settings"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && settingsOpen) {
                event.stopPropagation();
                closeSettings();
              }
            }}
          >
            <button
              ref={settingsButtonRef}
              type="button"
              className="world__hud-control world__settings-button"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              aria-controls="world-settings-panel"
              data-testid="settings-button"
              onClick={() => {
                setSettingsOpen((open) => !open);
              }}
            >
              <span aria-hidden="true">{'\u2699'}</span>
              <span className="world__settings-button-label">Settings</span>
            </button>

            {settingsOpen ? (
              <div
                id="world-settings-panel"
                className="world__hud-control world__settings-panel"
                role="group"
                aria-label="Camera settings"
                data-hud-form="settings"
                data-testid="settings-panel"
              >
                <h3 className="world__settings-heading">Settings</h3>
                <div className="world__settings-field">
                  <label htmlFor="world-camera-pitch">Camera pitch</label>
                  <input
                    id="world-camera-pitch"
                    className="world__settings-slider"
                    type="range"
                    min={pitchRange.min}
                    max={pitchRange.max}
                    step={1}
                    value={pitchDegrees}
                    aria-valuetext={`${pitchDegrees} degrees`}
                    data-testid="camera-pitch"
                    onChange={(event) => {
                      // Presentation only: this drives the render rig through the
                      // callback the HUD was handed. It is never a wire field.
                      onPitchChange(Number(event.target.value));
                    }}
                  />
                  <output
                    className="world__settings-value"
                    htmlFor="world-camera-pitch"
                    data-testid="camera-pitch-value"
                  >
                    {pitchDegrees}°
                  </output>
                </div>
                <p className="world__settings-range" data-testid="camera-pitch-range">
                  Allowed range {pitchRange.min}°–{pitchRange.max}°.
                </p>
                <p className="world__settings-note">
                  Not saved: a reload resets the camera pitch to {defaultPitchDegrees}°.
                </p>
              </div>
            ) : null}
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
