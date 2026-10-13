/**
 * The in-world editor palette (block + entity), rendered inside the HUD.
 *
 * Presentation only: it receives the game-info catalogues (block/entity kinds)
 * and the current selection/verdict, and emits selection/place/clear/rotate
 * callbacks. It owns no gameplay rule and never calls the backend. Its buttons
 * are ordinary HTML controls inside the `pointer-events: none` overlay, so they
 * re-enable pointer events only for themselves (`.world__hud-control`) and a
 * drag/click/wheel on the canvas outside the panel still reaches the world.
 *
 * Keyboard: the panel is `data-hud-form`, so the global movement/Q-E/G handlers
 * ignore keys pressed while it has focus (arrow keys may move focus between
 * buttons instead of walking the actor). `R` is handled here too, so it still
 * rotates the selection while a palette button owns focus.
 *
 * PLACEABILITY (recorded decision): the entity palette lists the kinds from the
 * `entityKinds` catalogue verbatim and lets the SERVER decide placeability. The
 * frozen `EntityKindInfo` carries no placeable flag and even synthesizes
 * placement geometry for the non-placeable `character` kind, so a client-side
 * exclusion would be an invented placement rule. A non-placeable kind simply
 * comes back `valid: false, reason: 'not-placeable'` from
 * `entity.validatePlacement` and paints red with that reason shown. The honest
 * eventual fix is a shape change so the wire stops stating something untrue:
 * `EntityKindInfo.placement: { footprintX, footprintZ, height, allowedYawSteps,
 * pivot } | null`, which removes the synthesized geometry and answers
 * placeability with one field.
 */

import { useRef, useState } from 'react';

import type {
  BlockKindInfoViewModel,
  EntityKindInfoViewModel,
  PlacementValidationViewModel,
} from '../organizer';
import type { EditorSelection } from './editor-state';

/** Human labels for the known block kinds; unknown kinds fall back to the id. */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
  air: 'Air (remove)',
  grass: 'Grass',
  soil: 'Soil',
  stone: 'Stone',
  path: 'Path',
  water: 'Water',
  slab: 'Slab',
  stairs: 'Stairs',
  ramp: 'Ramp',
};

function blockLabel(kind: string): string {
  return BLOCK_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function entityLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export interface EditorPaletteProps {
  readonly blockKinds: readonly BlockKindInfoViewModel[];
  readonly entityKinds: readonly EntityKindInfoViewModel[];
  readonly selection: EditorSelection;
  /** The latest server verdict for the pending entity candidate, or `null`. */
  readonly verdict: PlacementValidationViewModel | null;
  readonly onSelectBlock: (kind: string) => void;
  readonly onSelectEntity: (kind: string) => void;
  readonly onClear: () => void;
  readonly onPlace: () => void;
  readonly onRotate: () => void;
}

export function EditorPalette(props: EditorPaletteProps) {
  const {
    blockKinds,
    entityKinds,
    selection,
    verdict,
    onSelectBlock,
    onSelectEntity,
    onClear,
    onPlace,
    onRotate,
  } = props;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const active = selection.mode !== 'none';

  return (
    <div
      className="world__editor"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
          return;
        }
        if (event.key === 'r' || event.key === 'R') {
          // Handled here so R still works while focus is inside the panel (the
          // global handler deliberately ignores keys from a `data-hud-form`).
          event.stopPropagation();
          onRotate();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="world__hud-control world__editor-button"
        aria-label="Editor"
        aria-expanded={open}
        aria-controls="world-editor-panel"
        data-testid="editor-button"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span aria-hidden="true">{'\u{1F6E0}'}</span>
        <span className="world__editor-button-label">Editor</span>
      </button>

      {open ? (
        <div
          id="world-editor-panel"
          className="world__hud-control world__editor-panel"
          role="group"
          aria-label="World editor"
          data-hud-form="editor"
          data-testid="editor-panel"
        >
          <h3 className="world__editor-heading">Editor</h3>

          <div className="world__editor-section">
            <p className="world__editor-sublabel" id="world-block-palette-label">
              Block palette
            </p>
            <div
              className="world__editor-grid"
              role="toolbar"
              aria-labelledby="world-block-palette-label"
              data-testid="block-palette"
            >
              {blockKinds.map((info) => {
                const selected = selection.mode === 'block' && selection.kind === info.kind;
                return (
                  <button
                    key={info.kind}
                    type="button"
                    className="world__hud-control world__editor-entry"
                    aria-label={`${blockLabel(info.kind)}${info.orientable ? ' (orientable)' : ''}`}
                    aria-pressed={selected}
                    data-testid={`block-kind-${info.kind}`}
                    onClick={() => {
                      onSelectBlock(info.kind);
                    }}
                  >
                    {blockLabel(info.kind)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="world__editor-section">
            <p className="world__editor-sublabel" id="world-entity-palette-label">
              Entity palette
            </p>
            <div
              className="world__editor-grid"
              role="toolbar"
              aria-labelledby="world-entity-palette-label"
              data-testid="entity-palette"
            >
              {entityKinds.map((info) => {
                const selected = selection.mode === 'entity' && selection.kind === info.kind;
                return (
                  <button
                    key={info.kind}
                    type="button"
                    className="world__hud-control world__editor-entry"
                    aria-label={entityLabel(info.kind)}
                    aria-pressed={selected}
                    data-testid={`entity-kind-${info.kind}`}
                    onClick={() => {
                      onSelectEntity(info.kind);
                    }}
                  >
                    {entityLabel(info.kind)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="world__editor-actions">
            <button
              type="button"
              className="world__hud-control world__editor-place"
              aria-label="Place selected"
              disabled={!active}
              data-testid="editor-place"
              onClick={onPlace}
            >
              Place
            </button>
            <button
              type="button"
              className="world__hud-control world__editor-clear"
              aria-label="Clear selection"
              disabled={!active}
              data-testid="editor-clear"
              onClick={onClear}
            >
              Clear
            </button>
          </div>

          {verdict !== null && !verdict.valid && verdict.reason !== null ? (
            <p className="world__editor-reason" role="status" data-testid="editor-reason">
              {verdict.reason}
            </p>
          ) : null}

          <p className="world__editor-hint">
            R rotates the selection. Left click places; right click removes blocks.
          </p>
        </div>
      ) : null}
    </div>
  );
}
