import { useEffect, useState } from 'react';
import {
  ACTIONS,
  comboFromEvent,
  formatCombo,
  isReserved,
  labelOf,
  rebindNote,
  resetShortcuts,
  setShortcut,
  setShortcuts,
  useShortcuts,
  type ActionId,
  type Bindings,
} from '../state/shortcuts';
import { set } from '../state/store';
import { MOD, isMac } from './common';

const MOUSE: [string, string][] = [
  ['Change slice', 'Scroll'],
  ['Change slice, five at a time', 'Shift+Scroll'],
  ['Zoom', `${MOD}+Scroll or pinch`],
  ['Zoom the 3D view', 'Scroll or pinch'],
  ['Brush size, with a brush tool', `${isMac ? '⌥' : 'Alt'}+Scroll`],
  ['Pan', 'Middle-drag'],
  ['Window / Level', 'Right-drag'],
  ['Brightness and contrast, with the Window / Level tool', 'Two-finger scroll'],
  ['Window from a box, with the Window / Level tool', `${MOD}-drag`],
  ['Erase with the brush', 'Shift-drag'],
  ['Select the segment under the cursor', `${isMac ? '⌥' : 'Alt'}-click`],
  ['Apply a fill preview', 'Enter'],
  ['Cancel a fill preview or an outline being drawn', 'Esc'],
  ['Maximise a view', 'Double-click'],
  ['Change the view in a pane', 'Click its name'],
  ['Swap two panes', 'Drag a name onto another pane'],
  ['Scroll another view', 'Drag its reference line'],
  ['Select segment 1–9', '1 – 9'],
];

const GROUPS = ['Tools', 'Segments', 'View and file'] as const;

/** Every shortcut, each one a button that takes a new key. Shown in Settings. */
export function ShortcutsList() {
  const bindings = useShortcuts((s) => s.bindings);
  const [editing, setEditing] = useState<ActionId | null>(null);
  const [note, setNote] = useState('');
  // The bindings from before the last change, when that change took a key from another action.
  const [undo, setUndo] = useState<Bindings | null>(null);

  useEffect(() => {
    set({ capturingShortcut: editing !== null });
    if (!editing) return;
    const cancel = () => {
      setEditing(null);
      setNote('');
    };
    const onKey = (e: KeyboardEvent) => {
      // Tab moves on as usual and drops the capture; it is never taken as the new key.
      if (e.key === 'Tab') return cancel();
      e.preventDefault();
      // Nothing else may act on this key: Esc here cancels the capture, not the dialog.
      e.stopImmediatePropagation();
      if (e.key === 'Escape') return cancel();
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (isReserved(combo)) {
        return setNote(`${formatCombo(combo, isMac)} is fixed and can't be reassigned. Press other keys, or Esc to cancel.`);
      }
      const before = useShortcuts.getState().bindings;
      const displaced = setShortcut(editing, combo);
      setNote(rebindNote(editing, combo, displaced, isMac));
      setUndo(displaced ? before : null);
      setEditing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      set({ capturingShortcut: false });
    };
  }, [editing]);

  const changed = ACTIONS.some((a) => bindings[a.id] !== a.key);
  return (
    <>
      <p className="sheet-help" role="status">
        {note || (editing ? `Press the new keys for ${labelOf(editing)}. Esc cancels.` : 'Click a shortcut, then press the keys you want.')}
        {undo && !editing && (
          <button
            className="btn text"
            onClick={() => {
              setShortcuts(undo);
              setUndo(null);
              setNote('');
            }}
          >
            Undo
          </button>
        )}
      </p>
      <div className="shortcuts">
        {GROUPS.map((group) => (
          <div key={group} style={{ display: 'contents' }}>
            <h4>{group}</h4>
            {ACTIONS.filter((a) => a.group === group).map((a) => (
              <div key={a.id}>
                <span>{a.label}</span>
                <button
                  className="keybtn"
                  data-editing={editing === a.id}
                  data-empty={!bindings[a.id] || undefined}
                  data-action={a.id}
                  aria-label={`Change shortcut for ${a.label}, now ${bindings[a.id] ? formatCombo(bindings[a.id], isMac) : 'none'}`}
                  onClick={() => {
                    setNote('');
                    setUndo(null);
                    setEditing(editing === a.id ? null : a.id);
                  }}
                >
                  {editing === a.id ? 'Press keys…' : formatCombo(bindings[a.id], isMac)}
                </button>
              </div>
            ))}
          </div>
        ))}
        <h4>Mouse and trackpad</h4>
        {MOUSE.map(([label, key]) => (
          <div key={label}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <div className="pane-actions">
        <button
          className="btn secondary"
          disabled={!changed}
          onClick={() => {
            resetShortcuts();
            setEditing(null);
            setUndo(null);
            setNote('Shortcuts are back to the defaults.');
            // Reset is disabled from here on, so focus would otherwise drop to the page.
            document.getElementById('settings-tab-shortcuts')?.focus();
          }}
        >
          Reset to defaults
        </button>
      </div>
    </>
  );
}
