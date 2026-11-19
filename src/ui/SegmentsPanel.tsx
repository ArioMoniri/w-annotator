import { Ellipsis, Eye, EyeOff, Lock, LockOpen, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { SegmentInfo } from '../collab/protocol';
import { SEGMENT_COLORS, useStore } from '../state/store';
import { addSegment, clearSegment, deleteSegment, patchSegment, selectSegment, setOpacity, setOutlineOnly, showOnly } from '../session';
import { Slider, useDismiss } from './common';

function Row({ seg, active }: { seg: SegmentInfo; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<'menu' | 'color' | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const ref = useDismiss<HTMLDivElement>(menu !== null, close);

  const commit = (value: string) => {
    const name = value.trim().slice(0, 40);
    if (name) patchSegment(seg.index, { name });
    setRenaming(false);
  };

  return (
    <div
      className="segrow"
      role="option"
      aria-selected={active}
      data-hidden={!seg.visible}
      data-segment={seg.index}
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
          setMenu(menu === 'color' ? null : 'color');
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
        <span className="name" onDoubleClick={() => setRenaming(true)}>
          {seg.name}
        </span>
      )}
      <button
        className="iconbtn sm act"
        data-on={!seg.visible}
        aria-label={seg.visible ? 'Hide' : 'Show'}
        aria-pressed={!seg.visible}
        data-tip={seg.visible ? 'Hide' : 'Show'}
        data-tip-side="left"
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
        data-tip-side="left"
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
          setMenu(menu === 'menu' ? null : 'menu');
        }}
      >
        <Ellipsis size={14} />
      </button>
      {menu === 'menu' && (
        <div className="menu" role="menu" ref={ref} style={{ right: 4, top: 30 }} onClick={(e) => e.stopPropagation()}>
          <button className="item" role="menuitem" onClick={() => (setMenu(null), setRenaming(true))}>
            Rename <kbd>F2</kbd>
          </button>
          <button className="item" role="menuitem" onClick={() => setMenu('color')}>
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
        <div className="menu palette" ref={ref} style={{ left: 4, top: 30 }} onClick={(e) => e.stopPropagation()}>
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
