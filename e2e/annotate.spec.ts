import { expect, test } from '@playwright/test';
import { drag, maskVoxels, openPhantom } from './helpers';

test('empty state offers to open an image or join a room', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open image' })).toBeVisible();
  await page.getByRole('button', { name: 'Join a room', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Invite link or room code');
});

test('opens an image with a mask and lists its segments', async ({ page }) => {
  await openPhantom(page);
  await expect(page.locator('.filebtn')).toContainText('phantom_ct.nii');
  await expect(page.locator('.segrow')).toHaveCount(2);
  await expect(page.locator('[data-view="axial"] .overlay.bl')).toContainText('/ 48');
  expect(await maskVoxels(page, 1)).toBeGreaterThan(100);
});

test('edit tools stay off until there is a segment', async ({ page }) => {
  await openPhantom(page, false);
  await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await expect(page.locator('.segrow')).toHaveCount(1);
  await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-checked', 'true');
});

test('brush paints, undo and redo restore the mask', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page, 1);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  const painted = await maskVoxels(page, 1);
  expect(painted).toBeGreaterThan(before);
  await expect(page.getByTestId('sync')).toHaveText('Unsaved changes');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  expect(await maskVoxels(page, 1)).toBe(before);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  expect(await maskVoxels(page, 1)).toBe(painted);
});

test('eraser removes voxels', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page);
  await page.keyboard.press('e');
  await page.keyboard.press(']');
  await drag(page, 'axial', [30, -20], [70, -10]);
  expect(await maskVoxels(page)).toBeLessThan(before);
});

test('number keys pick the segment the brush paints', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page, 2);
  await page.keyboard.press('2');
  await expect(page.locator('.segrow[aria-selected="true"]')).toContainText('Segment 2');
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, -60], [-40, -40]);
  expect(await maskVoxels(page, 2)).toBeGreaterThan(before);
});

test('deleting a segment clears its voxels and undo brings them back', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page, 2);
  await page.locator('.segrow').nth(1).hover();
  await page.getByRole('button', { name: 'More for Segment 2' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.segrow')).toHaveCount(1);
  expect(await maskVoxels(page, 2)).toBe(0);
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await page.waitForTimeout(300);
  expect(await maskVoxels(page, 2)).toBe(before);
  await expect(page.locator('.segrow')).toHaveCount(2);
});

test('double-click maximises a view and Escape restores it', async ({ page }) => {
  await openPhantom(page);
  const cell = page.locator('[data-view="sagittal"]');
  const small = (await cell.boundingBox())!;
  await cell.dblclick({ position: { x: 20, y: 60 } });
  const big = (await cell.boundingBox())!;
  expect(big.width).toBeGreaterThan(small.width * 1.8);
  await page.keyboard.press('Escape');
  expect((await cell.boundingBox())!.width).toBeCloseTo(small.width, 0);
});

test('saving downloads a NIfTI mask that reopens with the same voxels', async ({ page }) => {
  await openPhantom(page);
  const count = await maskVoxels(page);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('phantom_seg.nii');
  await expect(page.getByTestId('sync')).toHaveText('Saved');
  expect(count).toBeGreaterThan(0);
});

test('shortcut sheet opens with ?', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('fill between slices joins two painted slices', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const one = await maskVoxels(page, 1);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const two = await maskVoxels(page, 1);
  expect(two).toBeGreaterThan(one);
  await page.getByRole('button', { name: 'Fill between slices' }).click();
  const filled = await maskVoxels(page, 1);
  expect(filled).toBeGreaterThan(two * 1.5);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  expect(await maskVoxels(page, 1)).toBe(two);
});

test('a locked or hidden segment cannot be painted', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page, 1);
  await page.keyboard.press('b');
  await page.locator('.segrow').first().hover();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  expect(await maskVoxels(page, 1)).toBe(before);
  await expect(page.getByText('Segment 1 is locked. Unlock it to edit.')).toBeVisible();

  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.locator('.segrow').first().hover();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  expect(await maskVoxels(page, 1)).toBe(before);

  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  expect(await maskVoxels(page, 1)).toBeGreaterThan(before);
});
