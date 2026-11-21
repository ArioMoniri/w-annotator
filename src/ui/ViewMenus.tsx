import { ChevronUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../state/settings';
import { set, useStore } from '../state/store';
import { fitAll } from '../viewer/engine';
import { PRESET_MAX, PRESET_NAME_MAX, formatWindow, matchChoice, presetNameError, windowChoices, type WindowChoice } from '../viewer/window';
import { applyWindowChoice, removeWindowPreset, saveWindowPreset, setWindowSet, zoomActive, zoomActualSize } from '../windowing';
import { Choice, Modal, useDismiss, useKeyHint } from './common';

/**
 * The window and zoom read-outs of the status bar. Each is a button that opens a small
 * menu above it, so both can be changed with any tool selected, by mouse or keyboard.
 */

/** Arrow keys move through a menu's items. Keys pressed in a menu are not tool shortcuts. */
function menuKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.ctrlKey || e.metaKey) return;
  // Esc is handled where the menu is dismissed; everything else stays in the menu.
  if (e.key !== 'Escape') e.stopPropagation();
  const move = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 }[e.key];
  if (move === undefined) return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + move + items.length) % items.length;
  items[next].focus();
}

/** Opening, closing and placing a menu above a status bar button. */
function useStatusMenu() {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<React.CSSProperties>({});
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLSpanElement>(open, close);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const r = button.current!.getBoundingClientRect();
    // Above the bar, its right edge on the button's, never taller than the room above it.
    setPlace({ position: 'fixed', bottom: window.innerHeight - r.top + 4, right: Math.max(8, window.innerWidth - r.right), maxHeight: Math.max(120, r.top - 12) });
    setOpen(!open);
  };
  // Focus goes into the menu, to the item in use when there is one.
  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('button.item'))?.focus();
  }, [open]);
  /** Closes after a choice. A choice made from the keyboard leaves the focus on the button. */
  const done = (e: React.MouseEvent) => {
    setOpen(false);
    if (e.detail === 0) button.current?.focus();
  };
  /** Arrows move through the items; Tab leaves the menu, so it closes. */
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') setOpen(false);
    else menuKeys(e);
  };
  return { open, place, ref, button, menu, toggle, done, close, keys };
}

const GROUP: Record<WindowChoice['kind'], string> = { builtin: 'preset', custom: 'saved', auto: 'image', full: 'image' };

export function WindowReadout() {
  const voi = useStore((s) => s.voi);
  const image = useStore((s) => s.image);
  const asked = useStore((s) => s.windowSet);
  const custom = useSettings((s) => s.windowPresets);
  const m = useStatusMenu();
  if (!voi || !image) return null;
  const which = asked ?? (image.ct ? 'ct' : 'mr');
  const choices = windowChoices(image, custom, which);
  const current = matchChoice(choices, voi);
  const { w, l } = formatWindow(voi);
  return (
    <span className="statusmenu" ref={m.ref}>
      <button
        ref={m.button}
        className="statusbtn"
        data-testid="status-window"
        aria-haspopup="menu"
        aria-expanded={m.open}
        aria-label={`Window: width ${w}, level ${l}${current ? `, ${current.name}` : ''}`}
        title="Change the window"
        onClick={m.toggle}
      >
        <b>W</b> {w} <b>L</b> {l}
        {current && (
          <span className="preset" data-drop-order="1">
            {' '}
            {current.name}
          </span>
        )}
        <ChevronUp size={10} aria-hidden />
      </button>
      {m.open && (
        <div className="menu statuspop" role="menu" aria-label="Window" ref={m.menu} style={m.place} onKeyDown={m.keys}>
          <div className="row">
            <span id="window-set">Presets for</span>
            <Choice
              label="Presets for"
              labelledBy="window-set"
              value={which}
              options={[
                { value: 'ct', label: 'CT' },
                { value: 'mr', label: 'MR' },
              ]}
              onChange={setWindowSet}
            />
          </div>
          <hr />
          {choices.map((c, i) => {
            const item = (
              <button
                className="item"
                role="menuitemradio"
                aria-checked={c === current}
                data-preset={c.name}
                onClick={(e) => {
                  applyWindowChoice(c);
                  m.done(e);
                }}
              >
                <span>{c.name}</span>
                <span className="wl">
                  W {formatWindow(c.voi).w} L {formatWindow(c.voi).l}
                </span>
              </button>
            );
            return (
              <div key={`${c.kind}:${c.name}`} style={{ display: 'contents' }}>
                {i > 0 && GROUP[choices[i - 1].kind] !== GROUP[c.kind] && <hr />}
                {c.kind === 'custom' ? (
                  <div className="presetrow">
                    {item}
                    <button className="iconbtn sm" aria-label={`Remove preset ${c.name}`} title="Remove" onClick={() => removeWindowPreset(c.name)}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  item
                )}
              </div>
            );
          })}
          <hr />
          <button
            className="item"
            role="menuitem"
            onClick={() => {
              m.close();
              set({ savePreset: true });
            }}
          >
            Save current as preset…
          </button>
        </div>
      )}
    </span>
  );
}

export function ZoomReadout() {
  const zoom = useStore((s) => s.zoom);
  const slice = useStore((s) => s.activeView !== 'volume3d');
  const key = useKeyHint();
  const m = useStatusMenu();
  if (zoom == null) return null;
  const percent = Math.round(zoom * 100);
  return (
    <span className="statusmenu" data-drop-order="3" ref={m.ref}>
      <button
        ref={m.button}
        className="statusbtn"
        style={{ minWidth: 82 }}
        data-testid="status-zoom"
        aria-haspopup="menu"
        aria-expanded={m.open}
        aria-label={`Zoom ${percent}%`}
        title="Change the zoom"
        onClick={m.toggle}
      >
        <b>Zoom</b> {percent}%
        <ChevronUp size={10} aria-hidden />
      </button>
      {m.open && (
        <div className="menu statuspop" role="menu" aria-label="Zoom" ref={m.menu} style={m.place} onKeyDown={m.keys}>
          <button className="item" role="menuitem" onClick={() => zoomActive(1)}>
            Zoom in {key('view.zoomIn') && <kbd>{key('view.zoomIn')}</kbd>}
          </button>
          <button className="item" role="menuitem" onClick={() => zoomActive(-1)}>
            Zoom out {key('view.zoomOut') && <kbd>{key('view.zoomOut')}</kbd>}
          </button>
          <hr />
          <button
            className="item"
            role="menuitem"
            onClick={(e) => {
              fitAll();
              m.done(e);
            }}
          >
            Fit {key('view.fit') && <kbd>{key('view.fit')}</kbd>}
          </button>
          <button
            className="item"
            role="menuitem"
            disabled={!slice}
            title="One image pixel on one screen pixel"
            onClick={(e) => {
              zoomActualSize();
              m.done(e);
            }}
          >
            Actual size
          </button>
        </div>
      )}
    </span>
  );
}

const READOUT = '[data-testid="status-window"]';

/** Asks for a name and saves the window on screen under it. */
export function SavePresetDialog() {
  const open = useStore((s) => s.savePreset);
  const voi = useStore((s) => s.voi);
  const custom = useSettings((s) => s.windowPresets);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setError('');
    }
  }, [open]);
  if (!open || !voi) return null;
  const close = () => set({ savePreset: false });
  const full = custom.length >= PRESET_MAX;
  const { w, l } = formatWindow(voi);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = saveWindowPreset(name);
    if (problem) setError(problem);
    else close();
  };
  return (
    <Modal title="Save window as preset" onClose={close} returnTo={READOUT}>
      <h2>Save window as preset</h2>
      <form className="form" onSubmit={submit}>
        <p className="wl">
          W {w} L {l}
        </p>
        <label>
          Name
          <input type="text" value={name} maxLength={PRESET_NAME_MAX} disabled={full} onChange={(e) => (setName(e.target.value), setError(''))} />
        </label>
        {(error || full) && (
          <span className="error" role="alert">
            {error || presetNameError(name, custom)}
          </span>
        )}
        <div className="footer" style={{ marginTop: 8 }}>
          <button type="button" className="btn secondary lg" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary lg" disabled={full}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
