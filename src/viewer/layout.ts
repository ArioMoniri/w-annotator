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

type Size = { w: number; h: number };

/**
 * How many times larger an image that just fits the pane `from` is when it just fits the pane
 * `to`. `image` is the size of the image in the view, in any unit. An image enlarged by this
 * much fills the new pane as it filled the old one. One when any size is empty.
 */
export function paneGrowth(from: Size, to: Size, image: Size): number {
  const fit = (pane: Size) => Math.min(pane.w / image.w, pane.h / image.h);
  if (![from, to, image].every((s) => s.w > 0 && s.h > 0)) return 1;
  return fit(to) / fit(from);
}

/**
 * A state in which a view shows its image enlarged: `large` while it is in the large pane of
 * "1 large and 3 stacked", `maximised` while it is shown alone. Maximise goes on top of large.
 */
export type Enlarging = 'large' | 'maximised';

/** How many times a view's image was enlarged on entering each state it is in now. */
export type Growth = Partial<Record<Enlarging, number>>;

export interface ViewPlan {
  /** The pane an image opened in this view is sized for before any enlargement. */
  home: Size;
  /** The states the view is in, each with the pane it grows from and the pane it grows to. */
  enlarge: Partial<Record<Enlarging, { from: Size; to: Size }>>;
}

const sizeOf = (r: Rect): Size => ({ w: r.w, h: r.h });

/**
 * For each view the arrangement has a place for, which enlarging states it is in.
 *
 * The view in the large pane of "1 large and 3 stacked" grows from the pane it has in 2 × 2,
 * and the other three are sized as in 2 × 2 as well, so the result is the same whichever
 * layout the image was opened in and whichever view is swapped into the large pane. A maximised
 * view grows from the pane the layout gives it. Views hidden behind a maximised one keep their plan.
 */
export function growthPlan(
  layout: LayoutId,
  order: ViewOrder,
  maximized: ViewId | null,
  width: number,
  height: number,
): Partial<Record<ViewId, ViewPlan>> {
  const out: Partial<Record<ViewId, ViewPlan>> = {};
  const panes = paneRects(layout, width, height).map(sizeOf);
  if (!panes.length) return out;
  const grid = layout === 'focus' ? paneRects('grid', width, height).map(sizeOf) : panes;
  panes.forEach((pane, i) => {
    const plan: ViewPlan = { home: grid[i], enlarge: {} };
    if (layout === 'focus' && i === 0) plan.enlarge.large = { from: grid[0], to: pane };
    out[order[i]] = plan;
  });
  if (maximized) {
    const full = sizeOf(paneRects('single', width, height)[0]);
    const plan = out[maximized] ?? { home: full, enlarge: {} };
    plan.enlarge.maximised = { from: panes[order.indexOf(maximized)] ?? full, to: full };
    out[maximized] = plan;
  }
  return out;
}

export function totalGrowth(held: Growth): number {
  return (held.large ?? 1) * (held.maximised ?? 1);
}

/**
 * Moves a view from the states it is in (`held`) to the ones it should be in (`want`).
 * `factor` is how many times larger its image is drawn after the move; `held` is what to remember.
 *
 * Entering a state multiplies by the growth of the pane, which is remembered. Leaving divides
 * by what was remembered, not by what the panes would give now, so a view returns to the scale
 * it had, whatever was resized or zoomed in between. A view that stays maximised stays as it
 * is on screen while the layout changes underneath: its two factors are shared out again and
 * their product is kept.
 */
export function stepGrowth(held: Growth, want: ViewPlan['enlarge'], image: Size): { held: Growth; factor: number } {
  const before = totalGrowth(held);
  const next: Growth = {};
  if (want.large) next.large = held.large ?? paneGrowth(want.large.from, want.large.to, image);
  if (want.maximised) {
    next.maximised = held.maximised === undefined ? paneGrowth(want.maximised.from, want.maximised.to, image) : before / (next.large ?? 1);
  }
  const after = totalGrowth(next);
  return { held: next, factor: after === before ? 1 : after / before };
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
