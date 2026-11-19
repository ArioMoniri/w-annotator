import { useStore } from '../state/store';

export function StatusBar() {
  const hover = useStore((s) => s.hover);
  const voi = useStore((s) => s.voi);
  const zoom = useStore((s) => s.zoom);
  const dirty = useStore((s) => s.dirty);
  const room = useStore((s) => s.room);
  const segments = useStore((s) => s.segments);
  const dims = useStore((s) => s.image?.dims);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('-', '−');
  const segName = hover && hover.segment ? (segments.find((x) => x.index === hover.segment)?.name ?? `Segment ${hover.segment}`) : 'none';

  let sync = dirty ? 'Unsaved changes' : 'Saved';
  if (room) sync = room.status === 'online' ? (dirty ? 'Synced · not saved to file' : 'Synced') : room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  return (
    <footer className="status" role="status" aria-live="off">
      <span style={{ minWidth: 150 }}>
        <b>X</b> {hover ? hover.ijk[0] + 1 : '—'} <b>Y</b> {hover ? hover.ijk[1] + 1 : '—'} <b>Z</b> {hover ? hover.ijk[2] + 1 : '—'}
      </span>
      <span style={{ minWidth: 96 }}>
        <b>Value</b> {hover ? fmt(hover.value) : '—'}
      </span>
      <span style={{ minWidth: 120 }}>
        <b>Segment</b> {hover ? segName : '—'}
      </span>
      <span className="grow" />
      {dims && (
        <span>
          {dims[0]} × {dims[1]} × {dims[2]}
        </span>
      )}
      {voi && (
        <span>
          <b>W</b> {Math.round(voi.upper - voi.lower)} <b>L</b> {fmt(Math.round((voi.upper + voi.lower) / 2))}
        </span>
      )}
      {zoom != null && (
        <span style={{ minWidth: 70 }}>
          <b>Zoom</b> {Math.round(zoom * 100)}%
        </span>
      )}
      <span data-testid="sync">{sync}</span>
    </footer>
  );
}
