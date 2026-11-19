import { useEffect, useState } from 'react';
import { ACTIONS, comboFromEvent, formatCombo, isReserved, labelOf, resetShortcuts, setShortcut, useShortcuts, type ActionId } from '../state/shortcuts';
import { set } from '../state/store';
import { MOD, isMac } from './common';

const MOUSE: [string, string][] = [
  ['Change slice', 'Scroll'],
  ['Zoom', `${MOD}+Scroll`],
  ['Pan', 'Middle-drag'],
  ['Window / Level', 'Right-drag'],
  ['Erase with the brush', 'Shift-drag'],
  ['Maximise a view', 'Double-click'],
  ['Select segment 1–9', '1 – 9'],
];

const GROUPS = ['Tools', 'Segments', 'View and file'] as const;

/** Every shortcut, each one a button that takes a new key. Shown in Settings. */
export function ShortcutsList() {
  const bindings = useShortcuts((s) => s.bindings);
  const [editing, setEditing] = useState<ActionId | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    set({ capturingShortcut: editing !== null });
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setEditing(null);
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (isReserved(combo)) return setNote(`${formatCombo(combo, isMac)} is fixed and can't be reassigned.`);
      const displaced = setShortcut(editing, combo);
      setNote(displaced ? `${labelOf(displaced)} no longer has a shortcut.` : '');
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
        {editing ? `Press the new keys for ${labelOf(editing)}. Esc cancels.` : note || 'Click a shortcut, then press the keys you want.'}
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
                  data-action={a.id}
                  aria-label={`Change shortcut for ${a.label}, now ${formatCombo(bindings[a.id], isMac)}`}
                  onClick={() => {
                    setNote('');
                    setEditing(editing === a.id ? null : a.id);
                  }}
                >
                  {editing === a.id ? 'Press keys…' : formatCombo(bindings[a.id], isMac)}
                </button>
              </div>
            ))}
          </div>
        ))}
        <h4>Mouse and fixed keys</h4>
        {MOUSE.map(([label, key]) => (
          <div key={label}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <div className="pane-actions">
        <button className="btn secondary" disabled={!changed} onClick={() => (resetShortcuts(), setNote('Shortcuts are back to the defaults.'))}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}
