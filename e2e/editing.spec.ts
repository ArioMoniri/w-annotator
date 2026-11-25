import { expect, test, type Page } from '@playwright/test';
import { drag, maskVoxels, openPhantom } from './helpers';

/** One press and release without moving, then long enough for the tool to treat it as a single click. */
async function dab(page: Page, view: string, at: [number, number]): Promise<void> {
  const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + at[0], box.y + box.height / 2 + at[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
}

test('a key whose release never arrived does not stop the brush', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-40, 40]);
  const before = await maskVoxels(page, 1);
  // The view has the keyboard now. A key goes down and, as when the window loses focus
  // mid-press, its key-up is never delivered.
  await page.keyboard.down('q');
  await drag(page, 'axial', [-60, 70], [-20, 70]);
  expect(await maskVoxels(page, 1)).toBeGreaterThan(before);
  await page.keyboard.up('q');
});

test('holding Shift still erases after a lost key release', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 40]);
  const painted = await maskVoxels(page, 1);
  await page.keyboard.down('q');
  await page.keyboard.down('Shift');
  await drag(page, 'axial', [-60, 40], [-20, 40]);
  await page.keyboard.up('Shift');
  expect(await maskVoxels(page, 1)).toBeLessThan(painted);
  await page.keyboard.up('q');
});

test('with a brush, right-drag erases and leaves the window as it is; other tools keep right-drag for the window', async ({ page }) => {
  const voi = () => page.evaluate(() => JSON.stringify(window.__w.store.getState().voi));
  await openPhantom(page);
  for (const key of ['b', 't']) {
    await page.keyboard.press(key);
    await page.keyboard.press('b');
    await drag(page, 'axial', [-60, 40], [-20, 40]);
    await page.keyboard.press(key);
    const painted = await maskVoxels(page, 1);
    const window = await voi();
    await drag(page, 'axial', [-60, 40], [-20, 40], 'right');
    expect(await maskVoxels(page, 1), `right-drag with ${key}`).toBeLessThan(painted);
    expect(await voi(), `right-drag with ${key}`).toBe(window);
  }
  // No menu of the browser's own comes up over the image.
  await expect(page.getByRole('menu')).toHaveCount(0);

  for (const key of ['c', 'e']) {
    await page.keyboard.press(key);
    const mask = await maskVoxels(page);
    const window = await voi();
    await drag(page, 'axial', [-60, 40], [-20, 0], 'right');
    expect(await voi(), `right-drag with ${key}`).not.toBe(window);
    expect(await maskVoxels(page), `right-drag with ${key}`).toBe(mask);
  }
});

test('the brush strip keeps its size slider at every window width', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  for (const width of [1920, 1366, 1280, 1024]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 640 });
    const slider = page.locator('.strip').getByRole('slider', { name: 'Brush size', exact: true });
    await expect(slider, `${width} wide`).toBeVisible();
    await slider.fill('20');
    expect(await page.evaluate(() => window.__w.store.getState().brushSize), `${width} wide`).toBe(20);
    await slider.fill('6');
  }
});

test('an enlarged view fills the whole view area and can be painted on, whichever view it is', async ({ page }) => {
  await openPhantom(page);
  const grid = (await page.locator('.views').boundingBox())!;
  for (const view of ['axial', 'sagittal', 'coronal', 'volume3d']) {
    await page.evaluate((view) => (window as never as { __w: { store: { setState(s: object): void } } }).__w.store.setState({ maximized: view }), view);
    const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
    expect(box.width).toBeCloseTo(grid.width, 0);
    expect(box.height).toBeCloseTo(grid.height, 0);
    // The other views take no room in the layout, so they cannot squeeze this one.
    for (const other of ['axial', 'sagittal', 'coronal', 'volume3d'].filter((v) => v !== view)) {
      await expect(page.locator(`[data-view="${other}"]`)).toBeHidden();
    }
    await expect(page.locator(`[data-view="${view}"]`).getByRole('button', { name: 'Restore' })).toBeAttached();
  }
  await page.evaluate(() => (window as never as { __w: { store: { setState(s: object): void } } }).__w.store.setState({ maximized: 'axial' }));
  await page.waitForTimeout(400);
  await page.keyboard.press('b');
  const before = await maskVoxels(page, 1);
  await drag(page, 'axial', [-120, 150], [-60, 150]);
  const enlarged = await maskVoxels(page, 1);
  expect(enlarged).toBeGreaterThan(before);

  await page.locator('[data-view="axial"]').hover();
  await page.locator('[data-view="axial"]').getByRole('button', { name: 'Restore' }).click();
  await page.waitForTimeout(400);
  await drag(page, 'coronal', [-60, 60], [-20, 60]);
  expect(await maskVoxels(page, 1)).toBeGreaterThan(enlarged);
});

test('a click on the 3D view with an edit tool says where to paint', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('f');
  const before = await maskVoxels(page);
  await dab(page, 'volume3d', [0, 0]);
  await expect(page.locator('.toast')).toContainText('Paint on the axial, sagittal or coronal view.');
  expect(await maskVoxels(page)).toBe(before);
});

test('the smallest brush still paints the voxel under the cursor', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const size = page.getByLabel('Brush size in millimetres');
  // 1 mm voxels: a 1 mm circle would miss every voxel centre unless the cursor sat on one.
  await size.fill('1');
  await size.press('Enter');
  await expect(size).toHaveValue('1.5');
  // Different places inside a voxel, a corner among them. The phantom is about 6.8 px per voxel.
  for (const at of [
    [-60, 60],
    [-63.4, 80],
    [-63.4, 96.6],
    [-40, 63.4],
  ] as [number, number][]) {
    const before = await maskVoxels(page, 1);
    await dab(page, 'axial', at);
    const changed = (await maskVoxels(page, 1)) - before;
    expect(changed, `click at ${at}`).toBeGreaterThanOrEqual(1);
    expect(changed, `click at ${at}`).toBeLessThanOrEqual(4);
  }
});

test('the brush size keeps one decimal below 5 mm and steps by half a millimetre there', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const size = page.getByLabel('Brush size in millimetres');
  await size.fill('2.26');
  await size.press('Enter');
  await expect(size).toHaveValue('2.3');
  await page.locator('[data-view="axial"]').click({ position: { x: 20, y: 60 } });
  await page.keyboard.press('[');
  await expect(size).toHaveValue('1.8');
  await page.keyboard.press('[');
  await expect(size).toHaveValue('1.5');
  await page.keyboard.press('[');
  await expect(size).toHaveValue('1.5');
  await expect(page.getByLabel('Brush size', { exact: true })).toHaveAttribute('min', '1.5');
});

/** The brush rings drawn in a view: the circle that follows the pointer. */
const brushRings = (page: Page, view: string): Promise<number> => page.locator(`[data-view="${view}"] svg.svg-layer circle`).count();

test('the brush ring goes when the pointer leaves the view', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const hover = async (view: string) => {
    const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 4 });
  };
  await hover('axial');
  await expect.poll(() => brushRings(page, 'axial')).toBe(1);

  // Out to the tool rail: no view has the pointer.
  await page.getByLabel('Keyboard shortcuts').hover();
  await expect.poll(() => brushRings(page, 'axial')).toBe(0);

  // From one view to the next: only the view under the pointer has a ring.
  await hover('axial');
  await expect.poll(() => brushRings(page, 'axial')).toBe(1);
  await hover('sagittal');
  await expect.poll(() => brushRings(page, 'sagittal')).toBe(1);
  await expect.poll(() => brushRings(page, 'axial')).toBe(0);

  // It comes back with the pointer, and the brush still paints.
  await hover('axial');
  await expect.poll(() => brushRings(page, 'axial')).toBe(1);
  const before = await maskVoxels(page, 1);
  await drag(page, 'axial', [-60, 40], [-40, 40]);
  expect(await maskVoxels(page, 1)).toBeGreaterThan(before);

  // A stroke let go outside the views leaves no ring either.
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  const rail = (await page.getByLabel('Keyboard shortcuts').boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => brushRings(page, 'axial')).toBe(0);
});
