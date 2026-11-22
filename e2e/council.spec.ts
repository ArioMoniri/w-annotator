import { expect, test, type Page } from '@playwright/test';
import { formatVoxels } from '../src/mask/ops';
import { choose, clickVoxel, countVoxels, drag, maskDump, maskVoxels, openPhantom, skipTour, trace, voxelOnPage } from './helpers';

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

/** Opens a small image whose values run from 0 to 1, as a normalised MR or a probability map does. */
async function openUnitImage(page: Page): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(async () => {
    const n = 24;
    const img = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) img[(z * n + y) * n + x] = Math.max(0, 1 - Math.hypot(x - 12, y - 12, z - 12) / 12);
    const buf = new ArrayBuffer(352 + img.byteLength);
    const v = new DataView(buf);
    v.setInt32(0, 348, true);
    v.setInt16(40, 3, true);
    [n, n, n].forEach((d, i) => v.setInt16(42 + i * 2, d, true));
    v.setInt16(70, 16, true);
    v.setInt16(72, 32, true);
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
    await window.__w.session.openFiles([{ name: 'unit_mr.nii', bytes: new Uint8Array(buf) }]);
  });
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  await page.waitForTimeout(500);
}

test('the Window / Level strip sets a width under 1 on an image scaled 0 to 1', async ({ page }) => {
  await openUnitImage(page);
  expect(await page.evaluate(() => window.__w.store.getState().image.range)).toEqual([0, 1]);
  await page.keyboard.press('w');
  const width = page.getByLabel('Window width');
  const level = page.getByLabel('Window level');
  await level.fill('0.5');
  await level.press('Enter');
  await width.fill('0.2');
  await width.press('Enter');
  const voi = () => page.evaluate(() => window.__w.store.getState().voi as { lower: number; upper: number });
  await expect.poll(async () => (await voi()).lower).toBeCloseTo(0.4, 6);
  expect((await voi()).upper).toBeCloseTo(0.6, 6);
  await expect(width).toHaveValue('0.2');
  await expect(level).toHaveValue('0.5');
  await expect(page.getByTestId('status-window')).toHaveText(/W\s*0\.2\s*L\s*0\.5/);

  // The arrow keys move by a step that suits the image, not by 1.
  await width.focus();
  await width.press('ArrowUp');
  await expect(width).toHaveValue('0.21');
  await width.press('Shift+ArrowDown');
  await expect(width).toHaveValue('0.11');
  await expect.poll(async () => (await voi()).upper - (await voi()).lower).toBeCloseTo(0.11, 6);
  // Nothing narrower than one step.
  await width.fill('0');
  await width.press('Enter');
  await expect(width).toHaveValue('0.01');
});

/**
 * Contrast ratio (WCAG 2) of an element's text against what is drawn behind it, from the
 * colours the browser computed: backgrounds are laid over each other from the page up.
 */
const contrastOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/[\d.]+/g)!.map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
    };
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let bg = { r: 255, g: 255, b: 255 };
    for (const e of chain) {
      const c = parse(getComputedStyle(e).backgroundColor);
      bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
    }
    const t = parse(getComputedStyle(el).color);
    const fg = { r: t.r * t.a + bg.r * (1 - t.a), g: t.g * t.a + bg.g * (1 - t.a), b: t.b * t.a + bg.b * (1 - t.a) };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });

for (const scheme of ['dark', 'light'] as const) {
  test(`small numbers keep 4.5:1 on a row that is in use, focused or pointed at, in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openPhantom(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);

    // The segment number: on the active row, with and without the pointer on it, and on a row pointed at.
    await page.mouse.move(5, 5);
    expect(await contrastOf(page, '.segrow[aria-selected="true"] .idx')).toBeGreaterThanOrEqual(4.5);
    await page.locator('.segrow[aria-selected="true"]').hover();
    expect(await contrastOf(page, '.segrow[aria-selected="true"] .idx')).toBeGreaterThanOrEqual(4.5);
    await page.locator('.segrow[aria-selected="false"]').first().hover();
    expect(await contrastOf(page, '.segrow[aria-selected="false"] .idx')).toBeGreaterThanOrEqual(4.5);

    // W and L beside each window preset: the one in use, which also has the focus, one pointed at, and one at rest.
    await page.getByTestId('status-window').focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Window' });
    await expect(menu.locator('[aria-checked="true"]')).toBeFocused();
    expect(await contrastOf(page, '.menu [aria-checked="true"] .wl')).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('ArrowDown');
    expect(await contrastOf(page, '.menu .item:focus .wl')).toBeGreaterThanOrEqual(4.5);
    await menu.getByRole('menuitemradio').last().hover();
    expect(await contrastOf(page, '.menu .item:hover .wl')).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(page, '.menu [role="menuitemradio"]:not(:hover):not(:focus):not([aria-checked="true"]) .wl')).toBeGreaterThanOrEqual(4.5);
  });
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the view name and slice counter have a backing that keeps them readable over a white image, in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openPhantom(page);
    await page.mouse.move(5, 5);
    for (const selector of ['[data-view="coronal"] .viewlabel > button', '[data-view="coronal"] .overlay.bl', '[data-view="volume3d"] .viewlabel > button']) {
      const chip = await page.locator(selector).evaluate((el) => {
        const s = getComputedStyle(el);
        const parse = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number);
          return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
        };
        const bg = parse(s.backgroundColor);
        const text = parse(s.color);
        // The worst case behind the chip: the brightest pixel an image can have.
        const over = { r: bg.r * bg.a + 255 * (1 - bg.a), g: bg.g * bg.a + 255 * (1 - bg.a), b: bg.b * bg.a + 255 * (1 - bg.a) };
        const lum = (c: { r: number; g: number; b: number }) => {
          const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        };
        const range = document.createRange();
        range.selectNodeContents(el);
        const box = el.getBoundingClientRect();
        return {
          contrast: (Math.max(lum(text), lum(over)) + 0.05) / (Math.min(lum(text), lum(over)) + 0.05),
          alpha: bg.a,
          // How much wider and taller the chip is than the text it backs.
          extra: [box.width - range.getBoundingClientRect().width, box.height - 16],
          moves: `${s.transitionDuration} ${s.animationName}`,
          radius: s.borderTopLeftRadius,
        };
      });
      expect(chip.contrast, selector).toBeGreaterThanOrEqual(4.5);
      // A backing, not a block: the image still shows through, and it is no bigger than the text needs.
      expect(chip.alpha, selector).toBeLessThan(0.9);
      expect(chip.extra[0], selector).toBeLessThanOrEqual(10);
      expect(chip.extra[1], selector).toBeLessThanOrEqual(4);
      expect(chip.radius, selector).toBe('4px');
      // Nothing over the image fades or slides.
      expect(chip.moves, selector).toMatch(/^0s( none)$/);
    }
  });
}

/* ───────────────────────── options strip at narrow widths ───────────────────────── */

const SHORTENED = ['Rect', 'Free', 'Erase in', 'Erase out', 'Fill', 'Slice', 'All', 'Remove', 'Keep', 'Fill gaps'];

/** The words on show in the strip's controls: button text, and the option each list is on. */
const stripWords = (page: Page) =>
  page.locator('.strip .options').evaluate((el) => {
    const shown = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const buttons = Array.from(el.querySelectorAll('button')).filter(shown).map((b) => (b as HTMLElement).innerText.trim());
    const lists = Array.from(el.querySelectorAll('select')).filter(shown).flatMap((s) => Array.from(s.options).map((o) => o.text.trim()));
    return [...buttons, ...lists];
  });

/** The options of one choice in the strip, by name, whether it is a group of buttons or a list. */
async function optionsOf(page: Page, name: string): Promise<{ kind: 'group' | 'list'; options: string[]; chosen: string }> {
  const group = page.getByRole('group', { name, exact: true });
  if ((await group.count()) > 0) {
    const buttons = group.getByRole('button');
    const options: string[] = [];
    for (const b of await buttons.all()) options.push((await b.getAttribute('aria-label')) ?? (await b.innerText()).trim());
    return { kind: 'group', options, chosen: (await group.locator('[aria-pressed="true"]').innerText()).trim() };
  }
  const list = page.getByRole('combobox', { name, exact: true });
  return {
    kind: 'list',
    options: await list.locator('option').allInnerTexts(),
    chosen: await list.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].text),
  };
}

for (const width of [1280, 1024]) {
  test(`the scissors and fill strips keep whole words at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 640 });
    await openPhantom(page);
    await page.keyboard.press('s');
    await page.waitForTimeout(150);
    for (const word of await stripWords(page)) expect(SHORTENED, `"${word}" in the scissors strip`).not.toContain(word);
    expect((await optionsOf(page, 'Scissors shape')).options).toEqual(['Rectangle', 'Circle', 'Freehand', 'Sphere']);
    expect((await optionsOf(page, 'Scissors action')).options).toEqual(['Erase inside', 'Erase outside', 'Fill inside']);
    expect((await optionsOf(page, 'Scissors depth')).options).toEqual(['This slice', 'All slices']);

    // Each choice still works, by the same names, and shows what is chosen.
    await choose(page, 'Scissors shape', 'Freehand');
    await choose(page, 'Scissors action', 'Erase outside');
    await choose(page, 'Scissors depth', 'All slices');
    expect(await page.evaluate(() => {
      const s = window.__w.store.getState();
      return [s.scissorsShape, s.scissorsAction, s.scissorsDepth];
    })).toEqual(['freehand', 'outside', 'all']);
    expect((await optionsOf(page, 'Scissors shape')).chosen).toBe('Freehand');
    expect((await optionsOf(page, 'Scissors action')).chosen).toBe('Erase outside');
    expect((await optionsOf(page, 'Scissors depth')).chosen).toBe('All slices');
    // A list gives the keyboard back, so the tool keys still work after a choice.
    await page.keyboard.press('f');
    await expect(page.locator('.strip')).toHaveAttribute('data-strip', 'fill');
    await page.waitForTimeout(150);
    for (const word of await stripWords(page)) expect(SHORTENED, `"${word}" in the fill strip`).not.toContain(word);
    expect((await optionsOf(page, 'Fill action')).options).toEqual(['Fill area', 'Remove island', 'Keep island']);
  });

  test(`Fill between slices has one name at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 640 });
    await openPhantom(page);
    await page.keyboard.press('b');
    await page.waitForTimeout(150);
    const fill = page.getByRole('button', { name: 'Fill between slices' });
    await expect(fill).toBeVisible();
    expect((await fill.innerText()).trim()).toBe('Fill between slices');
    await expect(page.locator('.strip', { hasText: 'Fill gaps' })).toHaveCount(0);
    // The paint over choices are all there, as buttons or as one list.
    const over = await optionsOf(page, 'Paint over');
    expect(over.options.slice(0, 2)).toEqual(['Everything', 'Empty only']);
    await choose(page, 'Paint over', 'Empty only');
    expect(await page.evaluate(() => window.__w.store.getState().paintOver)).toBe('empty');
  });
}

test('at 1024 wide the window hint moves to a tooltip and is not lost', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPhantom(page);
  await page.keyboard.press('w');
  const hint = `${process.platform === 'darwin' ? '⌘' : 'Ctrl'}-drag a box to set the window from it.`;
  await expect(page.locator('.strip .hint')).toHaveText(hint);
  await expect(page.locator('.strip .hint')).toBeVisible();
  await expect(page.locator(`.strip [data-tip="${hint}"]`)).toHaveCount(0);

  await page.setViewportSize({ width: 1024, height: 640 });
  await expect(page.locator('.strip .hint')).toBeHidden();
  const tipped = page.locator(`.strip [data-tip="${hint}"]`);
  await expect(tipped).toHaveCount(1);
  // Shown when the field is pointed at, and when the keyboard is in it.
  const tipOpacity = () => tipped.evaluate((el) => getComputedStyle(el, '::after').opacity);
  await tipped.hover();
  await expect.poll(tipOpacity).toBe('1');
  await page.mouse.move(5, 5);
  await expect.poll(tipOpacity).toBe('0');
  await page.getByLabel('Window width').focus();
  await expect.poll(tipOpacity).toBe('1');
});
