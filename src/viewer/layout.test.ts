import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER,
  GAP,
  LAYOUTS,
  assignView,
  clipSegment,
  formatOrder,
  paneRects,
  parseLayout,
  parseOrder,
  placeViews,
  swapViews,
  type LayoutId,
  type Rect,
} from './layout';

const SIZES: [number, number][] = [
  [968, 690],
  [1232, 690],
  [707, 531],
  [641, 333],
  [1920, 1041],
  [101, 61],
];

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('paneRects', () => {
  it('gives each layout its number of panes', () => {
    const count = (id: LayoutId) => paneRects(id, 1000, 700).length;
    expect(count('grid')).toBe(4);
    expect(count('focus')).toBe(4);
    expect(count('three')).toBe(3);
    expect(count('two')).toBe(2);
    expect(count('single')).toBe(1);
    expect(LAYOUTS.map((l) => l.id)).toEqual(['grid', 'focus', 'three', 'two', 'single']);
  });

  for (const { id } of LAYOUTS) {
    for (const [w, h] of SIZES) {
      it(`${id} tiles ${w} × ${h} with whole pixels, no overlap and only the gutters left over`, () => {
        const rects = paneRects(id, w, h);
        for (const r of rects) {
          for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(w);
          expect(r.y + r.h).toBeLessThanOrEqual(h);
        }
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
        // Every pixel is a pane or a gutter: mark the panes, then check what is left is thin.
        const covered = rects.reduce((sum, r) => sum + r.w * r.h, 0);
        const cols = id === 'grid' || id === 'focus' || id === 'two' ? 2 : id === 'three' ? 3 : 1;
        const rows = id === 'grid' ? 2 : 1;
        const gutters = (cols - 1) * GAP * h + (rows - 1) * GAP * w - (cols - 1) * (rows - 1) * GAP * GAP;
        const stacked = id === 'focus' ? 2 * GAP * rects[1].w : 0;
        expect(covered + gutters + stacked).toBe(w * h);
        // The panes reach all four edges.
        expect(Math.min(...rects.map((r) => r.x))).toBe(0);
        expect(Math.min(...rects.map((r) => r.y))).toBe(0);
        expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(w);
        expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(h);
      });
    }
  }

  it('grid is two equal columns and rows', () => {
    expect(paneRects('grid', 1002, 702)).toEqual([
      { x: 0, y: 0, w: 500, h: 350 },
      { x: 502, y: 0, w: 500, h: 350 },
      { x: 0, y: 352, w: 500, h: 350 },
      { x: 502, y: 352, w: 500, h: 350 },
    ]);
  });

  it('focus puts the large pane on the left at three quarters and stacks three on the right', () => {
    const [big, a, b, c] = paneRects('focus', 1002, 704);
    expect(big).toEqual({ x: 0, y: 0, w: 750, h: 704 });
    expect(a).toEqual({ x: 752, y: 0, w: 250, h: 234 });
    expect(b).toEqual({ x: 752, y: 236, w: 250, h: 233 });
    expect(c).toEqual({ x: 752, y: 471, w: 250, h: 233 });
  });

  it('single fills the whole area', () => {
    expect(paneRects('single', 968, 690)).toEqual([{ x: 0, y: 0, w: 968, h: 690 }]);
  });

  it('gives nothing for an area with no size', () => {
    expect(paneRects('grid', 0, 500)).toEqual([]);
    expect(paneRects('grid', 500, 0)).toEqual([]);
  });
});

describe('view order', () => {
  it('starts as axial, sagittal, coronal, 3D', () => {
    expect(DEFAULT_ORDER).toEqual(['axial', 'sagittal', 'coronal', 'volume3d']);
  });

  it('picking a view for a pane swaps it with the view that was there', () => {
    expect(assignView(DEFAULT_ORDER, 0, 'coronal')).toEqual(['coronal', 'sagittal', 'axial', 'volume3d']);
    expect(assignView(DEFAULT_ORDER, 1, 'volume3d')).toEqual(['axial', 'volume3d', 'coronal', 'sagittal']);
  });

  it('picking the view a pane already shows changes nothing', () => {
    expect(assignView(DEFAULT_ORDER, 2, 'coronal')).toEqual(DEFAULT_ORDER);
  });

  it('never shows a view twice', () => {
    let order = DEFAULT_ORDER;
    const picks: [number, (typeof DEFAULT_ORDER)[number]][] = [
      [0, 'volume3d'],
      [3, 'sagittal'],
      [1, 'coronal'],
      [2, 'coronal'],
      [0, 'axial'],
    ];
    for (const [pane, view] of picks) {
      order = assignView(order, pane, view);
      expect(order[pane]).toBe(view);
      expect([...order].sort()).toEqual([...DEFAULT_ORDER].sort());
    }
  });

  it('swaps two views by name', () => {
    expect(swapViews(DEFAULT_ORDER, 'axial', 'volume3d')).toEqual(['volume3d', 'sagittal', 'coronal', 'axial']);
    expect(swapViews(DEFAULT_ORDER, 'axial', 'axial')).toEqual(DEFAULT_ORDER);
  });

  it('does not change the order it was given', () => {
    const before = [...DEFAULT_ORDER];
    assignView(DEFAULT_ORDER, 0, 'coronal');
    swapViews(DEFAULT_ORDER, 'axial', 'coronal');
    expect(DEFAULT_ORDER).toEqual(before);
  });

  it('reads a saved order and falls back when it is not the four views once each', () => {
    expect(parseOrder('coronal,axial,volume3d,sagittal')).toEqual(['coronal', 'axial', 'volume3d', 'sagittal']);
    expect(parseOrder(formatOrder(['volume3d', 'coronal', 'sagittal', 'axial']))).toEqual(['volume3d', 'coronal', 'sagittal', 'axial']);
    for (const bad of ['', 'axial,axial,coronal,volume3d', 'axial,sagittal,coronal', 'axial,sagittal,coronal,oblique', 'nonsense']) {
      expect(parseOrder(bad)).toEqual(DEFAULT_ORDER);
    }
  });

  it('reads a saved layout and falls back to the grid', () => {
    expect(parseLayout('focus')).toBe('focus');
    expect(parseLayout('single')).toBe('single');
    expect(parseLayout('')).toBe('grid');
    expect(parseLayout('5x5')).toBe('grid');
  });
});

describe('placeViews', () => {
  it('puts the first views of the order in the panes and leaves the rest out', () => {
    const placed = placeViews('three', DEFAULT_ORDER, null, 902, 600);
    expect(Object.keys(placed)).toEqual(['axial', 'sagittal', 'coronal']);
    expect(placed.volume3d).toBeUndefined();
    expect(placed.axial).toEqual({ x: 0, y: 0, w: 300, h: 600 });
    expect(placed.sagittal).toEqual({ x: 302, y: 0, w: 299, h: 600 });
    expect(placed.coronal).toEqual({ x: 603, y: 0, w: 299, h: 600 });
  });

  it('follows the order', () => {
    const placed = placeViews('two', ['volume3d', 'coronal', 'axial', 'sagittal'], null, 1002, 600);
    expect(Object.keys(placed)).toEqual(['volume3d', 'coronal']);
    expect(placed.volume3d!.x).toBe(0);
    expect(placed.coronal!.x).toBe(502);
  });

  it('shows a maximised view alone, whatever the layout, even one the layout leaves out', () => {
    for (const { id } of LAYOUTS) {
      expect(placeViews(id, DEFAULT_ORDER, 'volume3d', 968, 690)).toEqual({ volume3d: { x: 0, y: 0, w: 968, h: 690 } });
    }
  });

  it('places every view exactly once in the four-pane layouts', () => {
    for (const id of ['grid', 'focus'] as const) {
      expect(Object.keys(placeViews(id, DEFAULT_ORDER, null, 968, 690)).sort()).toEqual([...DEFAULT_ORDER].sort());
    }
  });
});

describe('clipSegment', () => {
  const box = { x: 20, y: 20, w: 160, h: 60 };

  it('keeps a segment that is inside', () => {
    expect(clipSegment([30, 30], [100, 60], box)).toEqual([
      [30, 30],
      [100, 60],
    ]);
  });

  it('cuts a segment at the edges', () => {
    expect(clipSegment([0, 50], [200, 50], box)).toEqual([
      [20, 50],
      [180, 50],
    ]);
    expect(clipSegment([100, 0], [100, 500], box)).toEqual([
      [100, 20],
      [100, 80],
    ]);
  });

  it('gives nothing for a segment that misses the box', () => {
    expect(clipSegment([0, 5], [200, 5], box)).toBeNull();
    expect(clipSegment([0, 0], [10, 100], box)).toBeNull();
  });

  it('gives nothing when the box has no size', () => {
    expect(clipSegment([0, 5], [200, 5], { x: 10, y: 10, w: 0, h: -4 })).toBeNull();
  });
});
