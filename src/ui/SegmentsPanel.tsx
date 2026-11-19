import { Ellipsis, Eye, EyeOff, Lock, LockOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SegmentInfo } from '../collab/protocol';
import { SEGMENT_COLORS, useStore } from '../state/store';
import { addSegment, clearSegment, deleteSegment, patchSegment, selectSegment, setOpacity, setOutlineOnly, showOnly } from '../session';
import { Slider, useDismiss } from './common';

/** When each row first appeared, so only a newly added one animates in. */
const created = new Map<number, number>();
let listReady = false;

function Row({ seg, active }: { seg: SegmentInfo; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenuState] = useState<'menu' | 'color' | null>(null);
  const [anchor, setAnchor] = useState<React.CSSProperties>({});
  const setMenu = (next: 'menu' | 'color' | null, from?: HTMLElement | null) => {
    const row = from?.closest('.segrow') as HTMLElement | null;
    if (next && row) {
      const r = row.getBoundingClientRect();
      const height = next === 'menu' ? 176 : 108;
      const up = r.bottom + height > window.innerHeight - 8;
      setAnchor({
        position: 'fixed',
        top: up ? undefined : r.bottom - 2,
        bottom: up ? window.innerHeight - r.top - 2 : undefined,
        ...(next === 'menu' ? { right: window.innerWidth - r.right + 4 } : { left: r.left + 4 }),
      });
    }
    setMenuState(next);
  };
  const close = useCallback(() => setMenuState(null), []);
  const ref = useDismiss<HTMLDivElement>(menu !== null, close);

  if (!created.has(seg.index)) created.set(seg.index, listReady ? Date.now() : 0);

  const commit = (value: string) => {
    const name = value.trim().slice(0, 40);
    if (name) patchSegment(seg.index, { name });
    setRenaming(false);
  };

  return (
    <div
      className={`segrow${Date.now() - (created.get(seg.index) ?? 0) < 600 ? ' new' : ''}`}
      role="option"
      aria-selected={active}
      data-hidden={!seg.visible}
      data-segment={seg.index}
      data-renaming={renaming}
      tabIndex={0}
      onClick={() => selectSegment(seg.index)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') selectSegment(seg.index);
        if (e.key === 'F2') setRenaming(true);
        if (e.key === 'Delete' || e.key === 'Backspace') deleteSegment(seg.index);
      }}
    >
      <button
        className="swatchbtn"
        aria-label={`Colour of ${seg.name}`}
        style={{ color: seg.color }}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(menu === 'color' ? null : 'color', e.currentTarget);
        }}
      >
        <span className="swatch" style={{ background: seg.color }} />
      </button>
      <span className="idx">{seg.index}</span>
      {renaming ? (
        <input
          className="rename"
          aria-label="Segment name"
          defaultValue={seg.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <span className="name" title={seg.name} onDoubleClick={() => setRenaming(true)}>
          {seg.name}
        </span>
      )}
      <button
        className="iconbtn sm act"
        data-on={!seg.visible}
        aria-label={seg.visible ? 'Hide' : 'Show'}
        aria-pressed={!seg.visible}
        data-tip={seg.visible ? 'Hide' : 'Show'}
        data-tip-side="top"
        onClick={(e) => {
          e.stopPropagation();
          patchSegment(seg.index, { visible: !seg.visible });
        }}
      >
        {seg.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button
        className="iconbtn sm act"
        data-on={seg.locked}
        aria-label={seg.locked ? 'Unlock' : 'Lock'}
        aria-pressed={seg.locked}
        data-tip={seg.locked ? 'Unlock' : 'Lock'}
        data-tip-side="top"
        onClick={(e) => {
          e.stopPropagation();
          patchSegment(seg.index, { locked: !seg.locked });
        }}
      >
        {seg.locked ? <Lock size={14} /> : <LockOpen size={14} />}
      </button>
      <button
        className="iconbtn sm act"
        data-on={menu === 'menu'}
        aria-label={`More for ${seg.name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(menu === 'menu' ? null : 'menu', e.currentTarget);
        }}
      >
        <Ellipsis size={14} />
      </button>
      {menu === 'menu' && (
        <div className="menu" role="menu" ref={ref} style={anchor} onClick={(e) => e.stopPropagation()}>
          <button className="item" role="menuitem" onClick={() => (setMenu(null), setRenaming(true))}>
            Rename <kbd>F2</kbd>
          </button>
          <button className="item" role="menuitem" onClick={(e) => setMenu('color', e.currentTarget.closest('.segrow') as HTMLElement)}>
            Change colour
          </button>
          <button className="item" role="menuitem" onClick={() => (setMenu(null), showOnly(seg.index))}>
            Show only this
          </button>
          <hr />
          <button className="item" role="menuitem" onClick={() => (setMenu(null), clearSegment(seg.index))}>
            Clear
          </button>
          <button className="item danger" role="menuitem" onClick={() => (setMenu(null), deleteSegment(seg.index))}>
            Delete
          </button>
        </div>
      )}
      {menu === 'color' && (
        <div className="menu palette" ref={ref} style={anchor} onClick={(e) => e.stopPropagation()}>
          {SEGMENT_COLORS.map((c) => (
            <button
              key={c}
              aria-label={c}
              aria-pressed={c === seg.color}
              style={{ background: c }}
              onClick={() => (patchSegment(seg.index, { color: c }), setMenu(null))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SegmentsPanel() {
  const segments = useStore((s) => s.segments);
  const active = useStore((s) => s.activeSegment);
  const opacity = useStore((s) => s.opacity);
  const outlineOnly = useStore((s) => s.outlineOnly);

  useEffect(() => {
    listReady = segments.length >= 0;
    const live = new Set(segments.map((x) => x.index));
    for (const key of created.keys()) if (!live.has(key)) created.delete(key);
  }, [segments]);

  return (
    <aside className="panel" aria-label="Segments">
      <header>
        <span>Segments</span>
        <button className="iconbtn" aria-label="Add segment" data-tip="Add segment  N" data-tip-side="left" onClick={addSegment}>
          <Plus size={16} />
        </button>
      </header>
      <div className="seglist" role="listbox" aria-label="Segments">
        {segments.length === 0 ? (
          <div className="empty-note">
            <span>No segments yet.</span>
            <button className="btn secondary" onClick={addSegment}>
              Add segment
            </button>
          </div>
        ) : (
          segments.map((seg) => <Row key={seg.index} seg={seg} active={seg.index === active} />)
        )}
      </div>
      <footer>
        <div className="row">
          <span className="label">Opacity</span>
          <Slider label="Mask opacity" min={0} max={100} value={Math.round(opacity * 100)} onChange={(v) => setOpacity(v / 100)} />
          <span className="num" style={{ width: 36, textAlign: 'right', color: 'var(--text-2)', fontSize: 12 }}>
            {Math.round(opacity * 100)}%
          </span>
        </div>
        <label className="check">
          <input type="checkbox" checked={outlineOnly} onChange={(e) => setOutlineOnly(e.target.checked)} />
          Outline only
        </label>
      </footer>
    </aside>
  );
}
