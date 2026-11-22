import { expect, test, type Page } from '@playwright/test';
import { drag, maskVoxels, modLabel, openPhantom, skipTour } from './helpers';

const mac = process.platform === 'darwin';

interface Voi {
  lower: number;
  upper: number;
}

const state = <T>(page: Page, pick: string) => page.evaluate((pick) => pick.split('.').reduce((o, k) => o?.[k], window.__w.store.getState()) as T, pick);
const voi = (page: Page) => state<Voi>(page, 'voi');
const wl = async (page: Page) => {
  const v = await voi(page);
  return { w: Math.round(v.upper - v.lower), l: Math.round((v.upper + v.lower) / 2) };
};
const zoom = (page: Page, view = 'axial') => page.evaluate((view) => window.__w.engine.getZoom(view) as number, view);

const readout = (page: Page) => page.getByTestId('status-window');
const windowMenu = (page: Page) => page.getByRole('menu', { name: 'Window' });
const zoomMenu = (page: Page) => page.getByRole('menu', { name: 'Zoom' });

/** An image with no unit: air at 0, a ball of tissue from 200 to 800 and a small very bright blob. Not CT-like. */
async function openMr(page: Page): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(async () => {
    const n = 48;
    const img = new Int16Array(n * n * n);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const r = Math.hypot(x - 24, y - 24, z - 24);
          let v = r < 20 ? 200 + r * 30 : 0;
          if (Math.hypot(x - 30, y - 22, z - 24) < 3) v = 2000;
          img[z * n * n + y * n + x] = v;
        }
    const buf = new ArrayBuffer(352 + img.byteLength);
    const v = new DataView(buf);
    v.setInt32(0, 348, true);
    v.setInt16(40, 3, true);
    [n, n, n].forEach((d, i) => v.setInt16(42 + i * 2, d, true));
    v.setInt16(70, 4, true);
    v.setInt16(72, 16, true);
    v.setFloat32(76, 1, true);
    [1, 1, 1].forEach((s, i) => v.setFloat32(80 + i * 4, s, true));
    v.setFloat32(108, 352, true);
    v.setFloat32(112, 1, true);
    v.setInt16(254, 1, true);
    [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + r * 16 + c * 4, x, true)));
    new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
    new Uint8Array(buf, 352).set(new Uint8Array(img.buffer));
    await window.__w.session.openFiles([{ name: 'phantom_t2.nii', bytes: new Uint8Array(buf) }]);
  });
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  await page.waitForTimeout(800);
}

/** The usual phantom with a peak above 300, so its values look like Hounsfield units: it opens on the soft tissue window. */
const openCt = (page: Page) => openPhantom(page, true, 400);

/** Two windows that differ by less than a rounding step. */
const close = (a: Voi, b: Voi) => Math.abs(a.lower - b.lower) < 0.01 && Math.abs(a.upper - b.upper) < 0.01;

/** A sum over the image and the mask, to show neither was written to. */
const checksums = (page: Page) =>
  page.evaluate(() => {
    const s = window.__w.session;
    const sum = (d: ArrayLike<number>) => {
      let a = 0;
      for (let i = 0; i < d.length; i++) a = (a * 31 + d[i]) | 0;
      return a;
    };
    return [sum(s.getImage().data), sum(s.getMask().data)];
  });

test('the window is always shown in the status bar, with the name of its preset, whatever the tool', async ({ page }) => {
  await openCt(page);
  await expect(readout(page)).toHaveText(/W\s*400\s*L\s*40\s*Soft tissue/);
  for (const key of ['b', 's', 'h']) {
    await page.keyboard.press(key);
    await expect(readout(page)).toBeVisible();
  }
  // A window that is no preset has no name.
  await page.keyboard.press('w');
  await page.getByLabel('Window width').fill('777');
  await page.keyboard.press('Enter');
  await expect(readout(page)).toHaveText(/^\s*W\s*777\s*L\s*40\s*$/);
  // It stays when the bar is at its narrowest.
  await page.setViewportSize({ width: 1024, height: 640 });
  await expect(readout(page)).toBeVisible();
  const bar = page.locator('.status');
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

/** The Pancreas item itself, not "Pancreas, narrow". */
const PANCREAS = /^Pancreas(?!,)/;

test('a CT image lists Abdomen and both pancreas windows, and choosing one applies its width and level', async ({ page }) => {
  await openCt(page);
  await page.keyboard.press('b');
  await readout(page).click();
  const menu = windowMenu(page);
  await expect(menu).toBeVisible();
  const names = ['Soft tissue', 'Abdomen', 'Liver', 'Pancreas', 'Pancreas, narrow', 'Lung', 'Bone', 'Brain', 'Stroke', 'Subdural', 'Auto', 'Full range'];
  // In this order, with the two pancreas windows after Abdomen and Liver.
  expect(await menu.getByRole('menuitemradio').evaluateAll((items) => items.map((i) => (i as HTMLElement).dataset.preset))).toEqual(names);
  for (const item of await menu.getByRole('menuitemradio').all()) await expect(item).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /^Bright fluid/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio', { name: /^Soft tissue/ })).toHaveAttribute('aria-checked', 'true');
  // The menu is whole and inside the window.
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);

  // The window published pancreas CT studies show the gland on.
  await menu.getByRole('menuitemradio', { name: PANCREAS }).click();
  await expect(menu).toBeHidden();
  expect(await wl(page)).toEqual({ w: 350, l: 40 });
  await expect(readout(page)).toHaveText(/W\s*350\s*L\s*40\s*Pancreas\s*$/);

  // The narrow one this project chose is still there, under its own name.
  await readout(page).click();
  await windowMenu(page).getByRole('menuitemradio', { name: /^Pancreas, narrow/ }).click();
  expect(await wl(page)).toEqual({ w: 150, l: 65 });
  await expect(readout(page)).toHaveText(/W\s*150\s*L\s*65\s*Pancreas, narrow/);

  await readout(page).click();
  await windowMenu(page).getByRole('menuitemradio', { name: /^Abdomen/ }).click();
  expect(await wl(page)).toEqual({ w: 350, l: 50 });
  // The brush is still the tool.
  expect(await state<string>(page, 'tool')).toBe('brush');

  await readout(page).click();
  await windowMenu(page).getByRole('menuitemradio', { name: /^Auto/ }).click();
  expect(await voi(page)).toEqual(await state<Voi>(page, 'image.auto'));
  await expect(readout(page)).toContainText('Auto');
});

test('the window menu works from the keyboard', async ({ page }) => {
  await openCt(page);
  await readout(page).focus();
  await page.keyboard.press('Enter');
  const menu = windowMenu(page);
  await expect(menu).toBeVisible();
  // Focus starts on the window in use; the arrows move through the list without changing slice.
  await expect(menu.getByRole('menuitemradio', { name: /^Soft tissue/ })).toBeFocused();
  const slice = () => page.evaluate(() => window.__w.engine.getSlice('axial').index as number);
  const before = await slice();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: /^Abdomen/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  expect(await slice()).toBe(before);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  expect(await wl(page)).toEqual({ w: 350, l: 50 });
  await expect(readout(page)).toBeFocused();

  // Esc closes it and gives the focus back.
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(readout(page)).toBeFocused();
});

test('the CT window menu is whole on screen in a 1024 by 640 window, with every saved preset', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openCt(page);
  // The most presets a person can save.
  await page.evaluate(() => {
    const presets = Array.from({ length: 12 }, (_, i) => ({ name: `Site ${i + 1}`, w: 500 + i, l: 10 + i }));
    window.__w.settings.setSetting('windowPresets', presets);
  });
  await readout(page).click();
  const menu = windowMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(12 + 12);
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  // Every item can be reached: the first and the last are on screen once scrolled to, inside the menu.
  for (const name of [/^Soft tissue/, /^Pancreas, narrow/, /^Full range/]) {
    const item = menu.getByRole('menuitemradio', { name });
    await item.scrollIntoViewIfNeeded();
    const b = (await item.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(box.y);
    expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
  }
  // Without saved presets nothing needs scrolling at all.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__w.settings.setSetting('windowPresets', []));
  await readout(page).click();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(12);
  expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  const plain = (await menu.boundingBox())!;
  expect(plain.y).toBeGreaterThanOrEqual(0);
  expect(plain.y + plain.height).toBeLessThanOrEqual(640);
});

test('an image that is not CT lists windows worked out from its own values', async ({ page }) => {
  await openMr(page);
  expect(await state<boolean>(page, 'image.ct')).toBe(false);
  await readout(page).click();
  const menu = windowMenu(page);
  for (const name of ['Auto', 'Full range', 'Mid range', 'Bright fluid', 'Dark detail']) {
    await expect(menu.getByRole('menuitemradio', { name: new RegExp(`^${name}\\b`) })).toBeVisible();
  }
  await expect(menu.getByRole('menuitemradio', { name: /^Pancreas/ })).toHaveCount(0);
  // "Soft tissue" is a CT window in Hounsfield units; no MR window borrows the name.
  await expect(menu.getByRole('menuitemradio', { name: /^Soft tissue/ })).toHaveCount(0);

  const before = await voi(page);
  await menu.getByRole('menuitemradio', { name: /^Bright fluid/ }).click();
  const fluid = await state<Voi>(page, 'image.mr.fluid');
  expect(await voi(page)).toEqual(fluid);
  expect(fluid).not.toEqual(before);
  // Nothing bright is clipped, and the air around the ball is below the window.
  expect(fluid.upper).toBe(2000);
  expect(fluid.lower).toBeGreaterThanOrEqual(200);
  await expect(readout(page)).toContainText('Bright fluid');

  await readout(page).click();
  await menu.getByRole('menuitemradio', { name: /^Dark detail/ }).click();
  const dark = await state<Voi>(page, 'image.mr.dark');
  expect(await voi(page)).toEqual(dark);
  expect(dark.upper).toBeLessThan((await state<Voi>(page, 'image.mr.soft')).upper);

  // The guess can be overruled: the CT list is one click away, and back.
  await readout(page).click();
  await menu.getByRole('group', { name: 'Presets for' }).getByRole('button', { name: 'CT' }).click();
  await expect(menu.getByRole('menuitemradio', { name: PANCREAS })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /^Bright fluid/ })).toHaveCount(0);
  await menu.getByRole('group', { name: 'Presets for' }).getByRole('button', { name: 'MR' }).click();
  await expect(menu.getByRole('menuitemradio', { name: /^Bright fluid/ })).toBeVisible();
});

test('P and Shift+P step through the presets, and the digits still pick segments', async ({ page }) => {
  await openCt(page);
  await page.keyboard.press('p');
  await expect(readout(page)).toContainText('Abdomen');
  await page.keyboard.press('p');
  await expect(readout(page)).toContainText('Liver');
  // Both pancreas windows come next, then Lung.
  await page.keyboard.press('p');
  await expect(readout(page)).toHaveText(/W\s*350\s*L\s*40\s*Pancreas\s*$/);
  await page.keyboard.press('p');
  await expect(readout(page)).toContainText('Pancreas, narrow');
  await page.keyboard.press('p');
  await expect(readout(page)).toContainText('Lung');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+P');
  await expect(readout(page)).toContainText('Liver');
  await page.keyboard.press('Shift+P');
  await page.keyboard.press('Shift+P');
  await expect(readout(page)).toContainText('Soft tissue');
  await page.keyboard.press('Shift+P');
  await expect(readout(page)).toContainText('Full range');
  await page.keyboard.press('2');
  expect(await state<number>(page, 'activeSegment')).toBe(2);
  await expect(readout(page)).toContainText('Full range');
});

test('the window on screen can be saved as a preset, is kept, and can be removed', async ({ page }) => {
  await openCt(page);
  await page.keyboard.press('w');
  await page.getByLabel('Window width').fill('1600');
  await page.keyboard.press('Enter');
  await page.getByLabel('Window level').fill('-550');
  await page.keyboard.press('Enter');

  await readout(page).click();
  await windowMenu(page).getByRole('menuitem', { name: 'Save current as preset…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save window as preset' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('W 1600 L −550');
  const name = dialog.getByLabel('Name');
  await expect(name).toBeFocused();

  // A name that is taken is refused, with the reason.
  await name.fill('lung');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('There is already a preset called Lung. Choose another name.');
  await name.fill('Site lung');
  // Typing a tool key in the field does not change the tool.
  expect(await state<string>(page, 'tool')).toBe('window');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(readout(page)).toHaveText(/W\s*1600\s*L\s*−550\s*Site lung/);

  // After the built-in ones, before Auto.
  await readout(page).click();
  const names = await windowMenu(page).getByRole('menuitemradio').evaluateAll((els) => els.map((el) => el.getAttribute('data-preset')));
  expect(names.slice(-4)).toEqual(['Subdural', 'Site lung', 'Auto', 'Full range']);
  await page.keyboard.press('Escape');

  // Kept between launches, and offered for another image.
  await openCt(page);
  await expect(readout(page)).toContainText('Soft tissue');
  await readout(page).click();
  await windowMenu(page).getByRole('menuitemradio', { name: /^Site lung/ }).click();
  expect(await wl(page)).toEqual({ w: 1600, l: -550 });

  // The preset keys reach it too.
  await page.keyboard.press('Shift+P');
  await expect(readout(page)).toContainText('Subdural');
  await page.keyboard.press('p');
  await expect(readout(page)).toContainText('Site lung');

  await readout(page).click();
  await windowMenu(page).getByRole('button', { name: 'Remove preset Site lung' }).click();
  await expect(windowMenu(page).getByRole('menuitemradio', { name: /^Site lung/ })).toHaveCount(0);
  await expect(windowMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(readout(page)).toHaveText(/^\s*W\s*1600\s*L\s*−550\s*$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings')!).windowPresets)).toEqual([]);
});

test('Esc and Cancel leave the save dialog without saving', async ({ page }) => {
  await openPhantom(page);
  for (const leave of ['Escape', 'Cancel']) {
    await readout(page).click();
    await windowMenu(page).getByRole('menuitem', { name: 'Save current as preset…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save window as preset' });
    await dialog.getByLabel('Name').fill('Nope');
    if (leave === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(readout(page)).toBeFocused();
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings')!).windowPresets ?? [])).toEqual([]);
});

test('with the Window / Level tool, a box drawn with the main modifier sets the window from what is inside', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('w');
  const sums = await checksums(page);
  const voxels = await maskVoxels(page);
  const before = await voi(page);

  const cell = page.locator('[data-view="axial"]');
  const box = (await cell.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const modifier = mac ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.mouse.move(cx - 30, cy - 30);
  await page.mouse.down();
  await page.mouse.move(cx + 10, cy + 10, { steps: 4 });
  await page.mouse.move(cx + 30, cy + 30, { steps: 4 });
  // The box is drawn while dragging, over the view.
  const drawn = cell.locator('.outline-draw path').first();
  await expect(drawn).toHaveAttribute('d', /M.*L.*Z/);
  const outline = (await drawn.boundingBox())!;
  expect(Math.abs(outline.width - 60)).toBeLessThan(5);
  expect(Math.abs(outline.height - 60)).toBeLessThan(5);
  // Dragging did not change the window yet: the modifier keeps the plain drag out of it.
  expect(await voi(page)).toEqual(before);
  await page.mouse.up();
  await page.keyboard.up(modifier);
  await expect(cell.locator('.outline-draw')).toHaveCount(0);

  // The window is the range of the values under the box, from the app's own percentile code.
  const expected = await page.evaluate(
    ({ a, b }) => {
      const w = window.__w;
      const image = w.session.getImage();
      const cell = document.querySelector('[data-view="axial"]')!;
      const canvas = cell.querySelector('canvas')!.getBoundingClientRect();
      const values: number[] = [];
      for (let y = a[1]; y <= b[1]; y++)
        for (let x = a[0]; x <= b[0]; x++) {
          const p = w.engine.canvasToWorld('axial', x - canvas.left, y - canvas.top) as number[];
          const d = image.direction as number[];
          const ijk = [0, 1, 2].map((a) => Math.round([0, 1, 2].reduce((sum, r) => sum + d[a * 3 + r] * (p[r] - image.origin[r]), 0) / image.spacing[a]));
          if (ijk.every((v, i) => v >= 0 && v < image.dims[i])) values.push(image.data[ijk[0] + image.dims[0] * (ijk[1] + image.dims[1] * ijk[2])]);
        }
      values.sort((p, q) => p - q);
      return { lower: values[Math.round(0.01 * (values.length - 1))], upper: values[Math.round(0.99 * (values.length - 1))], min: values[0], max: values[values.length - 1] };
    },
    { a: [cx - 30, cy - 30], b: [cx + 30, cy + 30] },
  );
  const after = await voi(page);
  expect(after).not.toEqual(before);
  // Sampling differs by a pixel here and there; the window is inside the values of the box and near its percentiles.
  expect(after.lower).toBeGreaterThanOrEqual(expected.min);
  expect(after.upper).toBeLessThanOrEqual(expected.max);
  expect(Math.abs(after.lower - expected.lower)).toBeLessThanOrEqual(16);
  expect(Math.abs(after.upper - expected.upper)).toBeLessThanOrEqual(16);

  // Display only: neither the image nor the mask was written to.
  expect(await checksums(page)).toEqual(sums);
  expect(await maskVoxels(page)).toBe(voxels);
  expect(await state<boolean>(page, 'dirty')).toBe(false);

  // Without the modifier the drag changes width and level as before, and draws no box.
  await drag(page, 'axial', [-30, -30], [30, 10]);
  await expect(cell.locator('.outline-draw')).toHaveCount(0);
  expect(await voi(page)).not.toEqual(after);
});

test('a box with another tool is not a window box', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('h');
  const before = await voi(page);
  const modifier = mac ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await drag(page, 'axial', [-30, -30], [30, 30]);
  await page.keyboard.up(modifier);
  expect(await voi(page)).toEqual(before);
});

test('Esc while drawing the box drops it', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('w');
  const before = await voi(page);
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  const modifier = mac ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 4 });
  await page.keyboard.up(modifier);
  await page.keyboard.press('Escape');
  await expect(page.locator('.outline-draw')).toHaveCount(0);
  await page.mouse.up();
  expect(await voi(page)).toEqual(before);
  expect(await state<string>(page, 'tool')).toBe('window');
});

test('brightness and contrast have keys', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const start = await wl(page);
  await page.keyboard.press('Shift+ArrowUp');
  const brighter = await wl(page);
  expect(brighter.l).toBeLessThan(start.l);
  expect(brighter.w).toBe(start.w);
  await page.keyboard.press('Shift+ArrowDown');
  expect(await wl(page)).toEqual(start);
  await page.keyboard.press('Shift+ArrowRight');
  const contrast = await wl(page);
  expect(contrast.w).toBeLessThan(start.w);
  expect(contrast.l).toBe(start.l);
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await wl(page)).toEqual(start);
});

test('with the Window / Level tool a two-finger scroll changes the window, and Shift+scroll still changes slice', async ({ page }) => {
  await openPhantom(page);
  // Trackpad input cannot be produced by a test, so this dispatches the events a trackpad makes.
  const scroll = (events: { deltaX?: number; deltaY?: number; shiftKey?: boolean }[]) =>
    page.evaluate(async (events) => {
      const cell = document.querySelector('[data-view="axial"]')!;
      const rect = cell.getBoundingClientRect();
      for (const init of events) {
        const e = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: 0,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          ...init,
        });
        cell.querySelector('canvas')!.dispatchEvent(e);
        await new Promise((r) => setTimeout(r, 4));
      }
      await new Promise((r) => setTimeout(r, 320));
    }, events);
  const slice = () => page.evaluate(() => window.__w.engine.getSlice('axial').index as number);
  const vertical = (dy: number, more = {}) => Array.from({ length: 30 }, () => ({ deltaY: dy, ...more }));

  // With another tool the scroll is slices, as before.
  const at = await slice();
  const start = await voi(page);
  const width = (v: Voi) => v.upper - v.lower;
  const level = (v: Voi) => (v.upper + v.lower) / 2;
  await scroll(vertical(5));
  expect(await slice()).not.toBe(at);
  expect(await voi(page)).toEqual(start);

  await page.keyboard.press('w');
  const here = await slice();
  await scroll(vertical(5));
  const brighter = await voi(page);
  expect(await slice()).toBe(here);
  // Whole pixels, as a trackpad sends. 150 pixels at 0.002 of the width each: the level drops by 30% of the width, which stays.
  expect(level(brighter)).toBeCloseTo(level(start) - 0.3 * width(start), 1);
  expect(width(brighter)).toBeCloseTo(width(start), 2);
  await scroll(vertical(-5));
  expect(close(await voi(page), start)).toBe(true);

  await scroll(Array.from({ length: 30 }, () => ({ deltaX: -5, deltaY: 0 })));
  const wider = await voi(page);
  expect(width(wider)).toBeGreaterThan(width(start) * 1.5);
  expect(level(wider)).toBeCloseTo(level(start), 2);

  await scroll(vertical(5, { shiftKey: true }));
  expect(await slice()).not.toBe(here);
  expect(close(await voi(page), wider)).toBe(true);
});

test('the zoom readout opens a menu with Zoom in, Zoom out, Fit and Actual size', async ({ page }) => {
  await openPhantom(page);
  const button = page.getByTestId('status-zoom');
  await expect(button).toHaveText(/Zoom\s*100%/);
  await button.click();
  const menu = zoomMenu(page);
  await expect(menu).toBeVisible();

  const centre = () =>
    page.evaluate(() => {
      const w = window.__w;
      const r = document.querySelector('[data-view="axial"] canvas')!.getBoundingClientRect();
      return (w.engine.canvasToWorld('axial', r.width / 2, r.height / 2) as number[]).map((v) => Math.round(v * 100) / 100);
    });
  const middle = await centre();
  const fitted = await zoom(page);
  await menu.getByRole('menuitem', { name: /^Zoom in/ }).click();
  await menu.getByRole('menuitem', { name: /^Zoom in/ }).click();
  await expect(menu).toBeVisible();
  expect(await zoom(page)).toBeCloseTo(fitted * 1.25 * 1.25, 3);
  // About the centre of the view.
  expect(await centre()).toEqual(middle);
  await expect(button).toHaveText(/Zoom\s*156%/);
  await menu.getByRole('menuitem', { name: /^Zoom out/ }).click();
  expect(await zoom(page)).toBeCloseTo(fitted * 1.25, 3);

  await menu.getByRole('menuitem', { name: /^Actual size/ }).click();
  await expect(menu).toBeHidden();
  // One voxel of this 1 mm image per screen pixel.
  const mmPerPixel = await page.evaluate(() => {
    const f = window.__w.engine.viewFrame('axial');
    return Math.hypot(...(f.right as number[]));
  });
  expect(mmPerPixel).toBeCloseTo(1, 3);
  expect(await centre()).toEqual(middle);

  await button.click();
  await menu.getByRole('menuitem', { name: /^Fit/ }).click();
  await expect(menu).toBeHidden();
  expect(await zoom(page)).toBeCloseTo(fitted, 3);
  await expect(button).toHaveText(/Zoom\s*100%/);

  // The keys are shown beside the items.
  await button.click();
  await expect(menu.getByRole('menuitem', { name: /^Zoom in/ })).toContainText('=');
  await expect(menu.getByRole('menuitem', { name: /^Zoom out/ })).toContainText('-');
  await expect(menu.getByRole('menuitem', { name: /^Fit/ })).toContainText('0');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('zoom has keys, and they act on the active view', async ({ page }) => {
  await openPhantom(page);
  const fitted = { axial: await zoom(page, 'axial'), sagittal: await zoom(page, 'sagittal') };
  await page.locator('[data-view="sagittal"]').focus();
  await page.keyboard.press('=');
  expect(await zoom(page, 'sagittal')).toBeCloseTo(fitted.sagittal * 1.25, 3);
  expect(await zoom(page, 'axial')).toBeCloseTo(fitted.axial, 3);
  await page.keyboard.press('+');
  expect(await zoom(page, 'sagittal')).toBeCloseTo(fitted.sagittal * 1.25 * 1.25, 3);
  await page.keyboard.press('-');
  expect(await zoom(page, 'sagittal')).toBeCloseTo(fitted.sagittal * 1.25, 3);
  await page.keyboard.press('0');
  expect(await zoom(page, 'sagittal')).toBeCloseTo(fitted.sagittal, 3);
  // The digits 1 to 9 still pick segments.
  await page.keyboard.press('2');
  expect(await state<number>(page, 'activeSegment')).toBe(2);
});

test('the shortcuts list names the new keys and gestures, with this system’s labels', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  const list = page.locator('.shortcuts');
  const keyOf = (action: string) => list.locator(`[data-action="${action}"]`);
  await expect(keyOf('window.next')).toHaveText('P');
  await expect(keyOf('window.previous')).toHaveText(mac ? 'Shift P' : 'Shift+P');
  await expect(keyOf('window.brighter')).toHaveText(mac ? 'Shift ↑' : 'Shift+↑');
  await expect(keyOf('view.zoomIn')).toHaveText('=');
  await expect(keyOf('view.zoomOut')).toHaveText('-');
  await expect(keyOf('view.fit')).toHaveText('0');
  for (const label of ['Next window preset', 'Previous window preset', 'Brighter', 'Darker', 'More contrast', 'Less contrast', 'Zoom in', 'Zoom out', 'Fit to view']) {
    await expect(list.getByText(label, { exact: true })).toHaveCount(1);
  }
  const row = (label: string) => list.locator('div', { has: page.getByText(label, { exact: true }) }).last().locator('kbd');
  await expect(row('Window from a box, with the Window / Level tool')).toHaveText(mac ? '⌘-drag' : 'Ctrl-drag');
  await expect(row('Brightness and contrast, with the Window / Level tool')).toHaveText('Two-finger scroll');
  await expect(row('Zoom')).toHaveText(`${modLabel('Scroll').replace(' Scroll', '+Scroll')} or pinch`);
});

test('the Window / Level strip keeps its controls and lists saved presets', async ({ page }) => {
  await openCt(page);
  await page.keyboard.press('w');
  const preset = page.getByLabel('Preset', { exact: true });
  await preset.selectOption('Pancreas');
  expect(await wl(page)).toEqual({ w: 350, l: 40 });
  await expect(preset).toHaveValue('Pancreas');
  await preset.selectOption('Pancreas, narrow');
  expect(await wl(page)).toEqual({ w: 150, l: 65 });
  await expect(preset).toHaveValue('Pancreas, narrow');
  await page.getByLabel('Window width').fill('900');
  await page.keyboard.press('Enter');
  await expect(preset).toHaveValue('');
  await page.getByRole('button', { name: 'Reset' }).click();
  expect(await voi(page)).toEqual(await state<Voi>(page, 'image.auto'));
  await expect(preset).toHaveValue('Auto');
  // The hint for the box names this system's modifier.
  await expect(page.locator('.strip .hint')).toHaveText(`${mac ? '⌘' : 'Ctrl'}-drag a box to set the window from it.`);
});

test('the strip lists the MR windows for an image that is not CT', async ({ page }) => {
  await openMr(page);
  await page.keyboard.press('w');
  const preset = page.getByLabel('Preset', { exact: true });
  await expect(preset.locator('option')).toHaveText(['Custom', 'Auto', 'Full range', 'Mid range', 'Bright fluid', 'Dark detail']);
  await preset.selectOption('Dark detail');
  expect(await voi(page)).toEqual(await state<Voi>(page, 'image.mr.dark'));
});

test('in a room each person keeps their own window', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await openCt(host);
  await host.getByRole('button', { name: 'Share' }).click();
  await host.getByPlaceholder('How others will see you').fill('Mina');
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  const link = (await host.getByTestId('room-link').textContent())!.trim();
  await host.keyboard.press('Escape');
  await guest.goto('/');
  await guest.getByRole('button', { name: 'Join a room', exact: true }).click();
  await guest.getByPlaceholder('How others will see you').fill('Ario');
  await guest.getByPlaceholder('Paste the invite link').fill(link);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 30_000 });
  await expect(guest.locator('.segrow')).toHaveCount(2);
  const guestBefore = await voi(guest);

  await readout(host).click();
  await windowMenu(host).getByRole('menuitemradio', { name: /^Lung/ }).click();
  await host.keyboard.press('p');
  // An edit goes through, so the room is live; the window did not travel with it.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => maskVoxels(guest)).toBe(await maskVoxels(host));
  expect(await voi(guest)).toEqual(guestBefore);
  expect(await wl(host)).toEqual({ w: 1800, l: 400 });

  await hostCtx.close();
  await guestCtx.close();
});
