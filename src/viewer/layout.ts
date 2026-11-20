import type { ViewId } from '../state/store';

/** How the viewport area is divided. The panes are plain rectangles in CSS pixels; nothing here touches the DOM. */
export type LayoutId = 'grid' | 'focus' | 'three' | 'two' | 'single';

export const LAYOUTS: { id: LayoutId; label: string; panes: number }[] = [
  { id: 'grid', label: '2 × 2', panes: 4 },
  { id: 'focus', label: '1 large and 3 stacked', panes: 4 },
  { id: 'three', label: '3 side by side', panes: 3 },
  { id: 'two', label: '2 side by side', panes: 2 },
  { id: 'single', label: 'Single view', panes: 1 },
];

export const VIEW_IDS: ViewId[] = ['axial', 'sagittal', 'coronal', 'volume3d'];

/** Which view each pane shows, in pane order. Always the four views, once each. */
export type ViewOrder = readonly ViewId[];

export const DEFAULT_ORDER: ViewOrder = VIEW_IDS;

/** Gutter between panes (DESIGN 2.4). */
export const GAP = 2;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cuts a length into `n` whole-pixel parts with a gutter between them. Spare pixels go to the first parts. */
function split(total: number, n: number): { at: number; size: number }[] {
  const free = total - GAP * (n - 1);
  const base = Math.floor(free / n);
  const spare = free - base * n;
  const out: { at: number; size: number }[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < spare ? 1 : 0);
    out.push({ at, size });
    at += size + GAP;
  }
  return out;
}

/** The panes of a layout inside an area of `width` × `height`, in pane order. */
export function paneRects(layout: LayoutId, width: number, height: number): Rect[] {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w <= 0 || h <= 0) return [];
  switch (layout) {
    case 'single':
      return [{ x: 0, y: 0, w, h }];
    case 'two':
    case 'three':
      return split(w, layout === 'two' ? 2 : 3).map((c) => ({ x: c.at, y: 0, w: c.size, h }));
    case 'focus': {
      const big = Math.round(((w - GAP) * 3) / 4);
      const x = big + GAP;
      return [{ x: 0, y: 0, w: big, h }, ...split(h, 3).map((r) => ({ x, y: r.at, w: w - x, h: r.size }))];
    }
    case 'grid': {
      const cols = split(w, 2);
      return split(h, 2).flatMap((r) => cols.map((c) => ({ x: c.at, y: r.at, w: c.size, h: r.size })));
    }
  }
}

/** Shows `view` in pane `pane`. The view that was there takes the place `view` came from, so none is shown twice. */
export function assignView(order: ViewOrder, pane: number, view: ViewId): ViewId[] {
  return swapViews(order, order[pane], view);
}

export function swapViews(order: ViewOrder, a: ViewId, b: ViewId): ViewId[] {
  return order.map((v) => (v === a ? b : v === b ? a : v));
}

export function formatOrder(order: ViewOrder): string {
  return order.join(',');
}

export function parseOrder(raw: string): ViewId[] {
  const parts = raw.split(',') as ViewId[];
  const valid = parts.length === VIEW_IDS.length && VIEW_IDS.every((v) => parts.includes(v));
  return valid ? parts : [...DEFAULT_ORDER];
}

export function parseLayout(raw: string): LayoutId {
  return LAYOUTS.some((l) => l.id === raw) ? (raw as LayoutId) : 'grid';
}

/**
 * Where each view goes. Views the layout has no pane for are left out. A maximised
 * view is shown alone over the whole area, whatever the layout.
 */
export function placeViews(
  layout: LayoutId,
  order: ViewOrder,
  maximized: ViewId | null,
  width: number,
  height: number,
): Partial<Record<ViewId, Rect>> {
  const out: Partial<Record<ViewId, Rect>> = {};
  if (maximized) {
    const [rect] = paneRects('single', width, height);
    if (rect) out[maximized] = rect;
    return out;
  }
  paneRects(layout, width, height).forEach((rect, i) => {
    out[order[i]] = rect;
  });
  return out;
}

/** The part of the segment a–b that lies inside `box` (Liang–Barsky), or null when none does. */
export function clipSegment(
  a: readonly [number, number],
  b: readonly [number, number],
  box: Rect,
): [[number, number], [number, number]] | null {
  if (box.w <= 0 || box.h <= 0) return null;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - box.x],
    [dx, box.x + box.w - a[0]],
    [-dy, a[1] - box.y],
    [dy, box.y + box.h - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}
