import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, set, useStore } from '../state/store';
import { useEffect, useState } from 'react';
import { ACTIONS, comboFromEvent, formatCombo, isReserved, labelOf, resetShortcuts, setShortcut, useShortcuts, type ActionId } from '../state/shortcuts';
import { MOD, Modal, isMac } from './common';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'success' ? (
            <CircleCheck size={16} />
          ) : t.kind === 'warning' ? (
            <TriangleAlert size={16} />
          ) : t.kind === 'error' ? (
            <CircleAlert size={16} />
          ) : (
            <Info size={16} />
          )}
          <span className="msg">{t.text}</span>
          {t.action && (
            <button
              className="action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="iconbtn sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  if (!confirm) return null;
  const close = () => set({ confirm: null });
  return (
    <Modal title={confirm.title} onClose={close}>
      <h2>{confirm.title}</h2>
      <p>{confirm.body}</p>
      <div className="footer">
        {confirm.other && (
          <button
            className="btn text lg"
            onClick={() => {
              close();
              confirm.other!.run();
            }}
          >
            {confirm.other.label}
          </button>
        )}
        <button className="btn secondary lg" onClick={close}>
          Cancel
        </button>
        <button
          className={`btn lg ${confirm.danger ? 'danger' : 'primary'}`}
          onClick={() => {
            close();
            confirm.run();
          }}
        >
          {confirm.confirm}
        </button>
      </div>
    </Modal>
  );
}

export function UpdateBanner() {
  const update = useStore((s) => s.update);
  const dismissed = useStore((s) => s.updateDismissed);
  if (!update || dismissed) return null;
  return (
    <div className="update" role="status">
      <strong>Version {update.version} is ready.</strong>
      <p>Restart to update. Save your mask first.</p>
      <div className="row">
        <button className="btn primary" onClick={() => void update.install()}>
          Restart
        </button>
        <button className="btn secondary" onClick={() => set({ updateDismissed: true })}>
          Later
        </button>
      </div>
    </div>
  );
}

export function Busy() {
  const busy = useStore((s) => s.busy);
  const progress = useStore((s) => s.progress);
  if (!busy) return null;
  return (
    <div className="busy" role="status">
      <span>
        {busy}
        {progress != null ? ` ${Math.round(progress * 100)}%` : ''}
      </span>
      {progress != null && (
        <div className="bar">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

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

export function ShortcutsSheet() {
  const open = useStore((s) => s.shortcutsOpen);
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
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing]);

  if (!open) return null;
  const close = () => {
    setEditing(null);
    setNote('');
    set({ shortcutsOpen: false, capturingShortcut: false });
  };
  const changed = ACTIONS.some((a) => bindings[a.id] !== a.key);
  return (
    <Modal title="Keyboard shortcuts" onClose={editing ? () => setEditing(null) : close} wide>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
      <h2>Keyboard shortcuts</h2>
      <p className="sheet-help" role="status">
        {editing ? `Press the new keys for ${labelOf(editing)}. Esc cancels.` : note || 'Click a shortcut, then press the keys you want.'}
      </p>
      <div className="shortcuts">
        {GROUPS.map((group) => (
          <div key={group} style={{ display: 'contents' }}>
            <h3>{group}</h3>
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
        <h3>Mouse and fixed keys</h3>
        {MOUSE.map(([label, key]) => (
          <div key={label}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <div className="footer">
        <button className="btn secondary lg" disabled={!changed} onClick={() => (resetShortcuts(), setNote('Shortcuts are back to the defaults.'))}>
          Reset to defaults
        </button>
        <button className="btn primary lg" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}
