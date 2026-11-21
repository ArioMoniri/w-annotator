import { useLayoutEffect, useRef } from 'react';
import { statusText } from '../mask/recovery';
import { useRecovery } from '../recovery';
import { useStore } from '../state/store';
import { useSettings } from '../state/settings';
import { itemsToDrop } from './place';
import { WindowReadout, ZoomReadout } from './ViewMenus';

export function StatusBar() {
  const hover = useStore((s) => s.hover);
  const voi = useStore((s) => s.voi);
  const zoom = useStore((s) => s.zoom);
  const dirty = useStore((s) => s.dirty);
  const room = useStore((s) => s.room);
  const segments = useStore((s) => s.segments);
  const dims = useStore((s) => s.image?.dims);
  const ct = useStore((s) => !!s.image?.ct);
  const maskHidden = useStore((s) => s.maskHidden);
  const windowSet = useStore((s) => s.windowSet);
  const presets = useSettings((s) => s.windowPresets.length);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('-', '−');
  const segName = hover && hover.segment ? (segments.find((x) => x.index === hover.segment)?.name ?? `Segment ${hover.segment}`) : 'none';

  // A recovery copy is not a saved file, so it is named next to "Unsaved changes", never instead of it.
  const copyAt = useRecovery((s) => s.savedAt);

  let sync = dirty ? 'Unsaved changes' : 'Saved';
  if (room) sync = room.status === 'online' ? (dirty ? 'Synced · not saved to file' : 'Synced') : room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  // When the bar is too narrow, whole items leave in order (the preset name, size, zoom, then
  // the values under the cursor) so the save state at the end is never cut mid-word. The
  // window stays: it is the way in to the presets.
  const bar = useRef<HTMLElement>(null);
  // Everything that changes how wide the items are.
  const layoutKey = [sync, copyAt, maskHidden, segName, ct, dims?.join('x'), voi && `${voi.lower}:${voi.upper}`, windowSet, presets, zoom != null].join('|');
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const fit = () => {
      el.dataset.drop = '0';
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-drop-order]')).sort(
        (a, b) => Number(a.dataset.dropOrder) - Number(b.dataset.dropOrder),
      );
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const widths = items.map((item) => item.offsetWidth + gap);
      const fixed = el.scrollWidth - widths.reduce((a, b) => a + b, 0);
      let drop = itemsToDrop(widths, fixed, el.clientWidth);
      el.dataset.drop = String(drop);
      // An item inside another one is narrower than it was counted, so check the result too.
      while (drop < items.length && el.scrollWidth > el.clientWidth) el.dataset.drop = String(++drop);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layoutKey]);

  return (
    <footer className="status" role="status" aria-live="off" ref={bar}>
      <span style={{ minWidth: 150 }} data-drop-order="6">
        <b>X</b> {hover ? hover.ijk[0] + 1 : '—'} <b>Y</b> {hover ? hover.ijk[1] + 1 : '—'} <b>Z</b> {hover ? hover.ijk[2] + 1 : '—'}
      </span>
      <span style={{ minWidth: ct ? 116 : 96 }} data-testid="value" data-drop-order="5">
        <b>Value</b> {hover ? fmt(hover.value) : '—'}
        {hover && ct ? ' HU' : ''}
      </span>
      <span style={{ minWidth: 120 }} data-drop-order="4">
        <b>Segment</b> {hover ? segName : '—'}
      </span>
      <span className="grow" />
      {maskHidden && (
        <span className="warn" data-testid="mask-hidden">
          Mask hidden
        </span>
      )}
      {dims && (
        <span data-drop-order="2" data-testid="status-size">
          <b>Size</b> {dims[0]} × {dims[1]} × {dims[2]}
        </span>
      )}
      <WindowReadout />
      <ZoomReadout />
      <span className="syncgroup">
        {/* Keyed by its text so each change fades in. */}
        <span className="sync" data-testid="sync" data-unsaved={dirty || undefined} key={sync}>
          {sync}
        </span>
        {dirty && copyAt != null && (
          <span className="recovery-note" data-testid="recovery-note">
            {' · '}
            {statusText(copyAt)}
          </span>
        )}
      </span>
    </footer>
  );
}
