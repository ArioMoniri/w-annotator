import { Box, Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attachEditTracking, getImage, getMask, setShow3dImage, setVoi, shareCursor } from '../session';
import { EDIT_TOOLS, activeSegmentInfo, set, toast, useStore, type ViewId } from '../state/store';
import * as engine from '../viewer/engine';
import { voxelAt } from '../viewer/geometry';

const VIEWS: { id: ViewId; label: string; letters?: [string, string, string, string] }[] = [
  // letters: top, bottom, left, right — patient directions for the standard radiological views
  { id: 'axial', label: 'Axial', letters: ['A', 'P', 'R', 'L'] },
  { id: 'sagittal', label: 'Sagittal', letters: ['S', 'I', 'A', 'P'] },
  { id: 'coronal', label: 'Coronal', letters: ['S', 'I', 'R', 'L'] },
  { id: 'volume3d', label: '3D' },
];

function RemoteCursors({ view, tick }: { view: ViewId; tick: number }) {
  const peers = useStore((s) => s.peers);
  void tick;
  const image = getImage();
  if (!image) return null;
  const sliceMm = Math.min(...image.spacing);
  return (
    <>
      {peers.map((p) => {
        if (!p.cursor || p.cursor.vp !== view) return null;
        const pos = engine.worldToCanvas(view, p.cursor.w);
        if (!pos) return null;
        const away = Math.round(engine.distanceToSlice(view, p.cursor.w) / sliceMm);
        if (Math.abs(away) > 10) return null;
        const zoomPx = p.cursor.r ? ringPixels(view, p.cursor.w, p.cursor.r) : 0;
        return (
          <div
            key={p.id}
            className="rcursor"
            aria-hidden
            style={{ transform: `translate(${pos[0]}px, ${pos[1]}px)`, opacity: away === 0 ? 1 : 0.4, color: p.color }}
          >
            {zoomPx > 0 ? (
              <span className="ring" style={{ width: zoomPx * 2, height: zoomPx * 2 }} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M1 1l4.2 11 1.7-4.6L11.5 5.7z" fill={p.color} stroke="#fff" strokeWidth="1" />
              </svg>
            )}
            <span className="label" style={{ background: p.color }}>
              {p.name}
              {away !== 0 ? `  ${away > 0 ? '+' : ''}${away}` : ''}
            </span>
          </div>
        );
      })}
    </>
  );
}

function ringPixels(view: ViewId, w: [number, number, number], radiusMm: number): number {
  const a = engine.worldToCanvas(view, w);
  const origin = engine.canvasToWorld(view, 0, 0);
  const unit = engine.canvasToWorld(view, 1, 0);
  if (!a || !origin || !unit) return 0;
  const mmPerPx = Math.hypot(unit[0] - origin[0], unit[1] - origin[1], unit[2] - origin[2]);
  return mmPerPx > 0 ? radiusMm / mmPerPx : 0;
}

export function Viewports() {
  const refs = useRef<Partial<Record<ViewId, HTMLDivElement | null>>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const maximized = useStore((s) => s.maximized);
  const activeView = useStore((s) => s.activeView);
  const slices = useStore((s) => s.slices);
  const hasSegments = useStore((s) => s.segments.length > 0);
  const show3dImage = useStore((s) => s.show3dImage);
  const [tick, setTick] = useState(0);
  const tool = useStore((s) => s.tool);
  const activeSeg = useStore(activeSegmentInfo);
  // Painting on a locked or hidden segment is refused rather than done silently.
  const blocked = EDIT_TOOLS.includes(tool) && !!activeSeg && (activeSeg.locked || !activeSeg.visible);
  const lastRefusal = useRef(0);
  const refuse = (id: ViewId, e: React.MouseEvent) => {
    if (!blocked || id === 'volume3d' || e.button !== 0 || !activeSeg) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation();
    e.preventDefault();
    if (Date.now() - lastRefusal.current > 1500) {
      lastRefusal.current = Date.now();
      toast('info', activeSeg.locked ? `${activeSeg.name} is locked. Unlock it to edit.` : `${activeSeg.name} is hidden. Show it to edit.`);
    }
  };

  useLayoutEffect(() => {
    const els = refs.current as Record<ViewId, HTMLDivElement>;
    engine.mountViewports(els);
    const detach = attachEditTracking();

    const offs: (() => void)[] = [];
    let raf = 0;
    const refresh = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next: Record<string, { index: number; count: number }> = {};
        for (const id of engine.ORTHO_IDS) {
          const s = engine.getSlice(id);
          if (s) next[id] = s;
        }
        set({ slices: next, zoom: engine.getZoom(useStore.getState().activeView === 'volume3d' ? 'axial' : useStore.getState().activeView) });
        setTick((t) => t + 1);
      });
    };
    for (const id of engine.ORTHO_IDS) {
      const el = els[id];
      const onCamera = () => refresh();
      const onVoi = (evt: Event) => {
        const range = (evt as CustomEvent).detail?.range as { lower: number; upper: number } | undefined;
        const cur = useStore.getState().voi;
        if (!range) return;
        if (!cur || Math.abs(cur.lower - range.lower) > 1e-6 || Math.abs(cur.upper - range.upper) > 1e-6) {
          setVoi(range.lower, range.upper);
        }
      };
      el.addEventListener(engine.ViewportEvents.camera, onCamera);
      el.addEventListener(engine.ViewportEvents.newImage, onCamera);
      el.addEventListener(engine.ViewportEvents.voi, onVoi);
      offs.push(() => {
        el.removeEventListener(engine.ViewportEvents.camera, onCamera);
        el.removeEventListener(engine.ViewportEvents.newImage, onCamera);
        el.removeEventListener(engine.ViewportEvents.voi, onVoi);
      });
    }

    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => engine.resizeViewports());
    });
    ro.observe(gridRef.current!);

    return () => {
      ro.disconnect();
      offs.forEach((f) => f());
      detach();
      cancelAnimationFrame(raf);
      engine.unmountViewports();
    };
  }, []);

  useEffect(() => {
    engine.resizeViewports();
  }, [maximized]);

  const onMove = (id: ViewId, e: React.MouseEvent<HTMLDivElement>) => {
    if (id === 'volume3d') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const w = engine.canvasToWorld(id, e.clientX - rect.left, e.clientY - rect.top);
    const image = getImage();
    const mask = getMask();
    if (!w || !image) return;
    shareCursor(id, w);
    const ijk = voxelAt(image, w);
    if (!ijk) {
      if (useStore.getState().hover) set({ hover: null });
      return;
    }
    const offset = ijk[0] + ijk[1] * image.dims[0] + ijk[2] * image.dims[0] * image.dims[1];
    set({ hover: { ijk, value: image.data[offset], segment: mask ? mask.data[offset] : 0 } });
  };

  return (
    <div className="views" ref={gridRef}>
      {VIEWS.map((v) => (
        <div
          key={v.id}
          className="cell"
          data-view={v.id}
          data-active={activeView === v.id}
          data-max={maximized ? maximized === v.id : undefined}
          data-blocked={blocked && v.id !== 'volume3d'}
          tabIndex={0}
          aria-label={`${v.label} view`}
          onFocus={() => activeView !== v.id && set({ activeView: v.id })}
          onMouseDownCapture={(e) => refuse(v.id, e)}
          onPointerDownCapture={() => activeView !== v.id && set({ activeView: v.id })}
          onMouseMove={(e) => onMove(v.id, e)}
          onMouseLeave={() => {
            set({ hover: null });
            shareCursor(null);
          }}
          onDoubleClick={() => set({ maximized: maximized === v.id ? null : v.id })}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="canvas"
            ref={(el) => {
              refs.current[v.id] = el;
            }}
          />
          <div className="overlay tl">
            {engine.VIEW_COLORS[v.id] && <span className="dot" style={{ background: engine.VIEW_COLORS[v.id] }} />}
            {v.label}
          </div>
          <div className="overlay tr">
            {v.id === 'volume3d' && (
              <button
                className="iconbtn sm"
                aria-label="Show image in 3D"
                aria-pressed={show3dImage}
                data-tip={show3dImage ? 'Hide image' : 'Show image'}
                data-tip-side="left"
                onClick={() => setShow3dImage(!show3dImage)}
              >
                <Box size={14} />
              </button>
            )}
            <button
              className="iconbtn sm"
              aria-label={maximized === v.id ? 'Restore' : 'Maximise'}
              data-tip={maximized === v.id ? 'Restore  M' : 'Maximise  M'}
              data-tip-side="left"
              onClick={() => set({ maximized: maximized === v.id ? null : v.id })}
            >
              {maximized === v.id ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
          {v.letters && (
            <>
              <span className="orient t">{v.letters[0]}</span>
              <span className="orient b">{v.letters[1]}</span>
              <span className="orient l">{v.letters[2]}</span>
              <span className="orient r">{v.letters[3]}</span>
            </>
          )}
          {slices[v.id] && (
            <div className="overlay bl">
              Slice {slices[v.id].index + 1} / {slices[v.id].count}
            </div>
          )}
          {v.id === 'volume3d' && !hasSegments && !show3dImage && (
            <div className="overlay center">Add a segment to see it in 3D.</div>
          )}
          {v.id !== 'volume3d' && <RemoteCursors view={v.id} tick={tick} />}
        </div>
      ))}
    </div>
  );
}
