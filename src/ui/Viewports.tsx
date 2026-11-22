import { Box, ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attachEditTracking, getImage, getMask, setShow3dImage, setVoi, shareCursor } from '../session';
import { parseReferenceLines, setSetting, useSettings } from '../state/settings';
import { EDIT_TOOLS, activeSegmentInfo, set, toast, useStore, type ViewId } from '../state/store';
import { showViewInPlaceOf, toggleMaximise } from '../state/views';
import * as engine from '../viewer/engine';
import { useDismiss, useKeyHint } from './common';
import { attachViewportGestures } from './gestureInput';
import { attachMaskPointer } from './maskPointer';
import { voxelAt } from '../viewer/geometry';
import { growthPlan, parseLayout, parseOrder, placeViews } from '../viewer/layout';

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

/**
 * The name of the view in a pane. Clicking it lists the four views; picking one shows it here,
 * and the view that was here goes where the picked one came from. Dragging the name onto
 * another pane swaps the two.
 */
function ViewLabel({ view }: { view: ViewId }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const drag = useRef<{ x: number; y: number; moved: boolean; over: HTMLElement | null } | null>(null);
  const label = VIEWS.find((v) => v.id === view)!.label;
  const color = engine.VIEW_COLORS[view];
  const smoothPixels = useSettings((s) => s.smoothPixels);

  const paneUnder = (e: React.PointerEvent): HTMLElement | null => {
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.cell') ?? null;
    return cell && cell.dataset.view !== view ? cell : null;
  };
  const mark = (cell: HTMLElement | null) => {
    const d = drag.current;
    if (!d || d.over === cell) return;
    d.over?.removeAttribute('data-drop');
    cell?.setAttribute('data-drop', 'true');
    d.over = cell;
  };

  return (
    <div className="viewlabel" ref={ref}>
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change view, or drag onto another pane to swap"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, moved: false, over: null };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
          d.moved = true;
          mark(paneUnder(e));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d?.moved) return;
          const target = paneUnder(e);
          mark(null);
          if (target) showViewInPlaceOf(target.dataset.view as ViewId, view);
        }}
        onPointerCancel={() => {
          mark(null);
          drag.current = null;
        }}
        onClick={() => {
          // A drag ends in a click on the same button; only a plain click opens the list.
          const dragged = drag.current?.moved;
          drag.current = null;
          if (!dragged) setOpen(!open);
        }}
      >
        {color && <span className="dot" style={{ background: color }} />}
        {label}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="View in this pane">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className="item"
              role="menuitemradio"
              aria-checked={v.id === view}
              onClick={() => {
                setOpen(false);
                showViewInPlaceOf(view, v.id);
              }}
            >
              <span className="name">
                <span className="dot" style={{ background: engine.VIEW_COLORS[v.id] ?? 'transparent' }} />
                {v.label}
              </span>
            </button>
          ))}
          {view !== 'volume3d' && (
            <>
              <hr />
              <button
                className="item"
                role="menuitemcheckbox"
                aria-checked={smoothPixels}
                title="Off shows each voxel as a flat block. The image values are the same either way."
                onClick={() => setSetting('smoothPixels', !smoothPixels)}
              >
                <span className="name">
                  <span className="tick" aria-hidden>
                    {smoothPixels ? '✓' : ''}
                  </span>
                  Smooth pixels
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Viewports() {
  const refs = useRef<Partial<Record<ViewId, HTMLDivElement | null>>>({});
  const cells = useRef<Partial<Record<ViewId, HTMLDivElement | null>>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const maximized = useStore((s) => s.maximized);
  const veil = useStore((s) => s.room?.veil ?? null);
  // A guest who views through the host holds single planes, never a volume: there is nothing to draw in 3D.
  const guestView = useStore((s) => !!s.image?.grey);
  const layout = parseLayout(useSettings((s) => s.layout));
  const viewOrder = useSettings((s) => s.viewOrder);
  const referenceLines = parseReferenceLines(useSettings((s) => s.referenceLines));
  const smoothPixels = useSettings((s) => s.smoothPixels);
  // Read by place(), which also runs from the resize observer, outside React's render.
  const arrangement = useRef({ layout, viewOrder, maximized });
  arrangement.current = { layout, viewOrder, maximized };

  /**
   * Puts every view in its pane and gives each canvas its new size, all before the next paint.
   * The panes are sized in pixels here rather than by CSS grid, so a pane only ever changes
   * size together with its canvas and every webview lays them out the same way.
   */
  const place = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const a = arrangement.current;
    const order = parseOrder(a.viewOrder);
    const rects = placeViews(a.layout, order, a.maximized, grid.clientWidth, grid.clientHeight);
    for (const { id } of VIEWS) {
      const cell = cells.current[id];
      if (!cell) continue;
      const r = rects[id];
      cell.style.display = r ? '' : 'none';
      if (!r) continue;
      cell.style.left = `${r.x}px`;
      cell.style.top = `${r.y}px`;
      cell.style.width = `${r.w}px`;
      cell.style.height = `${r.h}px`;
    }
    engine.resizeViewports(growthPlan(a.layout, order, a.maximized, grid.clientWidth, grid.clientHeight));
    // Keys act on the active view, so it has to be one that is on screen.
    const active = useStore.getState().activeView;
    const first = VIEWS.find((v) => rects[v.id]);
    if (first && !rects[active]) set({ activeView: first.id });
  }, []);
  const activeView = useStore((s) => s.activeView);
  const slices = useStore((s) => s.slices);
  const hasSegments = useStore((s) => s.segments.length > 0);
  const show3dImage = useStore((s) => s.show3dImage);
  const [tick, setTick] = useState(0);
  const key = useKeyHint();
  const maskHidden = useStore((s) => s.maskHidden);
  const tool = useStore((s) => s.tool);
  const activeSeg = useStore(activeSegmentInfo);
  // Painting on a locked or hidden segment is refused rather than done silently.
  const blocked = EDIT_TOOLS.includes(tool) && !!activeSeg && (activeSeg.locked || !activeSeg.visible || maskHidden);
  const whyBlocked = () => {
    if (!activeSeg) return '';
    if (activeSeg.locked) return `${activeSeg.name} is locked. Unlock it to edit.`;
    if (maskHidden) return key('mask.toggle') ? `The mask is hidden. Press ${key('mask.toggle')} to show it.` : 'The mask is hidden. Show it to edit.';
    return `${activeSeg.name} is hidden. Show it to edit.`;
  };
  const lastRefusal = useRef(0);
  const pressed = useRef<[number, number]>([0, 0]);
  const refuse = (id: ViewId, e: React.MouseEvent) => {
    // Alt-click picks a segment; that is allowed on a locked or hidden one.
    if (!blocked || id === 'volume3d' || e.button !== 0 || e.altKey || !activeSeg) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation();
    e.preventDefault();
    if (Date.now() - lastRefusal.current > 1500) {
      lastRefusal.current = Date.now();
      toast('info', whyBlocked());
    }
  };

  useLayoutEffect(() => {
    const els = refs.current as Record<ViewId, HTMLDivElement>;
    // The panes get their size first, so each canvas is created at the size it is shown at.
    place();
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
    for (const v of VIEWS) offs.push(attachViewportGestures(els[v.id].parentElement!, v.id));
    for (const v of VIEWS) offs.push(attachMaskPointer(els[v.id].parentElement!, v.id));
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

    // Observers are told after layout and before paint, so the panes and canvases follow the area in the same frame.
    const ro = new ResizeObserver(() => place());
    ro.observe(gridRef.current!);
    window.addEventListener('blur', engine.forgetHeldKey);
    // A stroke let go outside the views leaves no ring behind. Deferred, so Cornerstone handles the release first.
    const onRelease = () =>
      setTimeout(() => {
        if (!gridRef.current?.querySelector('.cell:hover')) engine.hideBrushRing();
      });
    window.addEventListener('mouseup', onRelease);

    return () => {
      window.removeEventListener('mouseup', onRelease);
      ro.disconnect();
      window.removeEventListener('blur', engine.forgetHeldKey);
      offs.forEach((f) => f());
      detach();
      cancelAnimationFrame(raf);
      engine.unmountViewports();
    };
  }, [place]);

  useLayoutEffect(() => {
    place();
  }, [place, layout, viewOrder, maximized]);

  useEffect(() => {
    engine.setReferenceLines(referenceLines);
  }, [referenceLines]);

  useEffect(() => {
    engine.setSmoothPixels(smoothPixels);
  }, [smoothPixels]);

  const single = !maximized && layout === 'single';

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
    <div
      className="views"
      ref={gridRef}
      data-tour="views"
      data-layout={maximized ? 'single' : layout}
      onMouseEnter={() => engine.setLinesHover(true)}
      onMouseLeave={() => engine.setLinesHover(false)}
    >
      {VIEWS.map((v) => (
        <div
          key={v.id}
          className="cell"
          data-view={v.id}
          data-active={activeView === v.id}
          ref={(el) => {
            cells.current[v.id] = el;
          }}
          data-blocked={blocked && v.id !== 'volume3d'}
          tabIndex={0}
          aria-label={`${v.label} view`}
          onFocus={() => activeView !== v.id && set({ activeView: v.id })}
          onMouseDownCapture={(e) => refuse(v.id, e)}
          onPointerDownCapture={() => {
            engine.forgetHeldKey();
            if (activeView !== v.id) set({ activeView: v.id });
          }}
          onMouseMove={(e) => onMove(v.id, e)}
          onMouseLeave={(e) => {
            set({ hover: null });
            shareCursor(null);
            // Mid-stroke the ring follows the stroke; it goes when the button is let go.
            if (e.buttons === 0) engine.hideBrushRing();
          }}
          onMouseDown={(e) => {
            pressed.current = [e.clientX, e.clientY];
          }}
          onClick={(e) => {
            const still = Math.hypot(e.clientX - pressed.current[0], e.clientY - pressed.current[1]) <= 3;
            // The 3D view shows the mask; it cannot be painted on. Say so rather than do nothing.
            if (v.id === 'volume3d' && EDIT_TOOLS.includes(tool) && still && !(e.target as HTMLElement).closest('button')) {
              if (Date.now() - lastRefusal.current > 1500) {
                lastRefusal.current = Date.now();
                toast('info', 'Paint on the axial, sagittal or coronal view. The 3D view shows the result.');
              }
              return;
            }
            // A plain click with the crosshair brings the other two views to that point.
            if (tool !== 'crosshair' || v.id === 'volume3d' || (e.target as HTMLElement).closest('button')) return;
            if (!still) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const w = engine.canvasToWorld(v.id, e.clientX - rect.left, e.clientY - rect.top);
            if (w) engine.jumpTo(w, v.id);
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button, .menu')) return;
            // With an edit tool a double-click is two dabs of paint, not a layout change.
            if (!EDIT_TOOLS.includes(tool) && !single) toggleMaximise(v.id);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="canvas"
            ref={(el) => {
              refs.current[v.id] = el;
            }}
          />
          <div className="overlay tl">
            <ViewLabel view={v.id} />
          </div>
          <div className="overlay tr">
            {v.id === 'volume3d' && (
              <button
                className="iconbtn sm"
                aria-label="Show image in 3D"
                aria-pressed={show3dImage}
                data-tip={show3dImage ? 'Hide image' : 'Show image'}
                data-tip-side="bottom"
                data-tip-align="end"
                onClick={() => setShow3dImage(!show3dImage)}
              >
                <Box size={14} />
              </button>
            )}
            {!single && (
              <button
                className="iconbtn sm"
                aria-label={maximized === v.id ? 'Restore' : 'Maximise'}
                data-tip={`${maximized === v.id ? 'Restore' : 'Maximise'}  ${key('view.maximise')}`.trimEnd()}
                data-tip-side="bottom"
                data-tip-align="end"
                onClick={() => toggleMaximise(v.id)}
              >
                {maximized === v.id ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
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
          {v.id === 'volume3d' && !guestView && !hasSegments && !show3dImage && (
            <div className="overlay center">Add a segment to see it in 3D.</div>
          )}
          {v.id === 'volume3d' && guestView && (
            <div className="hostonly" data-testid="no-3d">
              The 3D view stays on the host's computer.
            </div>
          )}
          {v.id !== 'volume3d' && <RemoteCursors view={v.id} tick={tick} />}
        </div>
      ))}
      {/* A guest of a view-through-host room sees nothing while the host is away. A layer over the views, never a change to them. */}
      {veil && (
        <div className="roomveil" role="status" data-testid="room-veil">
          {veil}
        </div>
      )}
    </div>
  );
}
