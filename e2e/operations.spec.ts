import { expect, test, type Page } from '@playwright/test';
import { copiedText, drag, maskVoxels, openPhantom } from './helpers';

const dump = (page: Page) =>
  page.evaluate(() => Array.from(window.__w.session.getMask().data as Uint8Array).join(''));

async function openMenu(page: Page, segment: string): Promise<void> {
  await page.locator('.segrow', { hasText: segment }).hover();
  await page.getByRole('button', { name: `More for ${segment}` }).click();
}

/** The voxel under a point of the axial view, given as an offset in pixels from its centre. */
async function voxelUnder(page: Page, dx: number, dy: number): Promise<[number, number, number]> {
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + dx - 3, box.y + box.height / 2 + dy);
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await page.waitForTimeout(80);
  return page.evaluate(() => window.__w.store.getState().hover.ijk as [number, number, number]);
}

/** Where a voxel column sits in the axial view, as an offset in pixels from its centre. */
async function axialOffset(page: Page, x: number, y: number): Promise<[number, number]> {
  const a = await voxelUnder(page, -80, -80);
  const b = await voxelUnder(page, 80, 80);
  const pxPerVoxelX = 160 / (b[0] - a[0]);
  const pxPerVoxelY = 160 / (b[1] - a[1]);
  return [-80 + (x - a[0]) * pxPerVoxelX, -80 + (y - a[1]) * pxPerVoxelY];
}

test('grow adds a margin in one step and undo restores the mask exactly', async ({ page }) => {
  await openPhantom(page);
  const before = await dump(page);
  const voxels = await maskVoxels(page, 1);
  const neighbour = await maskVoxels(page, 2);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Grow…' }).click();
  const ask = page.getByRole('dialog', { name: 'Grow Segment 1' });
  await ask.getByRole('textbox').fill('2');
  await ask.getByRole('button', { name: 'Apply' }).click();

  await expect(page.locator('.toast')).toContainText('Grew Segment 1 by 2 mm');
  const grown = await maskVoxels(page, 1);
  // A 5 mm ball grown by 2 mm is roughly a 7 mm ball.
  expect(grown).toBeGreaterThan(voxels * 2);
  expect(grown).toBeLessThan(voxels * 3.5);
  expect(await maskVoxels(page, 2)).toBe(neighbour);

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  expect(await dump(page)).toBe(before);

  // The field remembers the last value.
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Grow…' }).click();
  await ask.getByRole('textbox').fill('3.5');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Grow…' }).click();
  await expect(ask.getByRole('textbox')).toHaveValue('2');
});

test('shrink and smooth run from the menu, and a locked segment is refused', async ({ page }) => {
  await openPhantom(page);
  const voxels = await maskVoxels(page, 1);
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Shrink…' }).click();
  await page.getByRole('dialog', { name: 'Shrink Segment 1' }).getByRole('textbox').fill('1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText('Shrank Segment 1 by 1 mm');
  const shrunk = await maskVoxels(page, 1);
  expect(shrunk).toBeLessThan(voxels);
  expect(shrunk).toBeGreaterThan(0);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Smooth…' }).click();
  await page.getByRole('dialog', { name: 'Smooth Segment 1' }).getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.toast').last()).toContainText(/Smoothed Segment 1 by 2 mm|Segment 1 did not change/);

  await page.locator('.segrow', { hasText: 'Segment 2' }).hover();
  await page.locator('.segrow', { hasText: 'Segment 2' }).getByRole('button', { name: 'Lock' }).click();
  const locked = await dump(page);
  await openMenu(page, 'Segment 2');
  await page.getByRole('menuitem', { name: 'Keep largest island' }).click();
  await expect(page.locator('.toast').last()).toContainText('Segment 2 is locked. Unlock it to edit.');
  expect(await dump(page)).toBe(locked);
});

test('keep largest island removes a stray painted blob', async ({ page }) => {
  await openPhantom(page);
  const voxels = await maskVoxels(page, 1);
  // A short stroke in a corner, well away from both segments.
  const [x, y] = await axialOffset(page, 8, 9);
  await page.keyboard.press('b');
  await drag(page, 'axial', [x, y], [x + (await axialOffset(page, 12, 9))[0] - x, y]);
  const painted = await maskVoxels(page, 1);
  expect(painted).toBeGreaterThan(voxels);
  expect(painted - voxels).toBeLessThan(voxels);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Keep largest island' }).click();
  await expect(page.locator('.toast')).toContainText(`Removed ${painted - voxels} voxels outside the largest island of Segment 1`);
  expect(await maskVoxels(page, 1)).toBe(voxels);

  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page, 1)).toBe(painted);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Remove small islands…' }).click();
  await page.getByRole('dialog', { name: 'Remove small islands Segment 1' }).getByRole('textbox').fill('400');
  await page.keyboard.press('Enter');
  expect(await maskVoxels(page, 1)).toBe(voxels);
});

test('fill holes closes a cavity erased inside a segment', async ({ page }) => {
  await openPhantom(page);
  const voxels = await maskVoxels(page, 1);
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Go to segment' }).click();
  expect((await voxelUnder(page, 0, 0))[2]).toBe(24);
  await openMenu(page, 'Segment 2');
  await page.getByRole('menuitem', { name: 'Go to segment' }).click();
  expect((await voxelUnder(page, 0, 0))[2]).toBe(23);
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Go to segment' }).click();
  expect((await voxelUnder(page, 0, 0))[2]).toBe(24);

  await page.keyboard.press('e');
  await page.getByRole('group', { name: 'Brush shape' }).getByRole('button', { name: 'Sphere' }).click();
  await page.getByLabel('Brush size in millimetres').fill('4');
  await page.keyboard.press('Enter');
  const [x, y] = await axialOffset(page, 30, 22);
  await drag(page, 'axial', [x, y], [x + 2, y]);
  const hollow = await maskVoxels(page, 1);
  expect(hollow).toBeLessThan(voxels);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Fill holes' }).click();
  await expect(page.locator('.toast')).toContainText(`Filled ${voxels - hollow} voxels in Segment 1`);
  expect(await maskVoxels(page, 1)).toBe(voxels);

  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Fill holes' }).click();
  await expect(page.locator('.toast').last()).toContainText('No holes in Segment 1.');
});

test('each segment shows its volume, which follows the edits', async ({ page }) => {
  await openPhantom(page);
  const first = page.locator('.segrow').first().getByTestId('segment-volume');
  const second = page.locator('.segrow').nth(1).getByTestId('segment-volume');
  // The phantom has 1 mm voxels, so a voxel is a cubic millimetre.
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  await expect(first).toHaveText(`${one} mm³`);
  await expect(second).toHaveText(`${two} mm³`);

  await page.keyboard.press('b');
  await page.getByLabel('Brush size in millimetres').fill('20');
  await page.keyboard.press('Enter');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  const painted = await maskVoxels(page, 1);
  expect(painted).toBeGreaterThan(500);
  await expect(first).toHaveText(`${(painted / 1000).toFixed(1)} mL`);

  await openMenu(page, 'Segment 2');
  await page.getByRole('menuitem', { name: 'Measurements' }).click();
  const sheet = page.getByRole('dialog', { name: 'Measurements' });
  await expect(sheet.getByRole('row', { name: /Segment 2/ })).toContainText(`${await maskVoxels(page, 2)} mm³`);
  await expect(sheet.getByRole('row', { name: /Segment 2/ })).toContainText('±');
  const readCopied = await copiedText(page);
  await sheet.getByRole('button', { name: 'Copy as CSV' }).click();
  await expect(page.locator('.toast')).toContainText('Measurements copied');
  const csv = await readCopied();
  expect(csv.split('\n')[0]).toBe('Segment,Label,Volume (mL),Voxels,Mean,SD,Min,Max');
  const left = await maskVoxels(page, 2);
  expect(csv).toContain(`Segment 2,2,${left / 1000},${left},`);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
});

test('combine adds one segment into another as one undo step', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  await openMenu(page, 'Segment 1');
  await page.getByRole('menuitem', { name: 'Combine…' }).click();
  const ask = page.getByRole('dialog', { name: 'Combine with Segment 1' });
  await expect(ask.getByRole('combobox')).toHaveValue('2');
  await ask.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Added Segment 2 to Segment 1');
  expect(await maskVoxels(page, 1)).toBe(one + two);
  expect(await maskVoxels(page, 2)).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page, 2)).toBe(two);
});

test('paint over "Empty only" leaves the neighbouring segment alone', async ({ page }) => {
  await openPhantom(page);
  const one = await maskVoxels(page, 1);
  const two = await maskVoxels(page, 2);
  // Segment 2 is centred one slice below the middle; its outline still crosses the middle slice.
  const [x, y] = await axialOffset(page, 17, 27);
  await page.keyboard.press('b');
  await page.getByRole('group', { name: 'Paint over' }).getByRole('button', { name: 'Empty only' }).click();
  await drag(page, 'axial', [x - 60, y], [x + 60, y]);
  expect(await maskVoxels(page, 2)).toBe(two);
  const painted = await maskVoxels(page, 1);
  expect(painted).toBeGreaterThan(one);

  // One undo takes the whole stroke back, and nothing of segment 2 with it.
  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page, 1)).toBe(one);
  expect(await maskVoxels(page, 2)).toBe(two);

  // The same stroke with the default setting does paint over it.
  await page.getByRole('group', { name: 'Paint over' }).getByRole('button', { name: 'Everything' }).click();
  await drag(page, 'axial', [x - 60, y], [x + 60, y]);
  expect(await maskVoxels(page, 2)).toBeLessThan(two);
  expect(await maskVoxels(page, 1)).toBeGreaterThan(painted);
});

test('an operation made by one person appears for the other in a room', async ({ browser }) => {
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
  const before = await maskVoxels(host, 1);

  await openMenu(host, 'Segment 1');
  await host.getByRole('menuitem', { name: 'Grow…' }).click();
  await host.getByRole('dialog', { name: 'Grow Segment 1' }).getByRole('textbox').fill('2');
  await host.keyboard.press('Enter');
  const grown = await maskVoxels(host, 1);
  expect(grown).toBeGreaterThan(before);
  await expect.poll(() => maskVoxels(guest, 1)).toBe(grown);
  await expect.poll(async () => (await dump(guest)) === (await dump(host))).toBe(true);
  await expect(guest.locator('.segrow').first().getByTestId('segment-volume')).toHaveText(`${(grown / 1000).toFixed(1)} mL`);

  // The guest refines it further and the host follows; the host's undo then only takes back the host's step.
  await openMenu(guest, 'Segment 1');
  await guest.getByRole('menuitem', { name: 'Shrink…' }).click();
  await guest.getByRole('dialog', { name: 'Shrink Segment 1' }).getByRole('textbox').fill('1');
  await guest.keyboard.press('Enter');
  const shrunk = await maskVoxels(guest, 1);
  expect(shrunk).toBeLessThan(grown);
  await expect.poll(() => maskVoxels(host, 1)).toBe(shrunk);
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1024, height: 640 },
]) {
  test(`menu, popover, volumes and measurements fit at ${size.width} × ${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openPhantom(page);
    const shot = async (name: string) => {
      // Let the menu or sheet finish fading in.
      await page.waitForTimeout(350);
      await page.screenshot({ path: `test-results/operations/${name}-${size.width}.png` });
    };
    await page.keyboard.press('b');
    await expect(page.locator('.segrow').first().getByTestId('segment-volume')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Paint over' })).toBeVisible();
    // Nothing in the brush strip is cut off, also with a wider system font than this machine's.
    const overflow = () =>
      page.evaluate(() => {
        const options = document.querySelector('.strip .options')!;
        const strip = document.querySelector('.strip')!;
        return Math.max(options.scrollWidth - options.clientWidth, strip.scrollWidth - strip.clientWidth);
      });
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.addStyleTag({ content: '.strip { letter-spacing: 1px; }' });
    await page.setViewportSize({ width: size.width - 1, height: size.height });
    await page.waitForTimeout(200);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.setViewportSize(size);
    await shot('volumes');

    await openMenu(page, 'Segment 2');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(15);
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await shot('menu');

    await menu.getByRole('menuitem', { name: 'Remove small islands…' }).click();
    const ask = page.getByRole('dialog', { name: 'Remove small islands Segment 2' });
    await expect(ask.getByRole('textbox')).toBeFocused();
    await shot('popover');
    await ask.getByRole('textbox').fill('0');
    await expect(ask.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);

    await openMenu(page, 'Segment 2');
    await page.getByRole('menuitem', { name: 'Combine…' }).click();
    await shot('combine');
    await page.keyboard.press('Escape');

    await openMenu(page, 'Segment 2');
    await page.getByRole('menuitem', { name: 'Measurements' }).click();
    const sheet = page.getByRole('dialog', { name: 'Measurements' });
    await expect(sheet.getByRole('row')).toHaveCount(3);
    const sheetBox = (await sheet.boundingBox())!;
    expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(size.width);
    await shot('measurements');
  });
}
