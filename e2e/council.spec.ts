import { expect, test, type Page } from '@playwright/test';
import { formatVoxels } from '../src/mask/ops';
import { choose, clickVoxel, countVoxels, drag, maskDump, maskVoxels, openPhantom, trace, voxelOnPage } from './helpers';

/** How a toast writes a number of voxels of the phantom, whose voxels are 1 mm each way. */
const size = (voxels: number) => formatVoxels(voxels, [1, 1, 1]);

/* Fixes from the council review of 0.1.2 (docs/reviews/0.1.2-council.md). */

const menuItem = async (page: Page, segment: string, item: string) => {
  await page.locator('.segrow', { hasText: segment }).hover();
  await page.getByRole('button', { name: `More for ${segment}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

test("a toast's Undo goes away once a newer edit is made, so it never undoes another step", async ({ page }) => {
  await openPhantom(page);
  const two = await maskVoxels(page, 2);
  await menuItem(page, 'Segment 2', 'Clear');
  const cleared = page.locator('.toast', { hasText: 'Segment 2 cleared' });
  await expect(cleared.getByRole('button', { name: 'Undo' })).toBeVisible();

  // A newer step, while the first toast is still up.
  const one = await maskVoxels(page, 1);
  await menuItem(page, 'Segment 1', 'Clear');
  const newer = page.locator('.toast', { hasText: 'Segment 1 cleared' });
  await expect(newer.getByRole('button', { name: 'Undo' })).toBeVisible();
  // The older message stays; its Undo does not, because Undo would now take the newer step.
  await expect(cleared).toBeVisible();
  await expect(cleared.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(cleared.getByRole('button', { name: 'Dismiss' })).toBeVisible();

  await newer.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => maskVoxels(page, 1)).toBe(one);
  expect(await maskVoxels(page, 2)).toBe(0);
  // The older step is still there from the keyboard.
  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page, 2)).toBe(two);
});

test("a toast's Undo goes away when its step is undone from the keyboard", async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  const painted = await maskVoxels(page, 1);
  await menuItem(page, 'Segment 2', 'Clear');
  const undo = page.locator('.toast', { hasText: 'Segment 2 cleared' }).getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(undo).toHaveCount(0);
  // The stroke before it is untouched.
  expect(await maskVoxels(page, 1)).toBe(painted);
});

test('a toast stays while the pointer is over it or focus is inside it', async ({ page }) => {
  await openPhantom(page);
  await menuItem(page, 'Segment 2', 'Clear');
  const toast = page.locator('.toast', { hasText: 'Segment 2 cleared' });
  await toast.hover();
  // Longer than the six seconds a toast with an action lasts.
  await page.waitForTimeout(7000);
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  // Focus keeps it too, after the pointer has gone.
  await toast.getByRole('button', { name: 'Undo' }).focus();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(7000);
  await expect(toast).toBeVisible();
  // With neither it runs out.
  await toast.getByRole('button', { name: 'Undo' }).blur();
  await expect(toast).toHaveCount(0, { timeout: 7000 });
});

test('undo during a fill preview cancels the preview before it undoes', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const one = await maskVoxels(page, 1);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const two = await maskVoxels(page, 1);
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toContainText('Preview:');

  await page.keyboard.press('Control+z');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'Fill preview cancelled.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
  expect(await maskVoxels(page, 1)).toBe(one);

  // Redo does the same.
  await page.keyboard.press('i');
  // One painted slice is nothing to fill between, so no preview is offered.
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await maskVoxels(page, 1)).toBe(two);
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toContainText('Preview:');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page, 1)).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toContainText('Preview:');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await maskVoxels(page, 1)).toBe(two);
});

test('erase outside on one slice says what it took when part of it was out of view', async ({ page }) => {
  await openPhantom(page);
  // A stray piece of segment 1 on the same slice, far from the rest.
  await page.keyboard.press('b');
  await trace(page, 'axial', [[8, 42, 24], [14, 42, 24]]);
  const stray = await countVoxels(page, 'v === 1 && y > 36');
  expect(stray).toBeGreaterThan(20);
  const before = await maskDump(page);
  const onSlice = await countVoxels(page, 'v === 1 && z === 24');

  await page.keyboard.press('s');
  await choose(page, 'Scissors action', 'Erase outside');
  await choose(page, 'Scissors depth', 'This slice');

  // With the whole slice in view the cut is plain to see, so it stays quiet.
  await trace(page, 'axial', [[20, 12, 24], [42, 34, 24]]);
  expect(await countVoxels(page, 'v === 1 && y > 36')).toBe(0);
  await expect(page.locator('.toast', { hasText: 'Erased' })).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await maskDump(page)).toBe(before);

  // Zoomed in on the segment, the stray piece is off screen.
  const box = (await page.locator('[data-view="axial"] canvas').first().boundingBox())!;
  const [cx, cy] = await voxelOnPage(page, 'axial', [30, 22, 24]);
  await page.evaluate((at) => window.__w.engine.zoomBy('axial', 4, at), [cx - box.x, cy - box.y]);
  await page.waitForTimeout(300);
  const [sx, sy] = await voxelOnPage(page, 'axial', [11, 42, 24]);
  expect(sx < box.x || sx > box.x + box.width || sy < box.y || sy > box.y + box.height).toBe(true);

  await trace(page, 'axial', [[27.5, 19.5, 24], [32.5, 24.5, 24]]);
  const left = await countVoxels(page, 'v === 1 && z === 24');
  expect(await countVoxels(page, 'v === 1 && y > 36')).toBe(0);
  const toast = page.locator('.toast', { hasText: `Erased ${size(onSlice - left)} of Segment 1 on this slice, some of it outside the view` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => maskDump(page)).toBe(before);
});

test('Remove island on a segment in one piece says that the whole segment went', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  const before = await maskDump(page);
  await page.keyboard.press('f');
  await choose(page, 'Fill action', 'Remove island');
  await expect(page.locator('.strip .hint')).toHaveText('Click a piece of the segment to remove it. A segment in one piece is removed whole.');
  await clickVoxel(page, 'axial', [30, 22, 24]);
  expect(await maskVoxels(page, 1)).toBe(0);
  const toast = page.locator('.toast', { hasText: `Removed all of Segment 1, ${size(one)}. It was one island.` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => maskDump(page)).toBe(before);
});
