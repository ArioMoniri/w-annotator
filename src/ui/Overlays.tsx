import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, set, useStore } from '../state/store';
import { MOD, Modal } from './common';

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

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Tools',
    [
      ['Crosshair', 'C'],
      ['Pan', 'H'],
      ['Zoom', 'Z'],
      ['Window / Level', 'W'],
      ['Ruler', 'R'],
      ['Brush', 'B'],
      ['Eraser', 'E'],
      ['Threshold brush', 'T'],
      ['Scissors', 'S'],
      ['Fill', 'F'],
      ['Brush size', '[  ]'],
      ['Fill between slices', 'I'],
      ['Last tool', 'Space'],
    ],
  ],
  [
    'Mouse, with any tool',
    [
      ['Change slice', 'Scroll'],
      ['Zoom', 'Ctrl+Scroll'],
      ['Pan', 'Middle-drag'],
      ['Window / Level', 'Right-drag'],
      ['Maximise a view', 'Double-click'],
    ],
  ],
  [
    'Segments',
    [
      ['Select segment 1–9', '1 – 9'],
      ['New segment', 'N'],
      ['Outline only', 'O'],
      ['Hide or show the mask', 'X'],
    ],
  ],
  [
    'View and file',
    [
      ['Next / previous slice', '↑ ↓'],
      ['Maximise or restore', 'M'],
      ['Show or hide segments', `${MOD}+\\`],
      ['Undo', `${MOD}+Z`],
      ['Redo', `${MOD}+Shift+Z`],
      ['Open image', `${MOD}+O`],
      ['Open mask', `${MOD}+Shift+O`],
      ['Save mask', `${MOD}+S`],
    ],
  ],
];

export function ShortcutsSheet() {
  const open = useStore((s) => s.shortcutsOpen);
  if (!open) return null;
  const close = () => set({ shortcutsOpen: false });
  return (
    <Modal title="Keyboard shortcuts" onClose={close} wide>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
      <h2>Keyboard shortcuts</h2>
      <div className="shortcuts">
        {SHORTCUTS.map(([group, rows]) => (
          <div key={group} style={{ display: 'contents' }}>
            <h3>{group}</h3>
            {rows.map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
