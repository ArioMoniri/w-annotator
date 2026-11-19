import { Layers } from 'lucide-react';
import { set } from '../state/store';
import { pickDicomFolder, pickImage } from './files';
import { ThemeControl } from './ThemeControl';

export function EmptyState({ dragging }: { dragging: boolean }) {
  return (
    <main className="empty" data-dragging={dragging}>
      <div className="dropzone">
        <Layers className="icon" size={32} strokeWidth={1.5} />
        <h1>{dragging ? 'Drop to open' : 'Drop an image and a mask'}</h1>
        <p>MHA, NIfTI, NRRD or a DICOM folder.</p>
        <p>The mask is optional.</p>
        <div className="actions">
          <button className="btn primary lg" onClick={pickImage}>
            Open image
          </button>
          <button className="btn secondary lg" onClick={pickDicomFolder}>
            Open DICOM folder
          </button>
        </div>
      </div>
      <button className="btn text" onClick={() => set({ roomModal: 'join' })}>
        Join a room
      </button>
      <div className="corner">
        <ThemeControl compact />
      </div>
      <button className="btn text report-link" onClick={() => set({ report: 'bug' })}>
        Report a problem
      </button>
    </main>
  );
}
