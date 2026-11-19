import { foundText, waitingText } from '../mask/recovery';
import { discard, openWaitingImage, restore, useRecovery } from '../recovery';
import { useStore } from '../state/store';

/** Shown above the viewports when unsaved edits from an earlier session were found for this image. */
export function RecoveryBar() {
  const offer = useRecovery((s) => s.offer);
  const dirty = useStore((s) => s.dirty);
  if (!offer) return null;
  return (
    <div className="recoverybar" role="region" aria-label="Recovered edits" data-testid="recovery-bar">
      <span className="text">
        {foundText(offer.savedAt)}
        {dirty && ' New edits are not backed up until you choose.'}
      </span>
      <button className="btn primary" onClick={() => void restore()}>
        Restore
      </button>
      <button className="btn secondary" onClick={discard}>
        Discard
      </button>
    </div>
  );
}

/** One quiet line on the empty state when recovery copies are waiting. */
export function RecoveryWaiting() {
  const waiting = useRecovery((s) => s.waiting);
  if (waiting.length === 0) return null;
  return (
    <p className="recovery-waiting" data-testid="recovery-waiting">
      {waitingText(waiting.length)}
      {waiting
        .filter((copy) => copy.imageName)
        .map((copy) => (
          <button key={copy.key} className="btn text" onClick={() => void openWaitingImage(copy)}>
            Open {copy.imageName}
          </button>
        ))}
    </p>
  );
}
