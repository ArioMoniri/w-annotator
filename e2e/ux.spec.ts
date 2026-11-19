import { expect, test, type Page } from '@playwright/test';
import { SEGMENT_1, SEGMENT_2, drag, isTinted, jumpToVoxel, modLabel, openPhantom, pixelAt, tintedPixels } from './helpers';

const TEXT_1 = 'rgb(231, 233, 236)';
const WARN = 'rgb(229, 180, 84)';
const opacitySlider = (page: Page) => page.getByRole('slider', { name: 'Mask opacity' });
// The shortcut list is the Shortcuts section of Settings.
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const key = (page: Page, action: string) => page.locator(`[data-action="${action}"]`);
const help = (page: Page) => page.locator('.sheet-help');

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('X hides the whole mask, outlines included, and brings it back as it was', async ({ page }) => {
  await openPhantom(page);
  await jumpToVoxel(page, SEGMENT_2);
  await opacitySlider(page).fill('40');
  // Outline only: the fill is gone at the centre, the outlines are still drawn.
  await page.keyboard.press('o');
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(false);
  expect(await tintedPixels(page, 'axial')).toBeGreaterThan(20);

  await page.keyboard.press('x');
  await expect(page.getByTestId('mask-hidden')).toHaveText('Mask hidden');
  await expect(page.getByTestId('mask-hidden')).toHaveCSS('color', WARN);
  await expect.poll(() => tintedPixels(page, 'axial')).toBe(0);
  expect(await tintedPixels(page, 'sagittal')).toBe(0);
  await expect(opacitySlider(page)).toHaveValue('40');
  // Without outline-only the fill is off too.
  await page.keyboard.press('o');
  await page.waitForTimeout(300);
  expect(await tintedPixels(page, 'axial')).toBe(0);

  await page.keyboard.press('x');
  await expect(page.getByTestId('mask-hidden')).toHaveCount(0);
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(true);
  await expect(opacitySlider(page)).toHaveValue('40');
});

test('a segment hidden on its own stays hidden after the mask is hidden and shown', async ({ page }) => {
  await openPhantom(page);
  await jumpToVoxel(page, SEGMENT_2);
  await page.locator('.segrow').nth(1).hover();
  await page.locator('.segrow').nth(1).getByRole('button', { name: 'Hide', exact: true }).click();
  await page.keyboard.press('x');
  await page.keyboard.press('x');
  await expect.poll(async () => isTinted(await pixelAt(page, 'axial', [SEGMENT_1[0], SEGMENT_1[1], SEGMENT_2[2]]))).toBe(true);
  expect(isTinted(await pixelAt(page, 'axial', SEGMENT_2))).toBe(false);
});

test('Esc while choosing a key cancels the choice and keeps the sheet open', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await key(page, 'tool.brush').click();
  await expect(key(page, 'tool.brush')).toHaveText('Press keys…');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toBeVisible();
  await expect(key(page, 'tool.brush')).toHaveText('B');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
});

test('a fixed key is refused with a note, and Tab leaves the choice', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await key(page, 'tool.brush').click();
  await page.keyboard.press('1');
  await expect(help(page)).toHaveText("1 is fixed and can't be reassigned. Press other keys, or Esc to cancel.");
  await expect(key(page, 'tool.brush')).toHaveText('Press keys…');
  await page.keyboard.press('Tab');
  await expect(key(page, 'tool.brush')).toHaveText('B');
  await expect(key(page, 'tool.eraser')).toBeFocused();
});

test('taking a key from another action says so and can be undone', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  await key(page, 'tool.pan').click();
  await page.keyboard.press('Control+s');
  await expect(help(page)).toContainText(`${modLabel('S')} now selects Pan. Save mask has no shortcut.`);
  await expect(key(page, 'file.save')).toHaveText('—');
  await expect(key(page, 'file.save')).toHaveCSS('color', WARN);
  await help(page).getByRole('button', { name: 'Undo' }).click();
  await expect(key(page, 'file.save')).toHaveText(modLabel('S'));
  await expect(key(page, 'tool.pan')).toHaveText('H');

  await key(page, 'tool.pan').click();
  await page.keyboard.press('q');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(key(page, 'tool.pan')).toHaveText('H');
  // Reset is disabled now; focus moves to the section's tab instead of dropping to the page.
  await expect(page.getByRole('tab', { name: 'Shortcuts' })).toBeFocused();
});

test('tooltips and menu hints show the key an action is bound to now', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  for (const [action, press] of [
    ['mask.interpolate', 'q'],
    ['segment.new', 'j'],
    ['brush.smaller', 'k'],
    ['view.maximise', 'u'],
    ['file.save', 'Control+d'],
  ]) {
    await key(page, action).click();
    await page.keyboard.press(press);
  }
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);

  await page.keyboard.press('b');
  await expect(page.getByRole('button', { name: 'Fill between slices' })).toHaveAttribute('data-tip', /  Q$/);
  await expect(page.locator('.strip .field[data-tip^="Brush diameter"]')).toHaveAttribute('data-tip', 'Brush diameter  K  ]');
  await expect(page.locator('.panel header button')).toHaveAttribute('data-tip', 'Add segment  J');
  await expect(page.locator('[data-view="axial"]').getByRole('button', { name: 'Maximise' })).toHaveAttribute('data-tip', 'Maximise  U');
  await page.locator('.filebtn').click();
  await expect(page.getByRole('menuitem', { name: 'Save mask' }).locator('kbd')).toHaveText(modLabel('D'));
});

test('focus goes back to what opened a menu or dialog', async ({ page }) => {
  await openPhantom(page);
  await page.locator('.segrow').nth(1).hover();
  const more = page.getByRole('button', { name: 'More for Segment 2' });
  await more.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(more).toBeFocused();

  // Close with unsaved changes asks first; Cancel lands back on the file button.
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: 'Close' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.filebtn')).toBeFocused();
});

test('focus lands on the room pill when the room dialog is done', async ({ page }) => {
  await openPhantom(page);
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByPlaceholder('How others will see you').fill('Mina');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('room-pill')).toBeFocused();
});

test('right-click on a segment row opens its menu, and colours have names', async ({ page }) => {
  await openPhantom(page);
  await page.locator('.segrow').nth(1).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Change colour' }).click();
  await expect(page.getByRole('button', { name: 'Sky' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Vermilion' }).click();
  await expect(page.locator('.segrow').nth(1).locator('.swatch')).toHaveCSS('background-color', 'rgb(213, 94, 0)');
});

test('the status bar labels the size and shows HU only for CT-like values', async ({ page }) => {
  await openPhantom(page);
  await expect(page.locator('.status')).toContainText('Size 48 × 48 × 48');
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('value')).toHaveText(/^Value \d+$/);

  // Brighter than 300 with air at −1000 reads as CT.
  await openPhantom(page, true, 400);
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2);
  await expect(page.getByTestId('value')).toHaveText(/^Value \d+ HU$/);
});

test('unsaved changes stand out in the status bar', async ({ page }) => {
  await openPhantom(page);
  await expect(page.getByTestId('sync')).toHaveText('Saved');
  await expect(page.getByTestId('sync')).not.toHaveCSS('color', TEXT_1);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  await expect(page.getByTestId('sync')).toHaveText('Unsaved changes');
  await expect(page.getByTestId('sync')).toHaveCSS('color', TEXT_1);
});

test('a file that cannot be parsed is named, with what to do', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__w.session.openFiles([{ name: 'broken_scan.nii', bytes: new Uint8Array(400).fill(7) }]);
  });
  await expect(page.getByRole('alert')).toHaveText("Can't read broken_scan.nii. The file may be damaged or incomplete.");
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__w.session.openFiles([{ name: 'notes.txt', bytes: new Uint8Array(400).fill(65) }]);
  });
  await expect(page.getByRole('alert').last()).toContainText("Can't open notes.txt.");
});

test('the same message raised twice shows one toast', async ({ page }) => {
  await openPhantom(page);
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__w.session;
    s.setTool('brush');
    s.patchSegment(1, { locked: true });
    s.fillBetweenSlices();
    s.fillBetweenSlices();
  });
  await expect(page.locator('.toast')).toHaveCount(1);
});

test('only a row made with Add segment animates in', async ({ page }) => {
  await openPhantom(page);
  await expect(page.locator('.segrow')).toHaveCount(2);
  await expect(page.locator('.segrow.new')).toHaveCount(0);
  // Read on the next frame: the highlight is only there for 600 ms.
  const fresh = await page.evaluate(async () => {
    (document.querySelector('.panel header button') as HTMLElement).click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Array.from(document.querySelectorAll('.segrow.new')).map((row) => row.querySelector('.name')!.textContent);
  });
  expect(fresh).toEqual(['Segment 3']);
  await expect(page.locator('.segrow')).toHaveCount(3);
  await expect(page.locator('.segrow.new')).toHaveCount(0);
});

test('the active-tool bar moves to the chosen tool and the canvas has no animation', async ({ page }) => {
  await openPhantom(page);
  const barY = () =>
    page.evaluate(() => {
      const rail = document.querySelector('.rail')!;
      const matrix = new DOMMatrix(getComputedStyle(rail, '::before').transform);
      return Math.round(matrix.m42);
    });
  const top = async (tool: string) =>
    page.evaluate((tool) => (document.querySelector(`[data-tool="${tool}"]`) as HTMLElement).offsetTop + 10, tool);
  await expect.poll(barY).toBe(await top('crosshair'));
  await page.keyboard.press('b');
  await expect.poll(barY).toBe(await top('brush'));
  const canvasMotion = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cell, .cell .canvas, .cell canvas')).map((el) => {
      const s = getComputedStyle(el);
      return [s.animationName, s.transitionDuration];
    }),
  );
  for (const [animation, transition] of canvasMotion) {
    expect(animation).toBe('none');
    expect(transition).toBe('0s');
  }
});

test('the reduce-motion setting turns transitions off', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('w-annotator:settings', JSON.stringify({ reduceMotion: true, tourSeen: true })));
  await openPhantom(page);
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
  const fast = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-fast').trim());
  expect(fast).toBe('0ms');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).__w.store.setState({ roomModal: 'start' }));
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
});

for (const size of [
  { width: 1024, height: 640 },
  { width: 1280, height: 800 },
]) {
  test(`the shortcut list keeps its help line and reset button on screen at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openPhantom(page);
    await page.keyboard.press('?');
    for (const part of [sheet(page), help(page), page.getByRole('button', { name: 'Reset to defaults' }), sheet(page).getByRole('button', { name: 'Close' })]) {
      await expect(part).toBeInViewport({ ratio: 1 });
    }
    // The list scrolls on its own, from the top; the pane around it does not move.
    expect(await page.locator('.shortcuts').evaluate((el) => el.scrollTop)).toBe(0);
    expect(await page.locator('.shortcuts').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await page.locator('.modal.settings .pane').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    await expect(key(page, 'tool.brush')).toHaveCSS('height', '24px');
  });

  test(`no tool's options overflow the strip at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openPhantom(page);
    await page.locator('.segrow .name').first().dblclick();
    await page.getByLabel('Segment name').fill('Left ventricular myocardium, basal');
    await page.keyboard.press('Enter');
    for (const tool of ['crosshair', 'pan', 'zoom', 'window', 'measure', 'brush', 'eraser', 'threshold', 'scissors', 'fill']) {
      await page.locator(`[data-tool="${tool}"]`).click();
      await expect(page.locator(`.strip[data-strip="${tool}"]`)).toBeVisible();
      const fit = await page.locator('.strip').evaluate((strip) => {
        const edge = strip.getBoundingClientRect().right - 12;
        const chip = strip.querySelector('.chip')!.getBoundingClientRect();
        const options = strip.querySelector('.options')!;
        const last = options.lastElementChild?.getBoundingClientRect();
        // Hints may be cut short with an ellipsis; controls may not be cut at all.
        const controls = Array.from(options.querySelectorAll('button, input, select')).filter((el) => (el as HTMLElement).offsetParent);
        const cut = controls.filter((el) => el.getBoundingClientRect().right > chip.left - 4).length;
        return { chipInside: chip.right <= edge + 0.5, cut, lastRight: last?.right ?? 0, chipLeft: chip.left };
      });
      expect(fit, tool).toMatchObject({ chipInside: true, cut: 0 });
    }
  });
}

test('a pressed segmented button shows a focus ring', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const circle = page.getByRole('group', { name: 'Brush shape' }).getByRole('button', { name: 'Circle' });
  await page.getByRole('group', { name: 'Brush shape' }).getByRole('button', { name: 'Sphere' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(circle).toBeFocused();
  await expect(circle).toHaveAttribute('aria-pressed', 'true');
  expect(await circle.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
  expect(await circle.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/2px/);
});
