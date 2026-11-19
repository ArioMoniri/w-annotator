import { activeSegmentInfo, useStore } from '../state/store';
import { fillBetweenSlices, setBrushSize, setPaintOver, setToolOption, setVoi } from '../session';
import { clearMeasurements, fitAll } from '../viewer/engine';
import { getImage } from '../session';
import { autoWindow } from '../io';
import { Choice, NumberField, Slider } from './common';
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
  return (
    <div className="field" data-tip="Brush diameter  [  ]" data-tip-side="bottom">
      <span className="label">Size</span>
      <Slider label="Brush size" min={1} max={100} value={size} onChange={setBrushSize} />
      <NumberField label="Brush size in millimetres" value={size} min={1} max={100} onCommit={setBrushSize} />
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
  const range = useStore((s) => s.image?.range);
  if (!voi) return null;
  const w = Math.round(voi.upper - voi.lower);
  const l = Math.round((voi.upper + voi.lower) / 2);
  const apply = (nw: number, nl: number) => setVoi(nl - Math.max(1, nw) / 2, nl + Math.max(1, nw) / 2);
  const looksLikeCt = !!range && range[0] <= -500 && range[1] > 300;
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
  const paintOver = useStore((s) => s.paintOver);
  const active = useStore(activeSegmentInfo);
  const name = TOOLS.find((t) => t.id === tool)?.name ?? '';

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
          <div className="field" data-tip="Empty only keeps other segments as they are." data-tip-side="bottom">
            <span className="label">Paint over</span>
            <Choice
              label="Paint over"
              value={paintOver}
              options={[
                { value: 'all', label: 'Everything' },
                { value: 'empty', label: 'Empty only' },
              ]}
              onChange={setPaintOver}
            />
          </div>
          <span className="hint">Shift-drag erases.</span>
          <button
            className="btn secondary"
            data-tour="interpolate"
            data-tip="Paint every few slices, then fill the gaps  I"
            data-tip-side="bottom"
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
          <ShapeField />
        </>
      );
      break;
    case 'threshold':
      body = (
        <>
          <ThresholdField />
          <SizeField />
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
                { value: 'rectangle', label: 'Rectangle' },
                { value: 'circle', label: 'Circle' },
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
                { value: 'erase', label: 'Erase inside' },
                { value: 'fill', label: 'Fill inside' },
              ]}
              onChange={(v) => setToolOption({ scissorsAction: v })}
            />
          </div>
        </>
      );
      break;
    case 'fill':
      body = <span className="hint">Click an enclosed area to fill it on this slice.</span>;
      break;
  }

  return (
    <div className="strip" data-strip={tool} data-tour="options">
      <span className="toolname">{name}</span>
      <div className="options" key={tool}>
        {body}
      </div>
      <span className="chip" data-tip={active ? `Painting on ${active.name}` : 'No segment'} data-tip-align="end">
        {active && <span className="swatch" style={{ background: active.color }} />}
        <span>{active ? active.name : 'No segment'}</span>
      </span>
    </div>
  );
}
