import { placeMenu } from './place';
import { Ellipsis, Eye, EyeOff, Lock, LockOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SegmentInfo } from '../collab/protocol';
import { SEGMENT_COLORS, SEGMENT_COLOR_NAMES, useStore } from '../state/store';
import { formatVolume } from '../mask/ops';
import {
  addSegment,
  addSegmentInto,
  clearSegment,
  deleteSegment,
  goToSegment,
  openMeasurements,
  patchSegment,
  refineSegment,
  selectSegment,
  setOpacity,
  setOutlineOnly,
  showOnly,
  splitSegment,
  type RefineOp,
} from '../session';
import { Slider, useDismiss, useKeyHint } from './common';
import { FilesSection } from './FilesSection';

/** Operations that ask for one number first. */
const AMOUNTS = {
  grow: { item: 'Grow…', lead: 'Grow by', unit: 'mm', min: 0.1, max: 50, start: 2 },
  shrink: { item: 'Shrink…', lead: 'Shrink by', unit: 'mm', min: 0.1, max: 50, start: 2 },
  smooth: { item: 'Smooth…', lead: 'Smooth by', unit: 'mm', min: 0.1, max: 50, start: 2 },
  removeSmall: { item: 'Remove small islands…', lead: 'Remove islands under', unit: 'mm³', min: 1, max: 1_000_000, start: 10 },
} as const;
type AmountOp = keyof typeof AMOUNTS;

const AMOUNT_KEY = 'w.refine';

/** The last value used for each operation, kept between sessions. */
const lastAmount: Record<AmountOp, number> = (() => {
  const values: Record<AmountOp, number> = { grow: AMOUNTS.grow.start, shrink: AMOUNTS.shrink.start, smooth: AMOUNTS.smooth.start, removeSmall: AMOUNTS.removeSmall.start };
  try {
    const saved = JSON.parse(localStorage.getItem(AMOUNT_KEY) ?? '{}') as Record<string, unknown>;
    for (const op of Object.keys(values) as AmountOp[]) {
      const v = saved[op];
      if (typeof v === 'number' && v >= AMOUNTS[op].min && v <= AMOUNTS[op].max) values[op] = v;
    }
  } catch {
    /* nothing saved, or storage is unavailable */
  }
  return values;
})();

function rememberAmount(op: AmountOp, value: number): void {
  lastAmount[op] = value;
  try {
    localStorage.setItem(AMOUNT_KEY, JSON.stringify(lastAmount));
  } catch {
    /* storage is unavailable; the value still lasts for this session */
  }
}

function AmountForm({ op, seg, onClose }: { op: AmountOp; seg: SegmentInfo; onClose: () => void }) {
  const spec = AMOUNTS[op];
  const [text, setText] = useState(String(lastAmount[op]));
  const value = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(value) && value >= spec.min && value <= spec.max;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        rememberAmount(op, value);
        onClose();
        void refineSegment(seg.index, op, value);
      }}
    >
      <div className="title">{seg.name}</div>
      <label className="field">
        <span className="label">{spec.lead}</span>
        <input
          className="numfield"
          inputMode="decimal"
          autoFocus
          aria-invalid={!valid}
          value={text}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="unit">{spec.unit}</span>
      </label>
      <div className="actions">
        <button type="button" className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!valid}>
          Apply
        </button>
      </div>
    </form>
  );
}

function CombineForm({ seg, onClose }: { seg: SegmentInfo; onClose: () => void }) {
  const others = useStore((s) => s.segments).filter((x) => x.index !== seg.index);
  const [other, setOther] = useState(others[0]?.index ?? 0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
        void addSegmentInto(seg.index, other);
      }}
    >
      <div className="title">{seg.name}</div>
      <label className="field">
        <span className="label">Add</span>
        <select className="select" autoFocus value={other} onChange={(e) => setOther(Number(e.target.value))}>
          {others.map((x) => (
            <option key={x.index} value={x.index}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <p className="note">Its voxels become part of {seg.name}.</p>
      <div className="actions">
        <button type="button" className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Add
        </button>
      </div>
    </form>
  );
}

type MenuKind = 'menu' | 'color' | 'combine' | AmountOp;

function Row({ seg, active, isNew, picked }: { seg: SegmentInfo; active: boolean; isNew: boolean; picked: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenuState] = useState<MenuKind | null>(null);
  const [anchor, setAnchor] = useState<React.CSSProperties>({});
  const volume = useStore((s) => s.stats[seg.index]?.volumeMl ?? 0);
  const canCombine = useStore((s) => s.segments.length > 1);
  const rowRef = useRef<HTMLDivElement>(null);
  // The button that opened the menu or the palette, so Esc can hand focus back to it.
  const opener = useRef<'more' | 'swatch'>('more');
  const setMenu = (next: MenuKind | null, from?: HTMLElement | null) => {
    const row = from?.closest('.segrow') as HTMLElement | null;
    if (next && from) opener.current = from.classList.contains('swatchbtn') ? 'swatch' : 'more';
    if (next && row) {
      const r = row.getBoundingClientRect();
      // As wide as the row, so no piece of a neighbouring row shows beside it.
      setAnchor({ position: 'fixed', top: r.bottom - 2, left: r.left, width: r.width });
    }
    setMenuState(next);
  };
  const close = useCallback(() => setMenuState(null), []);
  // Grow, Combine and the like are small dialogs: Tab is handled as in every other dialog.
  const asks = menu !== null && menu !== 'menu' && menu !== 'color';
  const ref = useDismiss<HTMLDivElement>(
    menu !== null,
    close,
    () => rowRef.current?.querySelector<HTMLElement>(opener.current === 'swatch' ? '.swatchbtn' : '[aria-haspopup]') ?? null,
    asks,
  );
  // Keep every item in reach: between the top bar and the status bar, scrolling inside if it must.
  useLayoutEffect(() => {
    const el = ref.current;
    const row = rowRef.current;
    if (!menu || !el || !row) return;
    const fit = () => {
      const lo = (row.closest('.panel')?.getBoundingClientRect().top ?? 0) + 4;
      const hi = (document.querySelector('.status')?.getBoundingClientRect().top ?? window.innerHeight) - 4;
      el.style.maxHeight = '';
      const next = placeMenu(row.getBoundingClientRect().bottom - 2, el.offsetHeight, lo, hi);
      el.style.maxHeight = `${next.maxHeight}px`;
      setAnchor((a) => (a.top === next.top && a.maxHeight === next.maxHeight ? a : { ...a, ...next }));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [menu, ref]);
  const run = (op: RefineOp) => {
    setMenu(null);
    void refineSegment(seg.index, op);
  };
  // A segment picked from the image may be far down the list: bring its row into view.
  useEffect(() => {
    if (picked) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [picked]);

  const commit = (value: string) => {
    const name = value.trim().slice(0, 40);
    if (name) patchSegment(seg.index, { name });
    setRenaming(false);
  };

  return (
    <div
      className={`segrow${isNew ? ' new' : ''}${picked ? ' picked' : ''}`}
      ref={rowRef}
      role="option"
      aria-selected={active}
      data-hidden={!seg.visible}
      data-segment={seg.index}
      data-renaming={renaming}
      tabIndex={0}
      onClick={() => selectSegment(seg.index)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!renaming) setMenu('menu', rowRef.current?.querySelector<HTMLElement>('[aria-haspopup]'));
      }}
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
      {volume > 0 && !renaming && (
        <span className="vol" data-testid="segment-volume">
          {formatVolume(volume)}
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
          <button className="item" role="menuitem" onClick={() => (setMenu(null), goToSegment(seg.index))}>
            Go to segment
          </button>
          <hr />
          <div className="title" id={`refine-${seg.index}`}>
            Refine
          </div>
          <div role="group" aria-labelledby={`refine-${seg.index}`}>
            <button className="item" role="menuitem" onClick={(e) => setMenu('grow', e.currentTarget.closest('.segrow') as HTMLElement)}>
              {AMOUNTS.grow.item}
            </button>
            <button className="item" role="menuitem" onClick={(e) => setMenu('shrink', e.currentTarget.closest('.segrow') as HTMLElement)}>
              {AMOUNTS.shrink.item}
            </button>
            <button className="item" role="menuitem" onClick={(e) => setMenu('smooth', e.currentTarget.closest('.segrow') as HTMLElement)}>
              {AMOUNTS.smooth.item}
            </button>
            <button className="item" role="menuitem" onClick={() => run('fillHoles')}>
              Fill holes
            </button>
            <button className="item" role="menuitem" onClick={() => run('keepLargest')}>
              Keep largest island
            </button>
            <button className="item" role="menuitem" onClick={(e) => setMenu('removeSmall', e.currentTarget.closest('.segrow') as HTMLElement)}>
              {AMOUNTS.removeSmall.item}
            </button>
            <button className="item" role="menuitem" onClick={() => (setMenu(null), splitSegment(seg.index))}>
              Split into separate segments
            </button>
          </div>
          <hr />
          <button
            className="item"
            role="menuitem"
            disabled={!canCombine}
            onClick={(e) => setMenu('combine', e.currentTarget.closest('.segrow') as HTMLElement)}
          >
            Combine…
          </button>
          <button className="item" role="menuitem" onClick={() => (setMenu(null), openMeasurements())}>
            Measurements
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
      {asks && (
        <div
          className="menu ask"
          role="dialog"
          aria-label={menu === 'combine' ? `Combine with ${seg.name}` : `${AMOUNTS[menu].item.replace('…', '')} ${seg.name}`}
          ref={ref}
          style={anchor}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {menu === 'combine' ? <CombineForm seg={seg} onClose={close} /> : <AmountForm op={menu} seg={seg} onClose={close} />}
        </div>
      )}
      {menu === 'color' && (
        <div className="menu palette" ref={ref} style={anchor} onClick={(e) => e.stopPropagation()}>
          {SEGMENT_COLORS.map((c, i) => (
            <button
              key={c}
              aria-label={SEGMENT_COLOR_NAMES[i]}
              title={SEGMENT_COLOR_NAMES[i]}
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
  const key = useKeyHint();

  const newSegment = useStore((s) => s.newSegment);
  const pickedSegment = useStore((s) => s.pickedSegment);

  return (
    <aside className="panel" aria-label="Segments" data-tour="segments">
      <FilesSection />
      <header>
        <span>Segments</span>
        <button className="iconbtn" aria-label="Add segment" data-tip={`Add segment  ${key('segment.new')}`.trimEnd()} data-tip-side="left" onClick={addSegment}>
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
          segments.map((seg) => <Row key={seg.index} seg={seg} active={seg.index === active} isNew={seg.index === newSegment} picked={seg.index === pickedSegment} />)
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
