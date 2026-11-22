import { expect, test, type Page } from '@playwright/test';
import {
  choose,
  clickVoxel as click,
  countVoxels as count,
  drag,
  isTinted,
  jumpToVoxel,
  maskDump as dump,
  maskVoxels,
  openPhantom,
  pixelAt,
  tintedPixels,
  trace,
  type Voxel,
} from './helpers';
import { formatVoxels } from '../src/mask/ops';

/** How a toast writes a number of voxels of the phantom, whose voxels are 1 mm each way. */
const size = (voxels: number) => formatVoxels(voxels, [1, 1, 1]);

const chip = (page: Page) => page.locator('.strip .chip');

const store = <T>(page: Page, read: string) => page.evaluate((read) => new Function('s', `return ${read}`)(window.__w.store.getState()) as T, read);

/** A loop around segment 1 on the middle axial slice, drawn by hand rather than as a box. */
const AROUND_1: Voxel[] = [
  [24.5, 16.5, 24],
  [30, 15.5, 24],
  [36.5, 17, 24],
  [37, 22, 24],
  [36, 28.5, 24],
  [30, 29, 24],
  [24, 27.5, 24],
  [23.5, 22, 24],
];

test('a freehand loop erases the segment inside it on this slice, as one undo step', async ({ page }) => {
  await openPhantom(page);
  const before = await dump(page);
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  const onSlice = await count(page, 'v === 1 && z === 24');
  expect(onSlice).toBeGreaterThan(50);

  await page.keyboard.press('s');
  await choose(page, 'Scissors shape', 'Freehand');
  // Esc while drawing drops the loop: nothing is cut and the scissors stay in hand.
  await trace(page, 'axial', AROUND_1.slice(0, 5), false);
  await expect(page.locator('[data-view="axial"] .outline-draw')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-view="axial"] .outline-draw')).toHaveCount(0);
  expect(await dump(page)).toBe(before);
  await expect(page.locator('.strip')).toHaveAttribute('data-strip', 'scissors');

  await trace(page, 'axial', AROUND_1);
  expect(await count(page, 'v === 1 && z === 24')).toBe(0);
  expect(await maskVoxels(page, 1)).toBe(one - onSlice);
  expect(await maskVoxels(page, 2)).toBe(two);
  // The view shows it: the middle of the segment is no longer tinted.
  expect(isTinted(await pixelAt(page, 'axial', [30, 22, 24]))).toBe(false);

  await page.keyboard.press('Control+z');
  expect(await dump(page)).toBe(before);
  await page.keyboard.press('Control+Shift+z');
  expect(await maskVoxels(page, 1)).toBe(one - onSlice);
});

test('a loop that crosses a neighbour takes voxels from the active segment only', async ({ page }) => {
  await openPhantom(page);
  const two = await maskVoxels(page, 2);
  await page.keyboard.press('s');
  await choose(page, 'Scissors shape', 'Freehand');
  // Segment 1 is the active one; the loop goes around segment 2.
  await trace(page, 'axial', [[12, 22, 24], [22, 22, 24], [22, 32, 24], [12, 32, 24]]);
  expect(await maskVoxels(page, 2)).toBe(two);

  // The rectangle scissors keep to the active segment as well.
  await choose(page, 'Scissors shape', 'Rectangle');
  await trace(page, 'axial', [[12, 22, 24], [22, 32, 24]]);
  expect(await maskVoxels(page, 2)).toBe(two);
});

test('erase outside through all slices crops the segment to the outline, with a toast to undo it', async ({ page }) => {
  await openPhantom(page);
  const before = await dump(page);
  const two = await maskVoxels(page, 2);
  const inside = await count(page, 'v === 1 && x >= 29 && x <= 36 && y >= 17 && y <= 27');
  const all = await maskVoxels(page, 1);
  expect(inside).toBeLessThan(all);

  await page.keyboard.press('s');
  await choose(page, 'Scissors action', 'Erase outside');
  await choose(page, 'Scissors depth', 'All slices');
  await trace(page, 'axial', [[28.5, 16.5, 24], [36.5, 27.5, 24]]);
  expect(await maskVoxels(page, 1)).toBe(inside);
  expect(await count(page, 'v === 1 && x < 29')).toBe(0);
  expect(await maskVoxels(page, 2)).toBe(two);
  const toast = page.locator('.toast', { hasText: `Erased ${size(all - inside)} of Segment 1 on all axial slices` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  expect(await dump(page)).toBe(before);
});

test('a circle filled through all slices in another plane makes a cylinder along that view', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await page.keyboard.press('s');
  await choose(page, 'Scissors shape', 'Circle');
  await choose(page, 'Scissors action', 'Fill inside');
  await choose(page, 'Scissors depth', 'All slices');
  // In the coronal view the plane is x and z; the cut runs along y.
  await trace(page, 'coronal', [[20, 24, 30], [23.2, 24, 30]]);
  const total = await maskVoxels(page, 1);
  const perSlice = await count(page, 'v === 1 && y === 5');
  expect(perSlice).toBeGreaterThan(20);
  expect(perSlice).toBeLessThan(45);
  expect(total).toBe(perSlice * 48);
  expect(await count(page, 'v === 1 && Math.hypot(x - 20, z - 30) > 3.3')).toBe(0);
});

test('Alt-click selects the segment under the cursor and changes nothing else', async ({ page }) => {
  await openPhantom(page);
  const before = await dump(page);
  await page.keyboard.press('b');
  await expect(chip(page)).toHaveText('Segment 1');

  await click(page, 'axial', [17, 27, 24], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 2');
  await expect(page.locator('.segrow[data-segment="2"]')).toHaveAttribute('aria-selected', 'true');
  await click(page, 'axial', [30, 22, 24], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 1');
  // Background picks nothing.
  await click(page, 'axial', [8, 8, 24], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 1');
  // The other planes work the same way.
  await jumpToVoxel(page, [17, 27, 23]);
  await click(page, 'coronal', [17, 27, 23], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 2');

  expect(await dump(page)).toBe(before);
  expect(await store<boolean>(page, 's.canUndo')).toBe(false);

  // A hidden segment is not picked; a locked one is, and no stroke or refusal comes of it.
  await page.evaluate(() => {
    const s = window.__w.session;
    s.patchSegment(1, { visible: false });
    s.patchSegment(2, { locked: true });
  });
  await jumpToVoxel(page, [30, 22, 24]);
  await click(page, 'axial', [30, 22, 24], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 2');
  await page.evaluate(() => {
    const s = window.__w.session;
    s.patchSegment(1, { visible: true });
    s.selectSegment(1);
  });
  await click(page, 'axial', [17, 27, 24], ['Alt']);
  await expect(chip(page)).toHaveText('Segment 2');
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await dump(page)).toBe(before);
});

test('Alt-click is in the list of mouse shortcuts', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('Select the segment under the cursor');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText(`${process.platform === 'darwin' ? '⌥' : 'Alt'}-click`);
});

test('paint over "Only" keeps a stroke inside the chosen segment', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  const filled = await maskVoxels(page);
  await page.keyboard.press('b');
  await page.getByLabel('Paint only inside a segment').selectOption({ label: 'Only Segment 2' });
  await expect(chip(page)).toHaveText('Segment 1, inside Segment 2');

  // A stroke from empty space, through segment 2, into empty space again.
  await trace(page, 'axial', [[8, 27, 24], [26, 27, 24]]);
  const painted = (await maskVoxels(page, 1)) - one;
  expect(painted).toBeGreaterThan(10);
  expect(await maskVoxels(page, 2)).toBe(two - painted);
  expect(await maskVoxels(page)).toBe(filled);
  expect(await count(page, 'v === 1 && x < 12')).toBe(0);

  // Erasing is not limited by it.
  await page.keyboard.down('Shift');
  await trace(page, 'axial', [[26, 22, 24], [34, 22, 24]]);
  await page.keyboard.up('Shift');
  expect(await maskVoxels(page)).toBeLessThan(filled);

  // A stroke that the limit leaves nothing of says why, once.
  await trace(page, 'axial', [[6, 8, 24], [12, 8, 24]]);
  await expect(page.locator('.toast', { hasText: 'Nothing was painted: Paint over is set to Only Segment 2.' })).toHaveCount(1);

  // Without its segment the limit cannot hold: it goes back to Everything and says so.
  await page.evaluate(() => {
    window.__w.session.deleteSegment(2);
  });
  await expect(page.locator('.toast', { hasText: 'Paint over is back to Everything.' })).toBeVisible();
  await expect(chip(page)).toHaveText('Segment 1');
  await expect(page.getByRole('group', { name: 'Paint over' }).getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
});

test('scissors fill inside follows the paint over choice', async ({ page }) => {
  await openPhantom(page);
  const two = await maskVoxels(page, 2);
  const filled = await maskVoxels(page);
  const twoOnSlice = await count(page, 'v === 2 && z === 24');
  await page.keyboard.press('s');
  await choose(page, 'Scissors shape', 'Freehand');
  await choose(page, 'Scissors action', 'Fill inside');
  await page.getByLabel('Paint over').selectOption({ label: 'Only Segment 2' });
  await trace(page, 'axial', [[10, 20, 24], [24, 20, 24], [24, 34, 24], [10, 34, 24]]);
  expect(await maskVoxels(page, 2)).toBe(two - twoOnSlice);
  expect(await maskVoxels(page)).toBe(filled);

  await page.keyboard.press('Control+z');
  await page.getByLabel('Paint over').selectOption({ label: 'Empty only' });
  await trace(page, 'axial', [[10, 20, 24], [24, 20, 24], [24, 34, 24], [10, 34, 24]]);
  expect(await maskVoxels(page, 2)).toBe(two);
  expect(await maskVoxels(page)).toBeGreaterThan(filled + 100);
});

test('the Fill tool removes or keeps the island that is clicked', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  // A stray piece of segment 1, well away from the rest of it.
  await page.keyboard.press('b');
  await trace(page, 'axial', [[10, 40, 24], [16, 40, 24]]);
  const stray = (await maskVoxels(page, 1)) - one;
  expect(stray).toBeGreaterThan(20);
  const withStray = await dump(page);

  await page.keyboard.press('f');
  await choose(page, 'Fill action', 'Remove island');
  // A click on nothing, or on another segment, changes nothing.
  await click(page, 'axial', [40, 8, 24]);
  await click(page, 'axial', [17, 27, 24]);
  expect(await dump(page)).toBe(withStray);
  await expect(page.locator('.toast', { hasText: 'Click a part of Segment 1.' })).toBeVisible();

  await click(page, 'axial', [13, 40, 24]);
  expect(await maskVoxels(page, 1)).toBe(one);
  expect(await maskVoxels(page, 2)).toBe(two);
  await expect(page.locator('.toast', { hasText: `Removed an island of Segment 1, ${stray} mm³` })).toBeVisible();
  await page.keyboard.press('Control+z');
  expect(await dump(page)).toBe(withStray);

  // Keep: click the real one, the stray piece goes. The sphere reaches other slices; they stay.
  await choose(page, 'Fill action', 'Keep island');
  await click(page, 'axial', [30, 22, 24]);
  expect(await maskVoxels(page, 1)).toBe(one);
  expect(await count(page, 'v === 1 && y > 35')).toBe(0);
  await expect(page.locator('.toast', { hasText: `Removed ${stray} mm³ of Segment 1 outside this island` })).toBeVisible();
  await click(page, 'axial', [30, 22, 24]);
  await expect(page.locator('.toast', { hasText: 'Segment 1 is already one island.' })).toBeVisible();

  // Fill area is still the plain fill: an enclosed hole on this slice.
  await choose(page, 'Fill action', 'Fill area');
  await expect(page.locator('.strip .hint')).toHaveText('Click an enclosed area to fill it on this slice.');
});

test('fill between slices shows a preview and writes nothing until it is applied', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const two = await maskVoxels(page, 1);
  const painted = await dump(page);
  // A slice in the gap: nothing of the mask is on it.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  expect(await tintedPixels(page, 'axial')).toBe(0);

  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toHaveText(/^Preview: [\d,.]+ (mm³|mL) between axial slices\.$/);
  await page.waitForTimeout(400);
  expect(await tintedPixels(page, 'axial')).toBeGreaterThan(200);
  expect(await dump(page)).toBe(painted);
  expect(await store<boolean>(page, 's.dirty && s.canUndo && !s.canRedo')).toBe(true);
  // Looking around is still possible while it is shown.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.strip [role="status"]')).toBeVisible();

  // Esc: the preview goes, the mask is as it was, and the brush is still in hand.
  await page.keyboard.press('Escape');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await tintedPixels(page, 'axial')).toBe(0);
  expect(await dump(page)).toBe(painted);
  await expect(page.locator('.strip')).toHaveAttribute('data-strip', 'brush');

  // Apply with the button, then Enter the second time round.
  await page.getByRole('button', { name: 'Fill between slices' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  const filled = await maskVoxels(page, 1);
  expect(filled).toBeGreaterThan(two * 1.5);
  await expect(page.locator('.toast', { hasText: `Filled ${size(filled - two)} between axial slices` })).toBeVisible();
  await page.keyboard.press('Control+z');
  expect(await dump(page)).toBe(painted);
  await page.keyboard.press('i');
  await page.keyboard.press('Enter');
  expect(await maskVoxels(page, 1)).toBe(filled);
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await tintedPixels(page, 'axial')).toBeGreaterThan(200);
});

test('choosing another tool or segment cancels a fill preview and says so', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const painted = await dump(page);

  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toBeVisible();
  await page.keyboard.press('e');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'Fill preview cancelled.' })).toBeVisible();
  await expect(page.locator('.strip')).toHaveAttribute('data-strip', 'eraser');

  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await page.keyboard.press('1');
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  expect(await dump(page)).toBe(painted);
});

test('Smooth pixels in the view menu changes how the image is drawn and not its values', async ({ page }) => {
  await openPhantom(page);
  const values = () =>
    page.evaluate(() => {
      const d = window.__w.session.getImage().data as Int16Array;
      let h = 0;
      for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0;
      return h;
    });
  const smooth = () => page.evaluate(() => window.__w.engine.getSmoothPixels('axial') as boolean);
  const before = await values();
  // Two points inside one voxel, where the image has a slope, on a narrow window so the slope shows. No mask is over them.
  await page.keyboard.press('x');
  await page.evaluate(() => window.__w.session.setVoi(150, 230));
  await page.waitForTimeout(300);
  const pair = async () => [await pixelAt(page, 'axial', [37.8, 24, 24]), await pixelAt(page, 'axial', [38.2, 24, 24])];
  expect(await smooth()).toBe(true);
  let [a, b] = await pair();
  expect(a[0]).not.toBe(b[0]);

  await page.locator('[data-view="axial"] .viewlabel > button').click();
  const item = page.getByRole('menuitemcheckbox', { name: 'Smooth pixels' });
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await item.click();
  await page.waitForTimeout(400);
  expect(await smooth()).toBe(false);
  [a, b] = await pair();
  expect(a).toEqual(b);
  expect(await values()).toBe(before);
  // The other slice views follow; the choice is kept for the next launch.
  expect(await page.evaluate(() => window.__w.engine.getSmoothPixels('coronal'))).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings')!).smoothPixels)).toBe(false);
  // The 3D view has no pixels to smooth.
  await page.locator('[data-view="volume3d"] .viewlabel > button').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(4);
  await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.locator('[data-view="coronal"] .viewlabel > button').click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Smooth pixels' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('menuitemcheckbox', { name: 'Smooth pixels' }).click();
  await page.waitForTimeout(400);
  expect(await smooth()).toBe(true);
  [a, b] = await pair();
  expect(a[0]).not.toBe(b[0]);
});

test('split gives each island a segment of its own', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  await page.keyboard.press('b');
  await trace(page, 'axial', [[10, 40, 24], [16, 40, 24]]);
  const stray = (await maskVoxels(page, 1)) - one;
  const withStray = await dump(page);

  await page.locator('.segrow', { hasText: 'Segment 1' }).hover();
  await page.getByRole('button', { name: 'More for Segment 1' }).click();
  await page.getByRole('menuitem', { name: 'Split into separate segments' }).click();
  await expect(page.locator('.segrow')).toHaveCount(3);
  await expect(page.locator('.segrow[data-segment="3"] .name')).toHaveText('Segment 1 2');
  expect(await maskVoxels(page, 1)).toBe(one);
  expect(await maskVoxels(page, 3)).toBe(stray);
  await expect(page.locator('.toast', { hasText: 'Split Segment 1 into 2 segments.' })).toBeVisible();
  await page.keyboard.press('Control+z');
  expect(await dump(page)).toBe(withStray);

  // One island: nothing to split.
  await page.locator('.segrow', { hasText: 'Segment 2' }).hover();
  await page.getByRole('button', { name: 'More for Segment 2' }).click();
  await page.getByRole('menuitem', { name: 'Split into separate segments' }).click();
  await expect(page.locator('.toast', { hasText: 'Segment 2 is already one island.' })).toBeVisible();
});

test('a split that would make many segments asks first and stops at twenty', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  // Thirty separate voxels and one larger piece, written the way a file or a room would bring them.
  await page.evaluate(() => {
    const w = window.__w;
    const d = new Uint8Array(48 * 48 * 48);
    for (let n = 0; n < 30; n++) d[2 + n * 98 + 10 * 2304] = 1;
    for (let x = 20; x < 24; x++) d[x + 40 * 48 + 30 * 2304] = 1;
    w.session.restoreMask(d, [{ index: 1, name: 'Lesions', color: '#E69F00', locked: false }], null);
  });
  await page.locator('.segrow', { hasText: 'Lesions' }).hover();
  await page.getByRole('button', { name: 'More for Lesions' }).click();
  await page.getByRole('menuitem', { name: 'Split into separate segments' }).click();
  const ask = page.getByRole('dialog', { name: 'Split Lesions into 21 segments?' });
  await expect(ask).toContainText('Lesions has 31 islands. The 21 largest become segments of their own; the rest stay in Lesions.');
  expect(await maskVoxels(page, 1)).toBe(34);
  await ask.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.locator('.segrow')).toHaveCount(21);
  expect(await maskVoxels(page, 1)).toBe(4 + 10);
  expect(await maskVoxels(page)).toBe(34);
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1024, height: 640 },
]) {
  test(`the fuller tool strips fit at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openPhantom(page);
    await page.locator('.segrow .name').first().dblclick();
    await page.getByLabel('Segment name').fill('Left ventricular myocardium, basal');
    await page.keyboard.press('Enter');
    const fits = async (what: string) => {
      await page.waitForTimeout(150);
      const fit = await page.locator('.strip').evaluate((strip) => {
        const edge = strip.getBoundingClientRect().right - 12;
        const chip = strip.querySelector('.chip')!.getBoundingClientRect();
        const options = strip.querySelector('.options')!;
        const controls = Array.from(options.querySelectorAll('button, input, select')).filter((el) => (el as HTMLElement).offsetParent);
        const cut = controls.filter((el) => el.getBoundingClientRect().right > chip.left - 4).length;
        return { chipInside: chip.right <= edge + 0.5, cut, overflow: Math.max(options.scrollWidth - options.clientWidth, strip.scrollWidth - strip.clientWidth) };
      });
      await page.screenshot({ path: `test-results/mask-tools/${what}-${size.width}.png` });
      expect(fit, what).toMatchObject({ chipInside: true, cut: 0 });
      expect(fit.overflow, what).toBeLessThanOrEqual(0);
    };

    await page.keyboard.press('s');
    await choose(page, 'Scissors shape', 'Freehand');
    await choose(page, 'Scissors action', 'Fill inside');
    await choose(page, 'Scissors depth', 'All slices');
    await page.getByLabel('Paint over').selectOption({ label: 'Only Segment 2' });
    await fits('scissors');
    await choose(page, 'Scissors shape', 'Sphere');
    await expect(page.getByRole('group', { name: 'Scissors depth' })).toHaveCount(0);
    await fits('scissors-sphere');

    await page.keyboard.press('f');
    await fits('fill');
    await choose(page, 'Fill action', 'Keep island');
    await fits('fill-keep');

    await page.keyboard.press('t');
    await fits('threshold');

    await page.keyboard.press('b');
    await fits('brush');
    await page.evaluate(() => {
      const s = window.__w.session;
      s.setPaintOver('all');
      s.addSegment();
    });
    await drag(page, 'axial', [-20, 60], [20, 60]);
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await drag(page, 'axial', [-20, 60], [20, 60]);
    await page.keyboard.press('i');
    await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
    await fits('preview');
  });
}

test('in a room a cut reaches the other person, and a fill preview does not until it is applied', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await openPhantom(host);
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
  await expect.poll(() => maskVoxels(guest)).toBe(await maskVoxels(host));

  // The host cuts segment 1 off the middle slice with a loop, then crops it through the stack.
  const one = await maskVoxels(host, 1);
  await host.keyboard.press('s');
  await choose(host, 'Scissors shape', 'Freehand');
  await trace(host, 'axial', AROUND_1);
  const cut = await maskVoxels(host, 1);
  expect(cut).toBeLessThan(one);
  await expect.poll(() => maskVoxels(guest, 1)).toBe(cut);
  expect(await dump(guest)).toBe(await dump(host));
  await choose(host, 'Scissors action', 'Erase outside');
  await choose(host, 'Scissors depth', 'All slices');
  await trace(host, 'axial', [[28.5, 16.5, 24], [36.5, 27.5, 24]]);
  const cropped = await maskVoxels(host, 1);
  expect(cropped).toBeLessThan(cut);
  await expect.poll(() => maskVoxels(guest, 1)).toBe(cropped);
  expect(await dump(guest)).toBe(await dump(host));

  // The guest's undo has nothing of the host's edits in it.
  expect(await store<boolean>(guest, 's.canUndo')).toBe(false);

  // The guest paints two slices and looks at the fill between them. The host sees the strokes and no more.
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-20, 90], [20, 90]);
  for (let i = 0; i < 4; i++) await guest.keyboard.press('ArrowDown');
  await drag(guest, 'axial', [-20, 90], [20, 90]);
  const strokes = await maskVoxels(guest, 1);
  expect(strokes).toBeGreaterThan(cropped);
  await expect.poll(() => maskVoxels(host, 1)).toBe(strokes);
  const painted = await dump(guest);
  expect(await dump(host)).toBe(painted);
  await guest.keyboard.press('i');
  await expect(guest.locator('.strip [role="status"]')).toBeVisible();
  await guest.waitForTimeout(1500);
  expect(await dump(guest)).toBe(painted);
  expect(await dump(host)).toBe(painted);
  await expect(host.locator('.strip [role="status"]')).toHaveCount(0);

  await guest.keyboard.press('Enter');
  const filled = await maskVoxels(guest, 1);
  expect(filled).toBeGreaterThan(strokes);
  await expect.poll(() => maskVoxels(host, 1)).toBe(filled);
  expect(await dump(host)).toBe(await dump(guest));
});
