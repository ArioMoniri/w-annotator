import { expect, test, type Page } from '@playwright/test';
import { drag, jumpToVoxel, maskVoxels, openPhantom, tintedPixels } from './helpers';

type Box = { view: string; x: number; y: number; w: number; h: number };

/** The viewport area and the views on screen, in pixels relative to the area. */
async function panes(page: Page): Promise<{ w: number; h: number; cells: Box[] }> {
  return page.evaluate(() => {
    const area = document.querySelector('.views')!.getBoundingClientRect();
    const cells = [...document.querySelectorAll<HTMLElement>('.cell')]
      .filter((c) => c.getClientRects().length > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { view: c.dataset.view!, x: r.x - area.x, y: r.y - area.y, w: r.width, h: r.height };
      });
    // In reading order, which is pane order.
    cells.sort((p, q) => p.y - q.y || p.x - q.x);
    return { w: area.width, h: area.height, cells };
  });
}

/** Pixels of the area that no view covers, and pixels covered more than once. */
function coverage(area: { w: number; h: number; cells: Box[] }): { bare: number; doubled: number } {
  const seen = new Uint8Array(area.w * area.h);
  let doubled = 0;
  for (const c of area.cells) {
    for (let y = c.y; y < c.y + c.h; y++)
      for (let x = c.x; x < c.x + c.w; x++) {
        if (seen[y * area.w + x]) doubled++;
        seen[y * area.w + x] = 1;
      }
  }
  let bare = 0;
  for (const v of seen) if (!v) bare++;
  return { bare, doubled };
}

const layoutButton = (page: Page, name: string) => page.getByRole('group', { name: 'Layout' }).getByRole('button', { name });

type ViewState = {
  mmPerPx: number;
  centre: [number, number, number];
  slice: number;
  voi: { lower: number; upper: number };
};

/** Zoom as millimetres per screen pixel, the world point at the centre of the view, its slice and its window. */
async function viewState(page: Page, view: string): Promise<ViewState> {
  return page.evaluate((view) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    const r = document.querySelector(`[data-view="${view}"]`)!.getBoundingClientRect();
    const a = w.engine.canvasToWorld(view, 0, 0) as number[];
    const b = w.engine.canvasToWorld(view, 100, 0) as number[];
    return {
      mmPerPx: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 100,
      centre: w.engine.canvasToWorld(view, r.width / 2, r.height / 2),
      slice: w.engine.getSlice(view).index,
      voi: w.engine.getVoi(view),
    };
  }, view);
}

function expectSameView(after: ViewState, before: ViewState, what = ''): void {
  expect(after.mmPerPx, `${what} zoom`).toBeCloseTo(before.mmPerPx, 4);
  // Half a pixel of the view, in millimetres: the centre of an odd-sized view falls between two pixels.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(after.centre[i] - before.centre[i]), `${what} centre ${after.centre} was ${before.centre}`).toBeLessThanOrEqual(before.mmPerPx * 0.51);
  }
  expect(after.slice, `${what} slice`).toBe(before.slice);
  expect(after.voi.lower).toBeCloseTo(before.voi.lower, 3);
  expect(after.voi.upper).toBeCloseTo(before.voi.upper, 3);
}

/**
 * Records every frame in which a canvas on screen has a backing size that differs from its
 * box, that is, a frame in which the image would be drawn stretched.
 */
async function watchForStretch(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { __stretched: string[] }).__stretched = log;
    const tick = () => {
      for (const c of document.querySelectorAll<HTMLCanvasElement>('.cell canvas.cornerstone-canvas')) {
        if (!c.clientWidth || !c.clientHeight) continue;
        const w = Math.round(c.clientWidth * devicePixelRatio);
        const h = Math.round(c.clientHeight * devicePixelRatio);
        if (c.width !== w || c.height !== h) log.push(`${c.closest<HTMLElement>('.cell')!.dataset.view}: ${c.width}×${c.height} drawn in ${w}×${h}`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as unknown as { __stretched: string[] }).__stretched);
}

/** The reference lines drawn in a view: each with its colour and its end points. */
async function referenceLines(page: Page, view: string): Promise<{ color: string; a: [number, number]; b: [number, number] }[]> {
  return page.evaluate((view) => {
    const lines = [...document.querySelectorAll<SVGLineElement>(`[data-view="${view}"] svg.svg-layer line`)];
    return lines
      .map((l) => {
        const n = (name: string) => Number(l.getAttribute(name));
        return {
          color: (l.getAttribute('stroke') ?? '').toUpperCase(),
          a: [n('x1'), n('y1')] as [number, number],
          b: [n('x2'), n('y2')] as [number, number],
        };
      })
      .filter((l) => ['#E5B454', '#6FD3A3', '#7AB0FF'].includes(l.color) && Math.hypot(l.a[0] - l.b[0], l.a[1] - l.b[1]) > 1);
  }, view);
}

const AXIAL = '#E5B454';
const SAGITTAL = '#6FD3A3';
const CORONAL = '#7AB0FF';

test('every layout tiles the viewport area with no gap and no overlap', async ({ page }) => {
  await openPhantom(page);
  const cases: [string, string[], (a: { w: number; h: number; cells: Box[] }) => number][] = [
    ['2 × 2', ['axial', 'sagittal', 'coronal', 'volume3d'], (a) => 2 * a.w + 2 * a.h - 4],
    ['1 large and 3 stacked', ['axial', 'sagittal', 'coronal', 'volume3d'], (a) => 2 * a.h + 4 * a.cells[1].w],
    ['3 side by side', ['axial', 'sagittal', 'coronal'], (a) => 4 * a.h],
    ['2 side by side', ['axial', 'sagittal'], (a) => 2 * a.h],
    ['Single view', ['axial'], () => 0],
  ];
  for (const [name, views, gutters] of cases) {
    await layoutButton(page, name).click();
    await expect(layoutButton(page, name)).toHaveAttribute('aria-pressed', 'true');
    const area = await panes(page);
    expect(area.cells.map((c) => c.view), name).toEqual(views);
    for (const c of area.cells) for (const v of [c.x, c.y, c.w, c.h]) expect(Number.isInteger(v), `${name}: whole pixels`).toBe(true);
    const { bare, doubled } = coverage(area);
    expect(doubled, `${name}: overlap`).toBe(0);
    expect(bare, `${name}: uncovered pixels are the 2 px gutters only`).toBe(gutters(area));
    expect(Math.max(...area.cells.map((c) => c.x + c.w)), `${name}: reaches the right edge`).toBe(area.w);
    expect(Math.max(...area.cells.map((c) => c.y + c.h)), `${name}: reaches the bottom edge`).toBe(area.h);
    // Each view on screen has drawn into a canvas of exactly its own size.
    for (const c of area.cells) {
      const canvas = page.locator(`[data-view="${c.view}"] canvas.cornerstone-canvas`);
      expect(await canvas.evaluate((el: HTMLCanvasElement) => [el.width, el.height]), `${name}: ${c.view} canvas`).toEqual([c.w, c.h]);
    }
  }
  // The large pane of the focus layout is on the left and takes three quarters.
  await layoutButton(page, '1 large and 3 stacked').click();
  const focus = await panes(page);
  expect(focus.cells[0].x).toBe(0);
  expect(focus.cells[0].h).toBe(focus.h);
  expect(focus.cells[0].w / focus.w).toBeCloseTo(0.75, 2);
});

test('the layout switcher sits in the middle of the top bar', async ({ page }) => {
  await openPhantom(page);
  const group = (await page.getByRole('group', { name: 'Layout' }).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(Math.abs(group.x + group.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(1);
  expect(await page.getByRole('group', { name: 'Layout' }).getByRole('button').count()).toBe(5);
});

test('maximise fills the whole area from any layout, and restores it', async ({ page }) => {
  await openPhantom(page);
  const filled = async (view: string) => {
    const area = await panes(page);
    expect(area.cells).toEqual([{ view, x: 0, y: 0, w: area.w, h: area.h }]);
  };
  for (const name of ['2 × 2', '1 large and 3 stacked', '3 side by side']) {
    await layoutButton(page, name).click();
    const before = await panes(page);

    await page.locator('[data-view="sagittal"]').dblclick({ position: { x: 60, y: 90 } });
    await filled('sagittal');
    await page.keyboard.press('Escape');
    expect(await panes(page)).toEqual(before);

    await page.locator('[data-view="coronal"]').hover();
    await page.locator('[data-view="coronal"]').getByRole('button', { name: 'Maximise' }).click();
    await filled('coronal');
    await page.locator('[data-view="coronal"]').getByRole('button', { name: 'Restore' }).click();
    expect(await panes(page)).toEqual(before);

    await page.locator('[data-view="axial"]').click({ position: { x: 60, y: 90 } });
    await page.keyboard.press('m');
    await filled('axial');
    await page.keyboard.press('m');
    expect(await panes(page)).toEqual(before);
  }
  // Picking a layout while a view is maximised leaves maximise.
  await page.locator('[data-view="axial"]').dblclick({ position: { x: 60, y: 90 } });
  await layoutButton(page, '2 side by side').click();
  expect((await panes(page)).cells.map((c) => c.view)).toEqual(['axial', 'sagittal']);
});

test('the view picker on a pane swaps two views', async ({ page }) => {
  await openPhantom(page);
  const before = await panes(page);
  const boxOf = (area: { cells: Box[] }, view: string) => {
    const { x, y, w, h } = area.cells.find((c) => c.view === view)!;
    return { x, y, w, h };
  };

  await page.locator('[data-view="axial"]').getByRole('button', { name: 'Axial' }).click();
  const menu = page.getByRole('menu', { name: 'View in this pane' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Axial', 'Sagittal', 'Coronal', '3D']);
  await expect(menu.getByRole('menuitemradio', { name: 'Axial' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Coronal' }).click();
  await expect(menu).toHaveCount(0);

  let after = await panes(page);
  expect(boxOf(after, 'coronal')).toEqual(boxOf(before, 'axial'));
  expect(boxOf(after, 'axial')).toEqual(boxOf(before, 'coronal'));
  expect(boxOf(after, 'sagittal')).toEqual(boxOf(before, 'sagittal'));
  // No view is on screen twice.
  expect(after.cells.map((c) => c.view).sort()).toEqual(['axial', 'coronal', 'sagittal', 'volume3d']);

  // A view the layout leaves out can be brought in; the one it replaces goes out.
  await layoutButton(page, '2 side by side').click();
  expect((await panes(page)).cells.map((c) => c.view)).toEqual(['coronal', 'sagittal']);
  await page.locator('[data-view="sagittal"]').getByRole('button', { name: 'Sagittal' }).click();
  await menu.getByRole('menuitemradio', { name: '3D' }).click();
  after = await panes(page);
  expect(after.cells.map((c) => c.view).sort()).toEqual(['coronal', 'volume3d']);
  expect(boxOf(after, 'volume3d').x).toBeGreaterThan(0);

  // Escape closes the picker without changing anything.
  await page.locator('[data-view="coronal"]').getByRole('button', { name: 'Coronal' }).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await panes(page)).toEqual(after);
});

test('dragging a pane label onto another pane swaps the two', async ({ page }) => {
  await openPhantom(page);
  const before = await panes(page);
  const from = (await page.locator('[data-view="axial"]').getByRole('button', { name: 'Axial' }).boundingBox())!;
  const to = (await page.locator('[data-view="volume3d"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await expect(page.locator('[data-view="volume3d"]')).toHaveAttribute('data-drop', 'true');
  await page.mouse.up();
  const after = await panes(page);
  const at = (area: { cells: Box[] }, view: string) => area.cells.find((c) => c.view === view)!;
  expect([at(after, 'axial').x, at(after, 'axial').y]).toEqual([at(before, 'volume3d').x, at(before, 'volume3d').y]);
  expect([at(after, 'volume3d').x, at(after, 'volume3d').y]).toEqual([0, 0]);
  // The drag did not open the picker.
  await expect(page.getByRole('menu', { name: 'View in this pane' })).toHaveCount(0);
});

test('slice, zoom, window and mask survive every layout change', async ({ page }) => {
  await openPhantom(page);
  await jumpToVoxel(page, [30, 22, 21]);
  await page.keyboard.press('z');
  await drag(page, 'axial', [0, 40], [0, -30]);
  await drag(page, 'sagittal', [0, 30], [0, -10]);
  await page.keyboard.press('c');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.session.setVoi(-150, 420));
  await page.waitForTimeout(300);

  // The same canvases stay in use: the viewer is not rebuilt.
  await page.evaluate(() => document.querySelectorAll('.cell canvas.cornerstone-canvas').forEach((c) => ((c as unknown as { kept: boolean }).kept = true)));
  const views = ['axial', 'sagittal', 'coronal'];
  const before = Object.fromEntries(await Promise.all(views.map(async (v) => [v, await viewState(page, v)] as const)));
  expect(before.axial.slice).not.toBe(24);
  expect(before.axial.mmPerPx).not.toBeCloseTo(before.coronal.mmPerPx, 3);
  const voxels = await maskVoxels(page);
  const tinted = await tintedPixels(page, 'axial');
  expect(tinted).toBeGreaterThan(0);

  const stretched = await watchForStretch(page);
  for (const name of ['1 large and 3 stacked', '3 side by side', '2 side by side', 'Single view', '2 × 2']) {
    await layoutButton(page, name).click();
    const shown = (await panes(page)).cells.map((c) => c.view).filter((v) => v !== 'volume3d');
    for (const v of shown) expectSameView(await viewState(page, v), before[v], `${name}, ${v}:`);
  }
  // Not a double-click: with the crosshair tool a click moves the other two views, as it should.
  await page.locator('[data-view="coronal"]').hover();
  await page.locator('[data-view="coronal"]').getByRole('button', { name: 'Maximise' }).click();
  expectSameView(await viewState(page, 'coronal'), before.coronal);
  await page.keyboard.press('Escape');
  for (const v of views) expectSameView(await viewState(page, v), before[v]);

  await page.waitForTimeout(300);
  expect(await stretched()).toEqual([]);
  expect(await maskVoxels(page)).toBe(voxels);
  // Same zoom, same slice, same mask: the same pixels are tinted, give or take the edge of the outline.
  expect(Math.abs((await tintedPixels(page, 'axial')) - tinted)).toBeLessThanOrEqual(tinted * 0.02);
  expect(await page.evaluate(() => [...document.querySelectorAll('.cell canvas.cornerstone-canvas')].every((c) => (c as unknown as { kept?: boolean }).kept))).toBe(true);
  // The tool still works after all of it.
  await page.keyboard.press('b');
  await drag(page, 'axial', [0, 20], [12, 20]);
  expect(await maskVoxels(page)).toBeGreaterThan(voxels);
});

test('opening and closing the segments panel keeps zoom and centre', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('z');
  await drag(page, 'axial', [0, 40], [0, -25]);
  await page.keyboard.press('c');
  const views = ['axial', 'sagittal', 'coronal'];
  const before = await Promise.all(views.map((v) => viewState(page, v)));
  const widthBefore = (await panes(page)).w;
  const stretched = await watchForStretch(page);

  await page.getByRole('button', { name: 'Hide segments' }).click();
  expect((await panes(page)).w).toBeGreaterThan(widthBefore + 200);
  for (const [i, v] of views.entries()) expectSameView(await viewState(page, v), before[i]);

  await page.getByRole('button', { name: 'Show segments' }).click();
  expect((await panes(page)).w).toBe(widthBefore);
  for (const [i, v] of views.entries()) expectSameView(await viewState(page, v), before[i]);

  await page.keyboard.press('Control+\\');
  await page.keyboard.press('Control+\\');
  for (const [i, v] of views.entries()) expectSameView(await viewState(page, v), before[i]);
  await page.waitForTimeout(200);
  expect(await stretched()).toEqual([]);
});

test('resizing the window keeps zoom and centre', async ({ page }) => {
  await openPhantom(page);
  const views = ['axial', 'sagittal', 'coronal'];
  const before = await Promise.all(views.map((v) => viewState(page, v)));
  const stretched = await watchForStretch(page);
  for (const size of [
    { width: 1500, height: 1000 },
    { width: 1100, height: 660 },
    { width: 1024, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const area = await panes(page);
    expect(coverage(area).bare).toBe(2 * area.w + 2 * area.h - 4);
    for (const [i, v] of views.entries()) expectSameView(await viewState(page, v), before[i]);
  }
  expect(await stretched()).toEqual([]);
  // Fit is still there for when the user does want the image to fill the view.
  await page.keyboard.press('z');
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(200);
  expect((await viewState(page, 'axial')).mmPerPx).toBeCloseTo(before[0].mmPerPx, 3);
});

test('a view that is off screen is not drawn, and returns at the same slice and zoom', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('z');
  await drag(page, 'coronal', [0, 40], [0, -20]);
  await page.keyboard.press('c');
  const before = await viewState(page, 'coronal');

  await layoutButton(page, '2 side by side').click();
  await expect(page.locator('[data-view="coronal"]')).toBeHidden();
  await page.evaluate(() => {
    const counts: Record<string, number> = {};
    (window as unknown as { __rendered: Record<string, number> }).__rendered = counts;
    for (const cell of document.querySelectorAll<HTMLElement>('.cell')) {
      cell.querySelector('.canvas')!.addEventListener('CORNERSTONE_IMAGE_RENDERED', () => {
        counts[cell.dataset.view!] = (counts[cell.dataset.view!] ?? 0) + 1;
      });
    }
  });
  await jumpToVoxel(page, [20, 30, 17]);
  await page.locator('[data-view="axial"]').hover();
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(400);
  const rendered = await page.evaluate(() => (window as unknown as { __rendered: Record<string, number> }).__rendered);
  expect(rendered.axial).toBeGreaterThan(0);
  expect(rendered.coronal ?? 0).toBe(0);
  expect(rendered.volume3d ?? 0).toBe(0);

  await layoutButton(page, '2 × 2').click();
  const after = await viewState(page, 'coronal');
  expect(after.mmPerPx).toBeCloseTo(before.mmPerPx, 4);
  // It followed the jump made while it was away.
  expect(after.slice).toBe(30);
  expect(await tintedPixels(page, 'coronal')).toBeGreaterThanOrEqual(0);
  const drawn = await page.locator('[data-view="coronal"] canvas.cornerstone-canvas').evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 40) lit++;
    return lit;
  });
  expect(drawn).toBeGreaterThan(500);
});

test('a view opened in a layout that hides it is fitted when it first appears', async ({ page }) => {
  await openPhantom(page);
  const fitted = await viewState(page, 'coronal');
  await layoutButton(page, 'Single view').click();
  await page.waitForTimeout(100);
  // Reopen the image in this layout: only the axial view is on screen while it loads.
  await openPhantom(page);
  await expect(layoutButton(page, 'Single view')).toHaveAttribute('aria-pressed', 'true');
  expect((await panes(page)).cells.map((c) => c.view)).toEqual(['axial']);
  await layoutButton(page, '2 × 2').click();
  const after = await viewState(page, 'coronal');
  expect(after.mmPerPx).toBeCloseTo(fitted.mmPerPx, 3);
  expect(after.slice).toBe(fitted.slice);
});

test('each layout has a shortcut, and the layout and view order are remembered', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('Control+3');
  await expect(layoutButton(page, '3 side by side')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+5');
  expect((await panes(page)).cells.map((c) => c.view)).toEqual(['axial']);
  await page.keyboard.press('Control+4');
  await page.keyboard.press('Control+1');
  await expect(layoutButton(page, '2 × 2')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+2');
  await page.locator('[data-view="axial"]').getByRole('button', { name: 'Axial' }).click();
  await page.getByRole('menuitemradio', { name: '3D' }).click();
  const before = await panes(page);
  expect(before.cells.find((c) => c.view === 'volume3d')!.x).toBe(0);

  await openPhantom(page);
  await expect(layoutButton(page, '1 large and 3 stacked')).toHaveAttribute('aria-pressed', 'true');
  expect(await panes(page)).toEqual(before);
  await expect(layoutButton(page, '1 large and 3 stacked')).toHaveAttribute('data-tip', /Ctrl\+2|⌘ 2/);
});

test('reference lines show on hover, leave the centre and the edges clear, and follow the setting', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('h');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  expect(await referenceLines(page, 'axial')).toEqual([]);

  await page.locator('[data-view="sagittal"]').hover();
  await expect.poll(async () => (await referenceLines(page, 'axial')).length).toBe(4);
  for (const [view, others] of [
    ['axial', [SAGITTAL, CORONAL]],
    ['sagittal', [AXIAL, CORONAL]],
    ['coronal', [AXIAL, SAGITTAL]],
  ] as const) {
    const lines = await referenceLines(page, view);
    // Two halves for each of the other two planes, none for the view's own.
    expect(lines.map((l) => l.color).sort(), view).toEqual([others[0], others[0], others[1], others[1]].sort());
    const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
    const cx = box.width / 2;
    const cy = box.height / 2;
    for (const l of lines) {
      for (const [x, y] of [l.a, l.b]) {
        expect(Math.hypot(x - cx, y - cy), `${view}: gap at the centre`).toBeGreaterThanOrEqual(20);
        expect(x, `${view}: clear of the left letter`).toBeGreaterThanOrEqual(28);
        expect(x, `${view}: clear of the right letter`).toBeLessThanOrEqual(box.width - 28);
        expect(y, `${view}: clear of the top letter`).toBeGreaterThanOrEqual(28);
        expect(y, `${view}: clear of the bottom letter`).toBeLessThanOrEqual(box.height - 28);
      }
      expect(Math.hypot(l.a[0] - l.b[0], l.a[1] - l.b[1]), `${view}: the line is long enough to see`).toBeGreaterThan(60);
    }
  }

  await page.mouse.move(5, 5);
  await expect.poll(async () => (await referenceLines(page, 'axial')).length).toBe(0);

  // Settings: always.
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  const choice = page.getByRole('group', { name: 'Show reference lines' });
  await expect(choice.getByRole('button', { name: 'On hover' })).toHaveAttribute('aria-pressed', 'true');
  await choice.getByRole('button', { name: 'Always' }).click();
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await referenceLines(page, 'coronal')).length).toBe(4);

  // Settings: with the crosshair tool only.
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await choice.getByRole('button', { name: 'With crosshair tool only' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-view="sagittal"]').hover();
  await expect.poll(async () => (await referenceLines(page, 'coronal')).length).toBe(0);
  await page.keyboard.press('c');
  await expect.poll(async () => (await referenceLines(page, 'coronal')).length).toBe(4);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  expect((await referenceLines(page, 'coronal')).length).toBe(4);
});

test('reference lines mark only the planes on screen', async ({ page }) => {
  await openPhantom(page);
  await layoutButton(page, '2 side by side').click();
  await page.locator('[data-view="axial"]').hover();
  await expect.poll(async () => (await referenceLines(page, 'axial')).map((l) => l.color)).toEqual([SAGITTAL, SAGITTAL]);
  expect((await referenceLines(page, 'sagittal')).map((l) => l.color)).toEqual([AXIAL, AXIAL]);
  await layoutButton(page, 'Single view').click();
  await page.locator('[data-view="axial"]').hover();
  await page.waitForTimeout(300);
  expect(await referenceLines(page, 'axial')).toEqual([]);
});

test('dragging a reference line scrolls the plane it stands for, and nothing else', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('h');
  await page.locator('[data-view="axial"]').hover();
  await expect.poll(async () => (await referenceLines(page, 'axial')).length).toBe(4);
  const before = {
    axial: await viewState(page, 'axial'),
    sagittal: await viewState(page, 'sagittal'),
    coronal: await viewState(page, 'coronal'),
  };
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  const line = (await referenceLines(page, 'axial')).find((l) => l.color === SAGITTAL)!;
  // The sagittal plane is a vertical line in the axial view.
  expect(Math.abs(line.a[0] - line.b[0])).toBeLessThan(1);
  const x = box.x + line.a[0];
  const y = box.y + (line.a[1] + line.b[1]) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y, { steps: 9 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = {
    axial: await viewState(page, 'axial'),
    sagittal: await viewState(page, 'sagittal'),
    coronal: await viewState(page, 'coronal'),
  };
  const moved = Math.round(45 * before.axial.mmPerPx);
  expect(Math.abs(after.sagittal.slice - before.sagittal.slice)).toBeGreaterThanOrEqual(moved - 1);
  expect(Math.abs(after.sagittal.slice - before.sagittal.slice)).toBeLessThanOrEqual(moved + 1);
  expect(after.coronal.slice).toBe(before.coronal.slice);
  // The pan tool did not pan: the line took the drag.
  expectSameView(after.axial, before.axial);
  // The line followed.
  const now = (await referenceLines(page, 'axial')).find((l) => l.color === SAGITTAL)!;
  expect(Math.abs(now.a[0] - (line.a[0] + 45))).toBeLessThanOrEqual(2);
  // The planes stay orthogonal: no line can be turned.
  for (const l of await referenceLines(page, 'axial')) expect(Math.min(Math.abs(l.a[0] - l.b[0]), Math.abs(l.a[1] - l.b[1]))).toBeLessThan(0.5);
});

test('a brush stroke that starts on a reference line still paints', async ({ page }) => {
  await openPhantom(page);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.settings.setSetting('referenceLines', 'always'));
  await page.keyboard.press('b');
  await expect.poll(async () => (await referenceLines(page, 'axial')).length).toBe(4);
  const sagittal = (await viewState(page, 'sagittal')).slice;
  const voxels = await maskVoxels(page);
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  const line = (await referenceLines(page, 'axial')).find((l) => l.color === SAGITTAL)!;
  const x = box.x + line.a[0];
  const y = box.y + (line.a[1] + line.b[1]) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await maskVoxels(page)).toBeGreaterThan(voxels);
  expect((await viewState(page, 'sagittal')).slice).toBe(sagittal);
});

test('the 3D view shows whole segments and follows every mask change', async ({ page }) => {
  await openPhantom(page);
  const shown = async () => {
    await page.waitForTimeout(700);
    return tintedPixels(page, 'volume3d');
  };
  // Two balls of 5 and 4 voxels radius, seen whole: their silhouettes, not one cut through them.
  const start = await shown();
  const box = (await page.locator('[data-view="volume3d"]').boundingBox())!;
  const pxPerVoxel = Math.min(box.width, box.height) / (48 * 1.1);
  const silhouettes = Math.PI * (25 + 16) * pxPerVoxel * pxPerVoxel;
  expect(start).toBeGreaterThan(silhouettes * 0.8);
  expect(start).toBeLessThan(silhouettes * 1.3);

  // A new segment, painted on two axial slices well away from the middle of the volume.
  await page.keyboard.press('n');
  await page.keyboard.press('b');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.session.setBrushSize(14));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.engine.scrollSlices('axial', -14));
  await drag(page, 'axial', [-20, 60], [20, 60]);
  const oneStroke = await shown();
  expect(oneStroke).toBeGreaterThan(start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.engine.scrollSlices('axial', 24));
  await drag(page, 'axial', [-20, 60], [20, 60]);
  const twoStrokes = await shown();
  expect(twoStrokes).toBeGreaterThan(oneStroke);

  // Fill between slices changes the mask outside the tools; the 3D view shows the solid it made.
  const voxels = await maskVoxels(page);
  await page.keyboard.press('i');
  await page.keyboard.press('Enter');
  const filled = await shown();
  expect(await maskVoxels(page)).toBeGreaterThan(voxels * 3);
  expect(filled).toBeGreaterThan(twoStrokes * 2);

  await page.keyboard.press('Control+z');
  expect(Math.abs((await shown()) - twoStrokes)).toBeLessThanOrEqual(twoStrokes * 0.02);
  await page.keyboard.press('Control+Shift+z');
  expect(Math.abs((await shown()) - filled)).toBeLessThanOrEqual(filled * 0.02);

  // Hiding the mask empties the view; showing it brings the segments back.
  await page.keyboard.press('x');
  expect(await shown()).toBe(0);
  await page.keyboard.press('x');
  expect(Math.abs((await shown()) - filled)).toBeLessThanOrEqual(filled * 0.02);
});

test('view labels have a dark edge around the whole text', async ({ page }) => {
  await openPhantom(page);
  for (const selector of ['[data-view="coronal"] .overlay.bl', '[data-view="coronal"] .viewlabel button', '[data-view="coronal"] .orient.t']) {
    const style = await page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el);
      return { shadow: s.textShadow, stroke: s.webkitTextStrokeWidth };
    });
    // Eight one-pixel shadows, one for each side and corner, so no part of a glyph is left bare.
    const offsets = [...style.shadow.matchAll(/(-?\d+)px (-?\d+)px 0px/g)].map((m) => `${m[1]},${m[2]}`).sort();
    expect(offsets, selector).toEqual(['-1,-1', '-1,0', '-1,1', '0,-1', '0,1', '1,-1', '1,0', '1,1']);
    expect(style.stroke, selector).toBe('0px');
  }
});
