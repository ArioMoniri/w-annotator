import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { activeSegmentInfo, useStore } from '../state/store';
import { applyFillPreview, cancelFillPreview, fillBetweenSlices, setBrushSize, setPaintOver, setToolOption, setVoi } from '../session';
import { paintOverLabel } from '../mask/paintOver';
import { clearMeasurements, fitAll } from '../viewer/engine';
import { useSettings } from '../state/settings';
import { matchChoice, windowChoices, windowFields, windowFromFields, windowStep } from '../viewer/window';
import { applyWindowChoice } from '../windowing';
import { BRUSH_MAX } from '../mask/brush';
import { Choice, MOD, NumberField, Slider, useKeyHint } from './common';
import { TOOLS } from './ToolRail';

/** The tightest step of the strip. */
const COMPACT_MAX = 3;

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

function ShapeField({ list = false }: { list?: boolean }) {
  const shape = useStore((s) => s.brushShape);
  return (
    <div className="field">
      <span className="label">Shape</span>
      <Choice label="Brush shape" value={shape} options={SHAPES} collapsed={list} onChange={(brushShape) => setToolOption({ brushShape })} />
    </div>
  );
}

const PAINT_OVER_TIP = 'Empty only keeps other segments as they are.';
const PAINT_INSIDE_TIP = 'Paint only inside one segment';

/**
 * What painting may write over. In the brush strip it is two buttons and a list of
 * segments; where the strip is fuller or the window narrower it is one list with the
 * same choices.
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

const WINDOW_HINT = `${MOD}-drag a box to set the window from it.`;

function WindowFields({ hintAsTip }: { hintAsTip: boolean }) {
  const voi = useStore((s) => s.voi);
  const image = useStore((s) => s.image);
  const asked = useStore((s) => s.windowSet);
  const custom = useSettings((s) => s.windowPresets);
  if (!voi || !image) return null;
  // Whole numbers on CT; finer on an image with a narrow range, such as one scaled 0 to 1.
  const step = windowStep(image.range);
  const { w, l } = windowFields(voi, step);
  const apply = (nw: number, nl: number) => {
    const next = windowFromFields(nw, nl, step);
    setVoi(next.lower, next.upper);
  };
  const choices = windowChoices(image, custom, asked ?? (image.ct ? 'ct' : 'mr'));
  const current = matchChoice(choices, voi)?.name ?? '';
  return (
    <>
      <div className="field">
        <label htmlFor="wl-preset">Preset</label>
        <select
          id="wl-preset"
          className="select"
          value={current}
          onChange={(e) => {
            const c = choices.find((x) => x.name === e.target.value);
            if (c) applyWindowChoice(c);
            // Give the keyboard back to the tool shortcuts.
            e.target.blur();
          }}
        >
          <option value="" disabled>
            Custom
          </option>
          {choices.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      </div>
      {/* Where the hint has no room it is the tip of these fields, for the pointer and for the keyboard. */}
      <div className="field hinted" data-tip={hintAsTip ? WINDOW_HINT : undefined} data-tip-side="bottom" data-tip-align="end">
        <span className="label">W</span>
        <NumberField label="Window width" wide value={w} min={step} step={step} onCommit={(v) => apply(v, l)} />
        <span className="label">L</span>
        <NumberField label="Window level" wide value={l} step={step} onCommit={(v) => apply(w, v)} />
      </div>
      <button className="btn secondary" onClick={() => setVoi(image.auto.lower, image.auto.upper)}>
        Reset
      </button>
      <span className="hint">{WINDOW_HINT}</span>
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
  const segmentCount = useStore((s) => s.segments.length);
  const name = TOOLS.find((t) => t.id === tool)?.name ?? '';
  const key = useKeyHint();

  // The strip tightens itself step by step until its controls fit, so it holds up with any
  // window width, system font or segment name. Each step is tried in the page before it is
  // painted: 1 drops hints and field labels, 2 closes the gaps and turns the longer groups
  // of buttons into lists, 3 turns every group into a list and drops the sliders. Words are
  // never shortened.
  const stripRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState({ key: '', level: 0 });
  const fitKey = [tool, scissorsShape, scissorsAction, fillAction, paintOver, chip, previewing, segmentCount, width].join('|');
  const compact = fit.key === fitKey ? fit.level : 0;
  useLayoutEffect(() => {
    const el = optionsRef.current;
    if (!el) return;
    if (compact < COMPACT_MAX && el.scrollWidth > el.clientWidth) setFit({ key: fitKey, level: compact + 1 });
    else if (fit.key !== fitKey) setFit({ key: fitKey, level: compact });
  }, [fitKey, compact, fit.key]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  /** A group of buttons with this many options is a list at the current step. */
  const asList = (options: number) => compact >= 3 || (compact >= 2 && options >= 3);

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
      body = <WindowFields hintAsTip={compact >= 1} />;
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
          <ShapeField list={asList(2)} />
          <PaintOverField list={asList(3)} />
          <span className="hint">Shift-drag erases.</span>
          <button
            className="btn secondary"
            data-tour="interpolate"
            data-tip={`Paint every few slices, then fill the gaps  ${key('mask.interpolate')}`.trimEnd()}
            data-tip-side="bottom"
            data-tip-align="end"
            onClick={fillBetweenSlices}
          >
            Fill between slices
          </button>
        </>
      );
      break;
    case 'eraser':
      body = (
        <>
          <SizeField />
          <ShapeField list={asList(2)} />
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
              collapsed={asList(4)}
              options={[
                { value: 'rectangle', label: 'Rectangle' },
                { value: 'circle', label: 'Circle' },
                { value: 'freehand', label: 'Freehand' },
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
              collapsed={asList(3)}
              options={[
                { value: 'erase' as const, label: 'Erase inside' },
                { value: 'outside' as const, label: 'Erase outside' },
                { value: 'fill' as const, label: 'Fill inside' },
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
                collapsed={asList(2)}
                options={[
                  { value: 'slice', label: 'This slice' },
                  { value: 'all', label: 'All slices' },
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
              collapsed={asList(3)}
              options={[
                { value: 'fill', label: 'Fill area' },
                { value: 'remove', label: 'Remove island' },
                { value: 'keep', label: 'Keep island' },
              ]}
              onChange={(v) => setToolOption({ fillAction: v })}
            />
          </div>
          {fillAction === 'fill' && <PaintOverField list />}
          <span className="hint">
            {fillAction === 'fill'
              ? 'Click an enclosed area to fill it on this slice.'
              : fillAction === 'remove'
                ? 'Click a piece of the segment to remove it. A segment in one piece is removed whole.'
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
          Preview: {preview.size} between {preview.view} slices.
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
    <div className="strip" data-strip={tool} data-compact={compact} data-tour="options" ref={stripRef}>
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
