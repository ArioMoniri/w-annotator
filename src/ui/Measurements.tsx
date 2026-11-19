import { X } from 'lucide-react';
import { formatValue, formatVolume } from '../mask/ops';
import { copyMeasurements } from '../session';
import { set, useStore } from '../state/store';
import { Modal } from './common';

/** Volume and image values per segment. The image's unit is not known, so values carry none. */
export function MeasurementsSheet() {
  const open = useStore((s) => s.measurementsOpen);
  const segments = useStore((s) => s.segments);
  const stats = useStore((s) => s.stats);
  if (!open) return null;
  const close = () => set({ measurementsOpen: false });
  return (
    <Modal title="Measurements" onClose={close} wide>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
      <h2>Measurements</h2>
      {segments.length === 0 ? (
        <p>No segments yet.</p>
      ) : (
        <table className="measures">
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col">Volume</th>
              <th scope="col">Voxels</th>
              <th scope="col">Mean ± SD</th>
              <th scope="col">Min</th>
              <th scope="col">Max</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => {
              const s = stats[seg.index];
              const measured = !!s && Number.isFinite(s.mean);
              return (
                <tr key={seg.index}>
                  <th scope="row">
                    <span className="swatch" style={{ background: seg.color }} />
                    <span className="name" title={seg.name}>
                      {seg.name}
                    </span>
                  </th>
                  <td>{s ? formatVolume(s.volumeMl) : '—'}</td>
                  <td>{s ? s.voxels.toLocaleString('en-US') : '0'}</td>
                  <td>{measured ? `${formatValue(s.mean, 1)} ± ${formatValue(s.sd, 1)}` : '—'}</td>
                  <td>{measured ? formatValue(s.min) : '—'}</td>
                  <td>{measured ? formatValue(s.max) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="measures-note">Mean, SD, min and max are the image values inside each segment.</p>
      <div className="footer">
        <button className="btn secondary lg" disabled={segments.length === 0} onClick={() => void copyMeasurements()}>
          Copy as CSV
        </button>
        <button className="btn primary lg" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}
