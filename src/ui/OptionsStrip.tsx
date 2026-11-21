import { useLayoutEffect, useRef, useState } from 'react';
import { activeSegmentInfo, useStore } from '../state/store';
import { applyFillPreview, cancelFillPreview, fillBetweenSlices, setBrushSize, setPaintOver, setToolOption, setVoi } from '../session';
import { paintOverLabel } from '../mask/paintOver';
import { clearMeasurements, fitAll } from '../viewer/engine';
import { getImage } from '../session';
import { autoWindow } from '../io';
import { BRUSH_MAX } from '../mask/brush';
import { Choice, NumberField, Slider, useKeyHint } from './common';
import { TOOLS } from './ToolRail';

const CT_PRESETS: { name: string; w: number; l: number }[] = [
  { name: 'Soft tissue', w: 400, l: 40 },
  { name: 'Lung', w: 1500, l: -600 },
  { name: 'Bone', w: 1800, l: 400 },
  { name: 'Brain', w: 80, l: 40 },
  { name: 'Abdomen', w: 350, l: 50 },
  { name: 'Liver', w: 150, l: 30 },
  { name: 'Stroke', w: 40, l: 40 },
  { name: 'Subdural', w: 200, l: 75 },
];

const SHAPES = [
  { value: 'circle' as const, label: 'Circle' },
  { value: 'sphere' as const, label: 'Sphere' },
];

function SizeField() {
  const size = useStore((s) => s.brushSize);
  const min = useStore((s) => s.brushMin);
  const key = useKeyHint();
  return (
    <div className="field" data-tip={`Brush diameter  ${key('brush.smaller')}  ${key('brush.larger')}`.trimEnd()} data-tip-side="bottom">
      <span className="label">Size</span>
      <Slider label="Brush size" min={min} max={BRUSH_MAX} step={0.1} value={size} onChange={setBrushSize} />
      <NumberField label="Brush size in millimetres" value={size} min={min} max={BRUSH_MAX} onCommit={setBrushSize} />
      <span className="unit">mm</span>
    </div>
  );
}

function ShapeField() {
  const shape = useStore((s) => s.brushShape);
  return (
    <div className="field">
      <span className="label">Shape</span>
      <Choice label="Brush shape" value={shape} options={SHAPES} onChange={(brushShape) => setToolOption({ brushShape })} />
    </div>
  );
}

const PAINT_OVER_TIP = 'Empty only keeps other segments as they are.';
const PAINT_INSIDE_TIP = 'Paint only inside one segment';

/**
 * What painting may write over. In the brush strip it is two buttons and a list of
 * segments; where the strip is fuller it is one list with the same choices.
 */
function PaintOverField({ list = false }: { list?: boolean }) {
  const paintOver = useStore((s) => s.paintOver);
  const segments = useStore((s) => s.segments);
  const active = useStore((s) => s.activeSegment);
  const others = segments.filter((x) => x.index !== active);
  const inside = typeof paintOver === 'number';
  const choose = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setPaintOver(v === 'all' || v === 'empty' ? v : Number(v));
    // Give the keyboard back to the tool shortcuts.
    e.target.blur();
  };
  const only = others.map((x) => (
    <option key={x.index} value={x.index}>
      Only {x.name}
    </option>
  ));
  if (list) {
    return (
      <div className="field" data-tip={`${PAINT_OVER_TIP} Only paints inside one segment.`} data-tip-side="bottom" data-tip-align="end">
        <label htmlFor="paint-over">Paint over</label>
        <select id="paint-over" className="select paintover" aria-label="Paint over" value={String(paintOver)} onChange={choose}>
          <option value="all">Everything</option>
          <option value="empty">Empty only</option>
          {only}
        </select>
      </div>
    );
  }
  return (
    <div className="field" data-tip={PAINT_OVER_TIP} data-tip-side="bottom">
      <span className="label">Paint over</span>
      <div className="seg-control" role="group" aria-label="Paint over">
        <button aria-pressed={paintOver === 'all'} onClick={() => setPaintOver('all')}>
          Everything
        </button>
        <button aria-pressed={paintOver === 'empty'} onClick={() => setPaintOver('empty')}>
          Empty only
        </button>
        {others.length > 0 && (
          <select className="inside" aria-label="Paint only inside a segment" title={PAINT_INSIDE_TIP} data-on={inside} value={inside ? String(paintOver) : ''} onChange={choose}>
            <option value="" disabled>
              Only…
            </option>
            {only}
          </select>
        )}
      </div>
    </div>
  );
}

function ThresholdField() {
  const [lo, hi] = useStore((s) => s.threshold);
  const range = useStore((s) => s.image?.range) ?? [0, 1];
  const span = range[1] - range[0] || 1;
  const step = span > 200 ? 1 : span / 200;
  const set = (a: number, b: number) => setToolOption({ threshold: [Math.min(a, b), Math.max(a, b)] });
  return (
    <div className="field" data-tip="Paints only where the image value is inside the range." data-tip-side="bottom">
      <span className="label">Range</span>
      <NumberField label="Lower threshold" wide value={lo} onCommit={(v) => set(v, hi)} />
      <div
        className="dual"
        style={{ ['--lo' as string]: `${((lo - range[0]) / span) * 100}%`, ['--hi' as string]: `${((hi - range[0]) / span) * 100}%` }}
      >
        <div className="track" />
        <input type="range" aria-label="Lower threshold" min={range[0]} max={range[1]} step={step} value={lo} onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)} />
        <input type="range" aria-label="Upper threshold" min={range[0]} max={range[1]} step={step} value={hi} onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))} />
      </div>
      <NumberField label="Upper threshold" wide value={hi} onCommit={(v) => set(lo, v)} />
    </div>
  );
}

function WindowFields() {
  const voi = useStore((s) => s.voi);
  const looksLikeCt = useStore((s) => !!s.image?.ct);
  if (!voi) return null;
  const w = Math.round(voi.upper - voi.lower);
  const l = Math.round((voi.upper + voi.lower) / 2);
  const apply = (nw: number, nl: number) => setVoi(nl - Math.max(1, nw) / 2, nl + Math.max(1, nw) / 2);
  const current = CT_PRESETS.find((p) => p.w === w && p.l === l)?.name ?? '';
  return (
    <>
      {looksLikeCt && (
        <div className="field">
          <label htmlFor="wl-preset">Preset</label>
          <select
            id="wl-preset"
            className="select"
            value={current}
            onChange={(e) => {
              const p = CT_PRESETS.find((x) => x.name === e.target.value);
              if (p) apply(p.w, p.l);
              // Give the keyboard back to the tool shortcuts.
              e.target.blur();
            }}
          >
            <option value="" disabled>
              Custom
            </option>
            {CT_PRESETS.map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <span className="label">W</span>
        <NumberField label="Window width" wide value={w} min={1} onCommit={(v) => apply(v, l)} />
        <span className="label">L</span>
        <NumberField label="Window level" wide value={l} onCommit={(v) => apply(w, v)} />
      </div>
      <button
        className="btn secondary"
        onClick={() => {
          const img = getImage();
          if (!img) return;
          const auto = autoWindow(img);
          setVoi(auto.lower, auto.upper);
        }}
      >
        Reset
      </button>
    </>
  );
}

export function OptionsStrip() {
  const tool = useStore((s) => s.tool);
  const scissorsShape = useStore((s) => s.scissorsShape);
  const scissorsAction = useStore((s) => s.scissorsAction);
  const scissorsDepth = useStore((s) => s.scissorsDepth);
  const fillAction = useStore((s) => s.fillAction);
  const paintOver = useStore((s) => s.paintOver);
  const preview = useStore((s) => s.preview);
  const previewing = !!preview;
  const active = useStore(activeSegmentInfo);
  // The chip names the limit only for tools that add to a segment.
  const adds = tool === 'brush' || tool === 'threshold' || (tool === 'scissors' && scissorsAction === 'fill') || (tool === 'fill' && fillAction === 'fill');
  const chip = useStore((s) => paintOverLabel(adds ? s.paintOver : 'all', s.segments, s.activeSegment));
  const name = TOOLS.find((t) => t.id === tool)?.name ?? '';
  const key = useKeyHint();

  // The strip tightens itself step by step until its controls fit, so it holds
  // up with any window width, system font or segment name.
  const optionsRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(0);
  useLayoutEffect(() => {
    const el = optionsRef.current;
    if (!el) return;
    const fit = () => {
      let level = 0;
      el.parentElement!.dataset.compact = '0';
      while (level < 3 && el.scrollWidth > el.clientWidth) {
        level++;
        el.parentElement!.dataset.compact = String(level);
      }
      setCompact(level);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement!);
    return () => observer.disconnect();
  }, [tool, scissorsShape, scissorsAction, fillAction, paintOver, chip, previewing]);

  let body;
  switch (tool) {
    case 'crosshair':
      body = <span className="hint">Click to move all views to a point.</span>;
      break;
    case 'pan':
      body = <span className="hint">Drag to move the image.</span>;
      break;
    case 'zoom':
      body = (
        <>
          <span className="hint">Drag up or down to zoom.</span>
          <button className="btn secondary" onClick={fitAll}>
            Fit
          </button>
        </>
      );
      break;
    case 'window':
      body = <WindowFields />;
      break;
    case 'measure':
      body = (
        <>
          <span className="hint">Drag to measure a distance.</span>
          <button className="btn secondary" onClick={clearMeasurements}>
            Clear all
          </button>
        </>
      );
      break;
    case 'brush':
      body = (
        <>
          <SizeField />
          <ShapeField />
          <PaintOverField />
          <span className="hint">Shift-drag erases.</span>
          <button
            className="btn secondary"
            data-tour="interpolate"
            data-tip={`Paint every few slices, then fill the gaps  ${key('mask.interpolate')}`.trimEnd()}
            data-tip-side="bottom"
            data-tip-align="end"
            onClick={fillBetweenSlices}
          >
            <span className="long">Fill between slices</span>
            <span className="short">Fill gaps</span>
          </button>
        </>
      );
      break;
    case 'eraser':
      body = (
        <>
          <SizeField />
          <ShapeField />
        </>
      );
      break;
    case 'threshold':
      body = (
        <>
          <ThresholdField />
          <SizeField />
          <PaintOverField list />
        </>
      );
      break;
    case 'scissors':
      body = (
        <>
          <div className="field">
            <span className="label">Shape</span>
            <Choice
              label="Scissors shape"
              value={scissorsShape}
              options={[
                { value: 'rectangle', label: 'Rectangle', short: 'Rect' },
                { value: 'circle', label: 'Circle' },
                { value: 'freehand', label: 'Freehand', short: 'Free' },
                { value: 'sphere', label: 'Sphere' },
              ]}
              onChange={(v) => setToolOption({ scissorsShape: v })}
            />
          </div>
          <div className="field">
            <span className="label">Action</span>
            <Choice
              label="Scissors action"
              value={scissorsAction}
              options={[
                { value: 'erase' as const, label: 'Erase inside', short: 'Erase in' },
                { value: 'outside' as const, label: 'Erase outside', short: 'Erase out' },
                { value: 'fill' as const, label: 'Fill inside', short: 'Fill' },
              ].filter((o) => scissorsShape !== 'sphere' || o.value !== 'outside')}
              onChange={(v) => setToolOption({ scissorsAction: v })}
            />
          </div>
          {scissorsShape !== 'sphere' && (
            <div className="field" data-tip="All slices cuts through the whole stack of this view." data-tip-side="bottom" data-tip-align="end">
              <span className="label">Depth</span>
              <Choice
                label="Scissors depth"
                value={scissorsDepth}
                options={[
                  { value: 'slice', label: 'This slice', short: 'Slice' },
                  { value: 'all', label: 'All slices', short: 'All' },
                ]}
                onChange={(v) => setToolOption({ scissorsDepth: v })}
              />
            </div>
          )}
          {scissorsAction === 'fill' && <PaintOverField list />}
        </>
      );
      break;
    case 'fill':
      body = (
        <>
          <div className="field">
            <span className="label">Action</span>
            <Choice
              label="Fill action"
              value={fillAction}
              options={[
                { value: 'fill', label: 'Fill area', short: 'Fill' },
                { value: 'remove', label: 'Remove island', short: 'Remove' },
                { value: 'keep', label: 'Keep island', short: 'Keep' },
              ]}
              onChange={(v) => setToolOption({ fillAction: v })}
            />
          </div>
          {fillAction === 'fill' && <PaintOverField list />}
          <span className="hint">
            {fillAction === 'fill'
              ? 'Click an enclosed area to fill it on this slice.'
              : fillAction === 'remove'
                ? 'Click a separate piece of the segment to remove it.'
                : 'Click the piece of the segment to keep. The rest is removed.'}
          </span>
        </>
      );
      break;
  }
  // A fill that is shown but not done yet takes the strip until it is applied or cancelled.
  if (preview) {
    body = (
      <>
        <span className="hint keep" role="status">
          Preview: {preview.count.toLocaleString('en-US')} voxels between {preview.view} slices.
        </span>
        <button className="btn primary" data-tip="Apply  Enter" data-tip-side="bottom" onClick={applyFillPreview}>
          Apply
        </button>
        <button className="btn secondary" data-tip="Cancel  Esc" data-tip-side="bottom" onClick={() => cancelFillPreview()}>
          Cancel
        </button>
      </>
    );
  }

  return (
    <div className="strip" data-strip={tool} data-compact={compact} data-tour="options">
      <span className="toolname">{name}</span>
      <div className="options" key={preview ? 'preview' : tool} ref={optionsRef}>
        {body}
      </div>
      <span className="chip" data-tip={active ? `Painting on ${chip}` : 'No segment'} data-tip-align="end">
        {active && <span className="swatch" style={{ background: active.color }} />}
        <span>{chip}</span>
      </span>
    </div>
  );
}
