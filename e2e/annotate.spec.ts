import { expect, test } from '@playwright/test';
import { SEGMENT_1, SEGMENT_2, drag, isTinted, jumpToVoxel, maskVoxels, openPhantom, pixelAt } from './helpers';

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

test('the shortcut list opens with ?', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  // The list lives in Settings now, under Shortcuts.
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('fill between slices joins two painted slices', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const one = await maskVoxels(page, 1);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  const two = await maskVoxels(page, 1);
  expect(two).toBeGreaterThan(one);
  // The fill is shown first; nothing is written until it is applied.
  await page.getByRole('button', { name: 'Fill between slices' }).click();
  expect(await maskVoxels(page, 1)).toBe(two);
  await page.getByRole('button', { name: 'Apply' }).click();
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

test('crosshair click moves the other views to that point', async ({ page }) => {
  await openPhantom(page);
  const slice = async (view: string) => (await page.locator(`[data-view="${view}"] .overlay.bl`).textContent())!;
  const before = [await slice('sagittal'), await slice('coronal')];
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + 50, box.y + box.height / 2 + 40);
  await expect.poll(() => slice('sagittal')).not.toBe(before[0]);
  await expect.poll(() => slice('coronal')).not.toBe(before[1]);
});

test('opacity, outline and hiding a segment repaint the overlay', async ({ page }) => {
  await openPhantom(page);
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  // A point inside segment 1 of the phantom (voxel 30,22 of 48, shown at the centre slice).
  const state = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    const img = w.session.getImage();
    return { dims: img.dims };
  });
  expect(state.dims[0]).toBe(48);
  const shot = async () => {
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    return png.toString('base64');
  };
  const filled = await shot();
  await page.keyboard.press('x');
  await page.waitForTimeout(500);
  const hidden = await shot();
  expect(hidden).not.toBe(filled);
  await page.keyboard.press('x');
  await page.waitForTimeout(500);
  await page.keyboard.press('o');
  await page.waitForTimeout(500);
  const outline = await shot();
  expect(outline).not.toBe(filled);
  expect(outline).not.toBe(hidden);
  await page.keyboard.press('o');
  await page.locator('.segrow').first().hover();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.mouse.move(box.x + 5, box.y + box.height - 5);
  await page.waitForTimeout(500);
  const oneHidden = await shot();
  expect(oneHidden).not.toBe(filled);

  // Hiding the second segment: its colour goes at a point inside it, segment 1 stays.
  await page.locator('.segrow').first().getByRole('button', { name: 'Show', exact: true }).click();
  await jumpToVoxel(page, SEGMENT_2);
  const one: [number, number, number] = [SEGMENT_1[0], SEGMENT_1[1], SEGMENT_2[2]];
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(true);
  expect(isTinted(await pixelAt(page, 'axial', one))).toBe(true);
  await page.locator('.segrow').nth(1).hover();
  await page.locator('.segrow').nth(1).getByRole('button', { name: 'Hide', exact: true }).click();
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(false);
  expect(isTinted(await pixelAt(page, 'sagittal', SEGMENT_2))).toBe(false);
  expect(isTinted(await pixelAt(page, 'axial', one))).toBe(true);
  await page.locator('.segrow').nth(1).getByRole('button', { name: 'Show', exact: true }).click();
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(true);
});

test('show only this hides every other segment, and again brings them back', async ({ page }) => {
  await openPhantom(page);
  await jumpToVoxel(page, SEGMENT_2);
  const one: [number, number, number] = [SEGMENT_1[0], SEGMENT_1[1], SEGMENT_2[2]];
  const only = async (n: number) => {
    await page.locator('.segrow').nth(n - 1).hover();
    await page.getByRole('button', { name: `More for Segment ${n}` }).click();
    await page.getByRole('menuitem', { name: 'Show only this' }).click();
  };
  await only(2);
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', one))).toBe(false);
  expect(isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(true);
  await only(1);
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(false);
  expect(isTinted(await pixelAt(page, 'axial', one))).toBe(true);
  await only(1);
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(true);
  expect(isTinted(await pixelAt(page, 'axial', one))).toBe(true);
});

test('shift-drag erases with the brush', async ({ page }) => {
  await openPhantom(page);
  const before = await maskVoxels(page);
  await page.keyboard.press('b');
  await page.keyboard.press(']');
  await page.keyboard.down('Shift');
  await drag(page, 'axial', [30, -20], [70, -10]);
  await page.keyboard.up('Shift');
  expect(await maskVoxels(page)).toBeLessThan(before);
});

test('a mask stored in another axis order lands on the same anatomy', async ({ page }) => {
  await openPhantom(page);
  const reference = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Array.from((window as any).__w.session.getMask().data as Uint8Array);
  });
  // The same mask, saved with x and y flipped and the affine flipped to match.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    const src = w.session.getMask().data as Uint8Array;
    const n = 48;
    const flipped = new Uint8Array(src.length);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) flipped[z * n * n + (n - 1 - y) * n + (n - 1 - x)] = src[z * n * n + y * n + x];
    const buf = new ArrayBuffer(352 + flipped.length);
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
      [-1, 0, 0, n - 1],
      [0, -1, 0, n - 1],
      [0, 0, 1, 0],
    ].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + r * 16 + c * 4, x, true)));
    new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
    new Uint8Array(buf, 352).set(flipped);
    await w.session.openFiles([{ name: 'flipped_seg.nii', bytes: new Uint8Array(buf) }], 'mask');
  });
  const loaded = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Array.from((window as any).__w.session.getMask().data as Uint8Array);
  });
  expect(loaded).toEqual(reference);
});

test('threshold brush paints only where the image is inside the range', async ({ page }) => {
  await openPhantom(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await page.keyboard.press('t');
  // The phantom is 300 at the centre, falls off with radius, and is -1000 outside.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.session.setToolOption({ threshold: [200, 400] }));
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await drag(page, 'axial', [-150, 0], [150, 0]);
  const result = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    const img = w.session.getImage().data as Int16Array;
    const msk = w.session.getMask().data as Uint8Array;
    let painted = 0;
    let outside = 0;
    for (let i = 0; i < msk.length; i++) {
      if (!msk[i]) continue;
      painted++;
      if (img[i] < 200 || img[i] > 400) outside++;
    }
    return { painted, outside };
  });
  expect(result.painted).toBeGreaterThan(0);
  expect(result.outside).toBe(0);
});

test('zoom and window still work after using pan', async ({ page }) => {
  await openPhantom(page);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const read = () => page.evaluate(() => { const s = (window as any).__w.store.getState(); return { zoom: s.zoom, w: s.voi.upper - s.voi.lower }; });
  await page.keyboard.press('h');
  await drag(page, 'axial', [0, 0], [30, 20]);
  const start = await read();
  await page.keyboard.press('z');
  await drag(page, 'axial', [0, 0], [0, -80]);
  const zoomed = await read();
  expect(zoomed.zoom).not.toBeCloseTo(start.zoom, 2);
  await page.keyboard.press('w');
  await drag(page, 'axial', [0, 0], [80, 0]);
  expect((await read()).w).not.toBeCloseTo(zoomed.w, 0);
});

test('undoing a segment delete brings back its name and colour', async ({ page }) => {
  await openPhantom(page);
  await page.locator('.segrow .name').first().dblclick();
  await page.getByLabel('Segment name').fill('Liver');
  await page.keyboard.press('Enter');
  await page.locator('.segrow').first().hover();
  await page.getByRole('button', { name: 'More for Liver' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.segrow')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.segrow').first()).toContainText('Liver');
});

test('a shortcut can be changed in Settings and is remembered', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await page.locator('[data-action="tool.brush"]').click();
  await expect(page.locator('[data-action="tool.brush"]')).toHaveText('Press keys…');
  await page.keyboard.press('q');
  await expect(page.locator('[data-action="tool.brush"]')).toHaveText('Q');
  // Taking a key that is in use leaves the other action without one.
  await page.locator('[data-action="tool.pan"]').click();
  await page.keyboard.press('e');
  await expect(page.locator('[data-action="tool.eraser"]')).toHaveText('—');
  // Settings apply as they are made; there is no Done button, only Close.
  await page.getByRole('button', { name: 'Close' }).click();

  await page.keyboard.press('b');
  await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('q');
  await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('e');
  await expect(page.locator('[data-tool="pan"]')).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.locator('[data-action="tool.brush"]')).toHaveText('Q');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.locator('[data-action="tool.brush"]')).toHaveText('B');
});

test('a mask saved as DICOM SEG reopens with the same voxels and names', async ({ page }) => {
  await openPhantom(page);
  await page.locator('.segrow .name').first().dblclick();
  await page.getByLabel('Segment name').fill('Liver');
  await page.keyboard.press('Enter');
  const before = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    w.store.setState({ maskName: 'phantom_seg.dcm' });
    return Array.from(w.session.getMask().data as Uint8Array).join('');
  });
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('phantom_seg.dcm');
  const bytes = Array.from(await (await import('node:fs/promises')).readFile((await file.path())!));
  // Clear the mask, then open the saved SEG as the mask again.
  await page.evaluate(async (bytes) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    w.session.deleteSegment(1);
    w.session.deleteSegment(2);
    await w.session.openFiles([{ name: 'reopened.dcm', bytes: new Uint8Array(bytes) }], 'mask');
  }, bytes);
  await expect(page.locator('.segrow').first()).toContainText('Liver');
  const after = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Array.from((window as any).__w.session.getMask().data as Uint8Array).join('');
  });
  expect(after).toBe(before);
});
