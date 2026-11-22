import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, holdToast, set, useStore } from '../state/store';
import { Modal } from './common';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          data-kind={t.kind}
          data-leaving={t.leaving || undefined}
          role={t.kind === 'error' ? 'alert' : 'status'}
          // The timer waits while the toast is pointed at or holds focus, so an action cannot vanish under the pointer.
          onPointerEnter={() => holdToast(t.id, 'hover', true)}
          onPointerLeave={() => holdToast(t.id, 'hover', false)}
          onFocus={() => holdToast(t.id, 'focus', true)}
          onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || holdToast(t.id, 'focus', false)}
        >
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
