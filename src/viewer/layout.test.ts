import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER,
  GAP,
  LAYOUTS,
  assignView,
  clipSegment,
  formatOrder,
  growthPlan,
  paneGrowth,
  paneRects,
  parseLayout,
  parseOrder,
  placeViews,
  stepGrowth,
  totalGrowth,
  type Growth,
  type ViewPlan,
  swapViews,
  type LayoutId,
  type Rect,
  type ViewOrder,
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

describe('paneGrowth', () => {
  const square = { w: 100, h: 100 };

  it('is how many times larger an image that fits the pane becomes', () => {
    expect(paneGrowth({ w: 400, h: 300 }, { w: 800, h: 900 }, square)).toBeCloseTo(8 / 3, 10);
    expect(paneGrowth({ w: 400, h: 300 }, { w: 1600, h: 600 }, square)).toBe(2);
  });

  it('counts the room a narrow pane gains sideways', () => {
    // Three side by side to one alone: the same height, three times the width.
    expect(paneGrowth({ w: 300, h: 600 }, { w: 900, h: 600 }, square)).toBe(2);
  });

  it('follows the shape of the image', () => {
    expect(paneGrowth({ w: 400, h: 300 }, { w: 800, h: 900 }, { w: 200, h: 100 })).toBe(2);
    expect(paneGrowth({ w: 400, h: 300 }, { w: 800, h: 900 }, { w: 100, h: 200 })).toBe(3);
  });

  it('is undone by the way back', () => {
    const small = { w: 483, h: 344 };
    const large = { w: 968, h: 690 };
    const image = { w: 250, h: 180 };
    expect(paneGrowth(small, large, image) * paneGrowth(large, small, image)).toBeCloseTo(1, 12);
  });

  it('is one when the size is the same or anything has no size', () => {
    expect(paneGrowth({ w: 400, h: 300 }, { w: 400, h: 300 }, square)).toBe(1);
    expect(paneGrowth({ w: 0, h: 300 }, { w: 400, h: 300 }, square)).toBe(1);
    expect(paneGrowth({ w: 400, h: 300 }, { w: 400, h: 0 }, square)).toBe(1);
    expect(paneGrowth({ w: 400, h: 300 }, { w: 800, h: 600 }, { w: 0, h: 100 })).toBe(1);
  });
});

describe('growthPlan', () => {
  const W = 1002;
  const H = 602;
  const size = (r: Rect) => ({ w: r.w, h: r.h });
  const grid = paneRects('grid', W, H).map(size);
  const focus = paneRects('focus', W, H).map(size);
  const full = { w: W, h: H };

  it('enlarges nothing in the layouts that have no large pane', () => {
    for (const layout of ['grid', 'three', 'two', 'single'] as LayoutId[]) {
      const plan = growthPlan(layout, DEFAULT_ORDER, null, W, H);
      const panes = paneRects(layout, W, H).map(size);
      expect(Object.keys(plan)).toEqual(DEFAULT_ORDER.slice(0, panes.length));
      panes.forEach((pane, i) => expect(plan[DEFAULT_ORDER[i]]).toEqual({ home: pane, enlarge: {} }));
    }
  });

  it('enlarges the view in the large pane from the pane it has in 2 × 2', () => {
    const plan = growthPlan('focus', DEFAULT_ORDER, null, W, H);
    expect(plan.axial).toEqual({ home: grid[0], enlarge: { large: { from: grid[0], to: focus[0] } } });
    // The stacked views are not enlarged, and their images are sized as in 2 × 2.
    expect(plan.sagittal).toEqual({ home: grid[1], enlarge: {} });
    expect(plan.coronal).toEqual({ home: grid[2], enlarge: {} });
    expect(plan.volume3d).toEqual({ home: grid[3], enlarge: {} });
  });

  it('follows the view order: whichever view is first is the large one', () => {
    const order: ViewOrder = ['coronal', 'sagittal', 'axial', 'volume3d'];
    const plan = growthPlan('focus', order, null, W, H);
    expect(plan.coronal?.enlarge.large).toEqual({ from: grid[0], to: focus[0] });
    expect(plan.axial?.enlarge).toEqual({});
  });

  it('enlarges a maximised view from the pane it has in the layout', () => {
    expect(growthPlan('grid', DEFAULT_ORDER, 'coronal', W, H).coronal).toEqual({ home: grid[2], enlarge: { maximised: { from: grid[2], to: full } } });
    const three = paneRects('three', W, H).map(size);
    expect(growthPlan('three', DEFAULT_ORDER, 'sagittal', W, H).sagittal).toEqual({ home: three[1], enlarge: { maximised: { from: three[1], to: full } } });
    // A stacked view of 1 large and 3 stacked grows from its small pane.
    expect(growthPlan('focus', DEFAULT_ORDER, 'sagittal', W, H).sagittal).toEqual({ home: grid[1], enlarge: { maximised: { from: focus[1], to: full } } });
  });

  it('puts maximise on top of the large pane', () => {
    const plan = growthPlan('focus', DEFAULT_ORDER, 'axial', W, H);
    expect(plan.axial).toEqual({ home: grid[0], enlarge: { large: { from: grid[0], to: focus[0] }, maximised: { from: focus[0], to: full } } });
  });

  it('keeps the plan of the views a maximised one hides', () => {
    const plan = growthPlan('focus', DEFAULT_ORDER, 'sagittal', W, H);
    expect(plan.axial?.enlarge.large).toEqual({ from: grid[0], to: focus[0] });
  });

  it('does not enlarge a maximised view the layout has no pane for', () => {
    expect(growthPlan('two', DEFAULT_ORDER, 'coronal', W, H).coronal).toEqual({ home: full, enlarge: { maximised: { from: full, to: full } } });
  });

  it('is empty for an empty area', () => {
    expect(growthPlan('focus', DEFAULT_ORDER, null, 0, 600)).toEqual({});
  });
});

describe('stepGrowth', () => {
  const square = { w: 100, h: 100 };
  const quad = { w: 500, h: 300 };
  const large = { w: 750, h: 600 };
  const full = { w: 1000, h: 600 };
  const inLarge = { large: { from: quad, to: large } };
  const maximised = { maximised: { from: quad, to: full } };
  const both = { large: { from: quad, to: large }, maximised: { from: large, to: full } };

  /** Walks a view through the states in turn, with the scale it would have on screen. */
  function walk(steps: ViewPlan['enlarge'][], start: Growth = {}, image = square) {
    let held = start;
    let mmPerPx = 1;
    const seen: number[] = [];
    for (const want of steps) {
      const step = stepGrowth(held, want, image);
      held = step.held;
      mmPerPx /= step.factor;
      seen.push(mmPerPx);
    }
    return { held, mmPerPx, seen };
  }

  it('grows a view that enters the large pane by as much as its pane grew, and remembers it', () => {
    expect(stepGrowth({}, inLarge, square)).toEqual({ held: { large: 2 }, factor: 2 });
  });

  it('shrinks it by the remembered amount when it leaves, whatever the panes are by then', () => {
    expect(stepGrowth({ large: 2 }, {}, square)).toEqual({ held: {}, factor: 0.5 });
    expect(stepGrowth({ large: 1.7 }, {}, square)).toEqual({ held: {}, factor: 1 / 1.7 });
  });

  it('changes nothing while the state stays, even when the panes change size', () => {
    const resized = { large: { from: { w: 300, h: 200 }, to: { w: 900, h: 800 } } };
    expect(stepGrowth({ large: 2 }, resized, square)).toEqual({ held: { large: 2 }, factor: 1 });
    expect(stepGrowth({}, {}, square)).toEqual({ held: {}, factor: 1 });
  });

  it('grows a maximised view, and puts maximise on top of the large pane', () => {
    expect(stepGrowth({}, maximised, square)).toEqual({ held: { maximised: 2 }, factor: 2 });
    const tall = { w: 100, h: 50 };
    const step = stepGrowth({ large: 1.5 }, both, tall);
    expect(step.held.large).toBe(1.5);
    expect(step.held.maximised).toBeCloseTo(1000 / 750, 12);
    expect(step.factor).toBeCloseTo(1000 / 750, 12);
  });

  it('enters both at once for a view that is maximised as it comes into the large pane', () => {
    const tall = { w: 100, h: 50 };
    const step = stepGrowth({}, both, tall);
    expect(step.held.large).toBe(1.5);
    expect(step.factor).toBeCloseTo(2, 12);
  });

  it('returns to the starting scale after any round trip', () => {
    const trips: ViewPlan['enlarge'][][] = [
      [inLarge, {}],
      [maximised, {}],
      [inLarge, both, inLarge, {}],
      [inLarge, both, {}],
      [both, inLarge, {}],
      [inLarge, {}, inLarge, {}, maximised, {}],
      // Maximised in 2 × 2, the layout changed underneath to put it in the large pane, then restored and back.
      [maximised, both, inLarge, {}],
      // And the other way: maximised in the large pane, back to 2 × 2 underneath.
      [inLarge, both, maximised, {}],
    ];
    for (const image of [square, { w: 100, h: 37 }, { w: 61, h: 100 }]) {
      for (const trip of trips) {
        const end = walk(trip, {}, image);
        expect(end.held).toEqual({});
        expect(end.mmPerPx).toBeCloseTo(1, 12);
      }
    }
  });

  it('leaves a maximised view as it is on screen when the layout changes underneath it', () => {
    const under = walk([maximised, both]);
    expect(under.seen[1]).toBe(under.seen[0]);
    // Restored, it is as large as the large pane makes it.
    expect(walk([maximised, both, inLarge]).mmPerPx).toBeCloseTo(walk([inLarge]).mmPerPx, 12);
    const out = walk([inLarge, both, maximised]);
    expect(out.seen[2]).toBe(out.seen[1]);
  });

  it('does not depend on a zoom of the user in between: only the remembered factor is undone', () => {
    const into = stepGrowth({}, inLarge, square);
    const out = stepGrowth(into.held, {}, square);
    const zoomed = 0.37;
    expect((zoomed / into.factor) / out.factor).toBeCloseTo(zoomed, 12);
  });

  it('gives the same result for a view fitted in the large pane as for one that came from 2 × 2', () => {
    // Opened in 2 × 2: fitted to the quadrant, then enlarged.
    const fromGrid = (100 / 300) / stepGrowth({}, inLarge, square).factor;
    // Opened in the large pane: fitted to it, with the growth recorded.
    const opened = stepGrowth({}, inLarge, square);
    const fitted = 100 / 600;
    expect(fitted).toBeCloseTo(fromGrid, 12);
    expect(fitted / stepGrowth(opened.held, {}, square).factor).toBeCloseTo(100 / 300, 12);
  });

  it('counts an empty size as no growth', () => {
    expect(stepGrowth({}, { large: { from: { w: 0, h: 0 }, to: large } }, square)).toEqual({ held: { large: 1 }, factor: 1 });
  });
});

describe('totalGrowth', () => {
  it('is the product of what is held, and one for nothing', () => {
    expect(totalGrowth({})).toBe(1);
    expect(totalGrowth({ large: 2 })).toBe(2);
    expect(totalGrowth({ large: 2, maximised: 1.5 })).toBe(3);
  });
});
