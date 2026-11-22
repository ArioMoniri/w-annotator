import { expect, test, type Page } from '@playwright/test';
import { SEGMENT_1, drag, jumpToVoxel, maskVoxels, openPhantom, pixelAt, isTinted, skipTour } from './helpers';

/** A 48³ NIfTI label volume with one ball, built in the page like the phantom. */
async function ballFile(page: Page, _name: string, centre: [number, number, number], radius: number, label = 1): Promise<number[]> {
  return page.evaluate(
    ({ centre, radius, label }) => {
      const n = 48;
      const data = new Uint8Array(n * n * n);
      for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) if (Math.hypot(x - centre[0], y - centre[1], z - centre[2]) < radius) data[z * n * n + y * n + x] = label;
      const buf = new ArrayBuffer(352 + data.byteLength);
      const v = new DataView(buf);
      v.setInt32(0, 348, true);
      v.setInt16(40, 3, true);
      [n, n, n].forEach((d, i) => v.setInt16(42 + i * 2, d, true));
      v.setInt16(70, 2, true);
      v.setInt16(72, 8, true);
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
      new Uint8Array(buf, 352).set(data);
      return Array.from(new Uint8Array(buf));
    },
    { centre, radius, label },
  );
}

/** Opens a ball mask the way Open mask does. */
async function openBall(page: Page, name: string, centre: [number, number, number], radius: number): Promise<void> {
  const bytes = await ballFile(page, name, centre, radius);
  await page.evaluate(
    async ({ name, bytes }) => {
      await window.__w.session.openFiles([{ name, bytes: new Uint8Array(bytes) }], 'mask');
    },
    { name, bytes },
  );
  await page.waitForTimeout(500);
}

/** Pixels of a view that are close to white: the outline of a comparison mask once the image is windowed to grey. */
async function whitePixels(page: Page, view: string): Promise<number> {
  return page.evaluate((view) => {
    const canvas = document.querySelector(`[data-view="${view}"] canvas`) as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.min(px[i], px[i + 1], px[i + 2]) > 235) n++;
    return n;
  }, view);
}

/** The brightest the image gets is mid grey, so nothing of it counts as white. */
async function greyWindow(page: Page): Promise<void> {
  await page.evaluate(() => window.__w.session.setVoi(-1000, 2000));
  await page.waitForTimeout(300);
}

const rows = (page: Page) => page.locator('.filerow');
const row = (page: Page, label: string) => page.locator('.filerow', { hasText: label });
const radio = (page: Page, label: string) => page.getByRole('radio', { name: `Edit ${label}` });

test('the Files section lists the image and its mask', async ({ page }) => {
  await openPhantom(page);
  const files = page.getByRole('region', { name: 'Files' });
  await expect(files).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toHaveAttribute('data-kind', 'image');
  await expect(rows(page).nth(0)).toContainText('phantom_ct');
  await expect(rows(page).nth(1)).toContainText('phantom_seg');
  await expect(radio(page, 'phantom_seg')).toBeChecked();
  // Full name and size are in the tooltip.
  await expect(rows(page).nth(0).locator('.name')).toHaveAttribute('title', 'phantom_ct.nii\n48 × 48 × 48');

  // The section folds away and comes back.
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Files' })).toContainText('2');
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(rows(page)).toHaveCount(2);
});

test('an image without a mask lists a new, empty mask to paint on', async ({ page }) => {
  await openPhantom(page, false);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('New mask');
  await expect(radio(page, 'New mask')).toBeChecked();
  // Opening a mask file takes the place of the untouched empty one.
  await openBall(page, 'liver_seg.nii', [24, 24, 24], 6);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('liver_seg');
});

test('a second mask is edited while the first stays as an outline for comparison', async ({ page }) => {
  await openPhantom(page);
  await greyWindow(page);
  await jumpToVoxel(page, SEGMENT_1);
  await page.waitForTimeout(400);
  expect(await whitePixels(page, 'axial')).toBe(0);
  expect(isTinted(await pixelAt(page, 'axial', SEGMENT_1))).toBe(true);

  await openBall(page, 'corrected_seg.nii', [24, 34, 24], 5);
  await expect(rows(page)).toHaveCount(3);
  await expect(radio(page, 'corrected_seg')).toBeChecked();
  await expect(radio(page, 'phantom_seg')).not.toBeChecked();
  await expect(page.locator('.segrow')).toHaveCount(1);

  // The first mask is now a white outline with no fill: its middle shows the grey image.
  expect(await whitePixels(page, 'axial')).toBeGreaterThan(20);
  expect(isTinted(await pixelAt(page, 'axial', SEGMENT_1))).toBe(false);
  // The mask being edited is filled in its segment colour.
  await jumpToVoxel(page, [24, 34, 24]);
  await page.waitForTimeout(400);
  expect(isTinted(await pixelAt(page, 'axial', [24, 34, 24]))).toBe(true);
});

test('hiding a comparison mask removes its outline and showing it brings it back', async ({ page }) => {
  await openPhantom(page);
  await greyWindow(page);
  await openBall(page, 'corrected_seg.nii', [24, 34, 24], 5);
  await jumpToVoxel(page, SEGMENT_1);
  await page.waitForTimeout(400);
  const shown = await whitePixels(page, 'axial');
  expect(shown).toBeGreaterThan(20);

  await row(page, 'phantom_seg').hover();
  await row(page, 'phantom_seg').getByRole('button', { name: 'Hide' }).click();
  await page.waitForTimeout(400);
  expect(await whitePixels(page, 'axial')).toBe(0);
  await expect(row(page, 'phantom_seg')).toHaveAttribute('data-hidden', 'true');

  await row(page, 'phantom_seg').getByRole('button', { name: 'Show' }).click();
  await page.waitForTimeout(400);
  expect(await whitePixels(page, 'axial')).toBe(shown);

  // The eye on the active mask is the same switch as the shortcut (X).
  await jumpToVoxel(page, [24, 34, 24]);
  await page.waitForTimeout(300);
  await row(page, 'corrected_seg').hover();
  await row(page, 'corrected_seg').getByRole('button', { name: 'Hide' }).click();
  await page.waitForTimeout(400);
  expect(isTinted(await pixelAt(page, 'axial', [24, 34, 24]))).toBe(false);
  await page.keyboard.press('x');
  await page.waitForTimeout(400);
  expect(isTinted(await pixelAt(page, 'axial', [24, 34, 24]))).toBe(true);
});

test('the image cannot be hidden, only dimmed', async ({ page }) => {
  await openPhantom(page, false);
  await greyWindow(page);
  const centre: [number, number, number] = [24, 24, 24];
  await jumpToVoxel(page, centre);
  await page.waitForTimeout(400);
  const full = (await pixelAt(page, 'axial', centre))[0];
  const imageRow = rows(page).nth(0);
  await imageRow.hover();
  await expect(imageRow.getByRole('button', { name: 'Hide' })).toHaveCount(0);
  await imageRow.getByRole('button', { name: 'Dim image' }).click();
  await page.waitForTimeout(400);
  const dimmed = (await pixelAt(page, 'axial', centre))[0];
  expect(dimmed).toBeLessThan(full * 0.7);
  expect(dimmed).toBeGreaterThan(0);
  await imageRow.getByRole('button', { name: 'Show image at full brightness' }).click();
  await page.waitForTimeout(400);
  expect((await pixelAt(page, 'axial', centre))[0]).toBe(full);
});

test('switching the active mask swaps the segments list and the undo history', async ({ page }) => {
  await openPhantom(page);
  const phantomVoxels = await maskVoxels(page);
  expect(phantomVoxels).toBeGreaterThan(0);
  await openBall(page, 'corrected_seg.nii', [24, 34, 24], 5);
  await expect(page.locator('.segrow')).toHaveCount(1);
  const undo = page.getByRole('button', { name: /^Undo/ });

  // Paint on the mask being edited.
  await jumpToVoxel(page, [24, 24, 24]);
  await page.keyboard.press('b');
  const before = await maskVoxels(page);
  await drag(page, 'axial', [-30, 60], [30, 60]);
  const painted = await maskVoxels(page);
  expect(painted).toBeGreaterThan(before);
  await expect(undo).toBeEnabled();
  await expect(row(page, 'corrected_seg').getByRole('img', { name: 'Unsaved changes' })).toBeVisible();

  // The other mask has its own two segments, nothing to undo, and no unsaved edits.
  await radio(page, 'phantom_seg').click();
  await page.waitForTimeout(500);
  await expect(radio(page, 'phantom_seg')).toBeChecked();
  await expect(page.locator('.segrow')).toHaveCount(2);
  await expect(undo).toBeDisabled();
  expect(await maskVoxels(page)).toBe(phantomVoxels);
  // Undo does nothing to this mask, and nothing to the one left behind.
  await page.keyboard.press('Control+z');
  expect(await maskVoxels(page)).toBe(phantomVoxels);
  // The painted mask still shows as unsaved in the list.
  await expect(row(page, 'corrected_seg').getByRole('img', { name: 'Unsaved changes' })).toBeVisible();
  await expect(row(page, 'phantom_seg').getByRole('img', { name: 'Unsaved changes' })).toHaveCount(0);

  // Back on the first: its stroke is still there and can be undone.
  await row(page, 'corrected_seg').hover();
  await row(page, 'corrected_seg').getByRole('button', { name: 'More for corrected_seg' }).click();
  await page.getByRole('menuitem', { name: 'Make active' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('.segrow')).toHaveCount(1);
  expect(await maskVoxels(page)).toBe(painted);
  await expect(undo).toBeEnabled();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  expect(await maskVoxels(page)).toBe(before);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  expect(await maskVoxels(page)).toBe(painted);
});

test('closing a mask asks about unsaved edits and always leaves one to edit', async ({ page }) => {
  await openPhantom(page);
  await openBall(page, 'corrected_seg.nii', [24, 34, 24], 5);
  // Make an unsaved edit on the active mask.
  await page.evaluate(() => window.__w.session.clearSegment(1));
  await expect(row(page, 'corrected_seg').getByRole('img', { name: 'Unsaved changes' })).toBeVisible();

  await row(page, 'corrected_seg').hover();
  await row(page, 'corrected_seg').getByRole('button', { name: 'More for corrected_seg' }).click();
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save changes to corrected_seg.nii?' })).toBeVisible();
  await page.getByRole('button', { name: "Don't save" }).click();
  await page.waitForTimeout(400);

  // The other mask takes over.
  await expect(rows(page)).toHaveCount(2);
  await expect(radio(page, 'phantom_seg')).toBeChecked();
  await expect(page.locator('.segrow')).toHaveCount(2);

  // Closing the last mask leaves a new, empty one.
  await row(page, 'phantom_seg').hover();
  await row(page, 'phantom_seg').getByRole('button', { name: 'More for phantom_seg' }).click();
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(400);
  await expect(rows(page)).toHaveCount(2);
  await expect(radio(page, 'New mask')).toBeChecked();
  await expect(page.locator('.segrow')).toHaveCount(0);
  expect(await maskVoxels(page)).toBe(0);
});

test('a comparison mask can be saved from its row', async ({ page }) => {
  await openPhantom(page);
  await openBall(page, 'corrected_seg.nii', [24, 34, 24], 5);
  await row(page, 'phantom_seg').hover();
  await row(page, 'phantom_seg').getByRole('button', { name: 'More for phantom_seg' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Save…' }).click();
  expect((await download).suggestedFilename()).toBe('phantom_seg.nii');
  // The mask being edited was not the one saved.
  await expect(radio(page, 'corrected_seg')).toBeChecked();
});

test('no more than four masks are open at once', async ({ page }) => {
  await openPhantom(page);
  for (const n of [2, 3, 4]) await openBall(page, `m${n}_seg.nii`, [10 + n * 5, 34, 24], 3);
  await expect(rows(page)).toHaveCount(5);
  await openBall(page, 'm5_seg.nii', [24, 10, 24], 3);
  await expect(page.getByText('Up to 4 masks can be open at once. Close one in Files to add another.')).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  await expect(radio(page, 'm4_seg')).toBeChecked();
});

test('an image and its mask opened together become a pair, whatever the order', async ({ page }) => {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const seg = await ballFile(page, 'liver_seg.nii', [24, 24, 24], 6);
  await page.evaluate(async (seg) => {
    const n = 48;
    const img = new Int16Array(n * n * n).fill(-1000);
    for (let i = 0; i < img.length; i += 7) img[i] = 40;
    // A MetaImage header in front of the voxels.
    const header = `ObjectType = Image\nNDims = 3\nTransformMatrix = -1 0 0 0 -1 0 0 0 1\nOffset = 0 0 0\nDimSize = ${n} ${n} ${n}\nElementSpacing = 1 1 1\nElementType = MET_SHORT\nElementDataFile = LOCAL\n`;
    const head = new TextEncoder().encode(header);
    const bytes = new Uint8Array(head.length + img.byteLength);
    bytes.set(head);
    bytes.set(new Uint8Array(img.buffer), head.length);
    // The mask comes first, as it may when two files are chosen and opened with the app.
    await window.__w.session.openFiles([
      { name: 'liver_seg.nii', bytes: new Uint8Array(seg) },
      { name: 'liver ct.mha', bytes },
    ]);
  }, seg);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toHaveAttribute('data-kind', 'image');
  await expect(rows(page).nth(0)).toContainText('liver ct');
  await expect(rows(page).nth(1)).toContainText('liver_seg');
  await expect(radio(page, 'liver_seg')).toBeChecked();
  expect(await maskVoxels(page)).toBeGreaterThan(0);
});

/** Drags a file over the window and, with `drop`, lets it go: a synthetic HTML5 drag, as a browser makes it. */
async function dragFile(page: Page, name: string, bytes: number[], steps: ('enter' | 'drop' | 'leave')[]): Promise<void> {
  await page.evaluate(
    ({ name, bytes, steps }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name));
      const fire = (type: string) => window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      for (const step of steps) {
        if (step === 'enter') {
          fire('dragenter');
          fire('dragover');
        } else if (step === 'drop') fire('drop');
        else fire('dragleave');
      }
    },
    { name, bytes, steps },
  );
}

test('the drop overlay says what a drop will do', async ({ page }) => {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const seg = await ballFile(page, 'x', [24, 34, 24], 5);
  // Nothing open: the drop zone itself says it.
  await dragFile(page, 'ct_seg.nii', seg, ['enter']);
  await expect(page.getByRole('heading', { name: 'Drop to open' })).toBeVisible();
  await dragFile(page, 'ct_seg.nii', seg, ['leave']);
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();

  // An image is open. A browser does not tell file names before the drop, so the overlay stays neutral.
  await openPhantom(page);
  await dragFile(page, 'second_seg.nii', seg, ['enter']);
  await expect(page.locator('.dropveil')).toHaveText('Drop to add');
  await dragFile(page, 'second_seg.nii', seg, ['leave']);
  await expect(page.locator('.dropveil')).toHaveCount(0);
});

test('a mask dropped on an open image is added as a mask', async ({ page }) => {
  await openPhantom(page, false);
  const seg = await ballFile(page, 'x', [24, 34, 24], 5);
  await dragFile(page, 'dropped_seg.nii', seg, ['enter', 'drop']);
  await expect(page.locator('.dropveil')).toHaveCount(0);
  await expect(row(page, 'dropped_seg')).toBeVisible();
  await expect(radio(page, 'dropped_seg')).toBeChecked();
  await expect(rows(page).nth(0)).toContainText('phantom_ct');
  expect(await maskVoxels(page)).toBeGreaterThan(0);
});

test('a second image dropped on an open one asks before replacing', async ({ page }) => {
  await openPhantom(page);
  const second = await page.evaluate(() => {
    const n = 48;
    const img = new Int16Array(n * n * n).fill(-1000);
    const header = `ObjectType = Image\nNDims = 3\nTransformMatrix = -1 0 0 0 -1 0 0 0 1\nOffset = 0 0 0\nDimSize = ${n} ${n} ${n}\nElementSpacing = 1 1 1\nElementType = MET_SHORT\nElementDataFile = LOCAL\n`;
    const head = new TextEncoder().encode(header);
    const bytes = new Uint8Array(head.length + img.byteLength);
    bytes.set(head);
    bytes.set(new Uint8Array(img.buffer), head.length);
    return Array.from(bytes);
  });
  await dragFile(page, 'follow_up.mha', second, ['enter', 'drop']);
  await expect(page.getByRole('heading', { name: 'Replace the current image?' })).toBeVisible();
  await expect(page.getByText('follow_up.mha will open in place of phantom_ct.nii.')).toBeVisible();
  // Cancel keeps everything as it was.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows(page).nth(0)).toContainText('phantom_ct');
  await expect(rows(page)).toHaveCount(2);

  await dragFile(page, 'follow_up.mha', second, ['enter', 'drop']);
  await page.getByRole('button', { name: 'Replace' }).click();
  await expect(rows(page).nth(0)).toContainText('follow_up');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('New mask');
});
