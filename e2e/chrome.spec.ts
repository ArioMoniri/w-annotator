import { expect, test, type Locator, type Page } from '@playwright/test';
import { openPhantom } from './helpers';

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

const setState = (page: Page, patch: object) =>
  page.evaluate((patch) => (window as never as { __w: { store: { setState(s: object): void } } }).__w.store.setState(patch), patch);

/** Every control and line of text in the dialog that the close button sits on top of. */
async function underCloseButton(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((root) => {
    const close = root.querySelector('button.close');
    if (!close) return ['no close button'];
    const c = close.getBoundingClientRect();
    const hits: string[] = [];
    for (const el of root.querySelectorAll('button, input, select, summary, [role="tab"], h2, h3, p, label, th, td, kbd')) {
      if (el === close || el.contains(close)) continue;
      // The text itself, not the box it could fill.
      const range = document.createRange();
      range.selectNodeContents(el);
      const boxes = el.matches('button, input, select, [role="tab"]') ? [el.getBoundingClientRect()] : Array.from(range.getClientRects());
      for (const r of boxes) {
        if (r.width > 0 && r.left < c.right - 0.5 && c.left < r.right - 0.5 && r.top < c.bottom - 0.5 && c.top < r.bottom - 0.5) {
          hits.push(`${el.tagName} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
          break;
        }
      }
    }
    return hits;
  });
}

for (const theme of ['Light', 'Dark']) {
  test(`room dialog: the close button sits beside the tabs, not on them (${theme.toLowerCase()})`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await page.goto('/');
    await page.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: `${theme} appearance` }).click();
    await page.getByRole('button', { name: 'Join a room', exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const tab of ['Join a room', 'Start a room']) {
      await dialog.getByRole('tab', { name: tab }).click();
      expect(await underCloseButton(dialog)).toEqual([]);
      const close = (await dialog.getByRole('button', { name: 'Close' }).boundingBox())!;
      const tabs = (await dialog.getByRole('tablist').boundingBox())!;
      expect(close.x - (tabs.x + tabs.width)).toBeGreaterThanOrEqual(8);
      // On one line with the tabs.
      expect(Math.abs(close.y + close.height / 2 - (tabs.y + tabs.height / 2))).toBeLessThanOrEqual(2);
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });
}

test('no dialog has its close button over a heading, a tab or another control', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openPhantom(page);
  const dialog = page.getByRole('dialog');
  const opens: [string, object, object][] = [
    ['settings profile', { settings: 'profile' }, { settings: null }],
    ['settings appearance', { settings: 'appearance' }, { settings: null }],
    ['settings shortcuts', { settings: 'shortcuts' }, { settings: null }],
    ['settings files', { settings: 'files' }, { settings: null }],
    ['settings help', { settings: 'help' }, { settings: null }],
    ['report a bug', { report: 'bug' }, { report: null }],
    ['share an idea', { report: 'idea' }, { report: null }],
    ['measurements', { measurementsOpen: true }, { measurementsOpen: false }],
    ['room', { roomModal: 'start' }, { roomModal: null }],
  ];
  for (const [name, open, shut] of opens) {
    await setState(page, open);
    await expect(dialog, name).toBeVisible();
    expect(await underCloseButton(dialog), name).toEqual([]);
    await setState(page, shut);
    await expect(dialog, name).toBeHidden();
  }
});

test('tooltips of the buttons over a view open below them, clear of the neighbouring button', async ({ page }) => {
  await openPhantom(page);
  const cell = page.locator('[data-view="volume3d"]');
  await cell.hover();
  const image = cell.getByRole('button', { name: 'Show image in 3D' });
  const maximise = cell.getByRole('button', { name: 'Maximise' });
  const tipBox = (button: Locator) =>
    button.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el, '::after');
      const width = parseFloat(s.width);
      const height = parseFloat(s.height);
      const right = b.right - parseFloat(s.right);
      const top = b.top + parseFloat(s.top);
      return {
        box: { x: right - width, y: top, width, height },
        stroke: s.getPropertyValue('-webkit-text-stroke-width'),
        shadow: s.textShadow,
        transform: s.transform,
        opacity: s.opacity,
      };
    });
  for (const [button, other] of [
    [maximise, image],
    [image, maximise],
  ]) {
    await button.hover();
    // Nothing during the delay, then fully there: no half-faded text over the icons.
    expect((await tipBox(button)).opacity).toBe('0');
    await page.waitForTimeout(700);
    const tip = await tipBox(button);
    expect(tip.opacity).toBe('1');
    expect(overlap(tip.box, (await other.boundingBox())!)).toBe(false);
    expect(overlap(tip.box, (await button.boundingBox())!)).toBe(false);
    // Inside the view, so it is not cut off.
    const view = (await cell.boundingBox())!;
    expect(tip.box.x).toBeGreaterThanOrEqual(view.x);
    expect(tip.box.x + tip.box.width).toBeLessThanOrEqual(view.x + view.width);
    // Plain text: no outline or shadow taken over from the labels on the image, and nothing that moves.
    expect(tip.stroke).toBe('0px');
    expect(tip.shadow).toBe('none');
    expect(tip.transform).toBe('none');
  }
  // Moving to the next button hides the first tip at once.
  await maximise.hover();
  await page.waitForTimeout(700);
  await image.hover();
  expect((await tipBox(maximise)).opacity).toBe('0');
});

test('no tooltip in the app moves while it fades in', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const moving = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('[data-tip]')) {
      const s = getComputedStyle(el, '::after');
      if (/transform|all/.test(s.transitionProperty) && s.transitionDuration !== '0s') out.push(el.getAttribute('data-tip') ?? '');
    }
    return out;
  });
  expect(moving).toEqual([]);
});

test('popovers in the segments panel are as wide as the rows', async ({ page }) => {
  await openPhantom(page);
  const row = page.locator('.segrow').first();
  const rowBox = (await row.boundingBox())!;
  const sameWidth = async (popover: Locator, name: string) => {
    await expect(popover, name).toBeVisible();
    const box = (await popover.boundingBox())!;
    expect(Math.abs(box.x - rowBox.x), name).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - rowBox.width), name).toBeLessThanOrEqual(1);
  };
  await row.hover();
  await row.getByRole('button', { name: /^More for/ }).click();
  await sameWidth(page.getByRole('menu'), 'row menu');
  await page.getByRole('menuitem', { name: 'Grow…' }).click();
  await sameWidth(page.locator('.menu.ask'), 'grow form');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: /^More for/ }).click();
  await page.getByRole('menuitem', { name: 'Combine…' }).click();
  await sameWidth(page.locator('.menu.ask'), 'combine form');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: /^Colour of/ }).click();
  await sameWidth(page.locator('.menu.palette'), 'colour palette');
  // All twelve colours are inside it.
  const palette = (await page.locator('.menu.palette').boundingBox())!;
  for (const swatch of await page.locator('.menu.palette button').all()) {
    const b = (await swatch.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(palette.x);
    expect(b.x + b.width).toBeLessThanOrEqual(palette.x + palette.width);
  }
});

for (const size of [
  { width: 960, height: 600 },
  { width: 1024, height: 576 },
  { width: 960, height: 420 },
]) {
  test(`every item of the segment menu can be reached at ${size.width} × ${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openPhantom(page);
    const status = (await page.locator('.status').boundingBox())!;
    const panel = (await page.locator('.panel').boundingBox())!;
    for (const row of await page.locator('.segrow').all()) {
      await row.hover();
      await row.getByRole('button', { name: /^More for/ }).click();
      const menu = page.getByRole('menu');
      const box = (await menu.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(panel.y);
      expect(box.y + box.height).toBeLessThanOrEqual(status.y);
      const last = menu.getByRole('menuitem', { name: 'Delete' });
      await last.scrollIntoViewIfNeeded();
      const item = (await last.boundingBox())!;
      expect(item.y).toBeGreaterThanOrEqual(box.y);
      expect(item.y + item.height).toBeLessThanOrEqual(box.y + box.height);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });
}

test('a narrow status bar drops whole items and keeps the save state in full', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('b');
  const { drag } = await import('./helpers');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  const sync = page.locator('.status .syncgroup');
  const bar = page.locator('.status');
  // The bar drops items over a frame or two after a resize, so everything is measured in
  // one reading of the page, and the reading is repeated until the bar has settled.
  const fits = () =>
    expect(async () => {
      const m = await bar.evaluate((el) => {
        const right = (e: Element) => e.getBoundingClientRect().right;
        const shown = [...el.querySelectorAll('[data-drop-order]')].filter((e) => (e as HTMLElement).offsetParent !== null);
        const group = el.querySelector('.syncgroup')!;
        return { bar: right(el), sync: right(group), syncLeft: group.getBoundingClientRect().left, scrolls: el.scrollWidth > el.clientWidth, items: shown.map(right) };
      });
      expect(m.sync).toBeLessThanOrEqual(m.bar);
      expect(m.scrolls).toBe(false);
      // Whatever is shown is shown whole.
      for (const edge of m.items) expect(edge).toBeLessThanOrEqual(m.syncLeft + 1);
    }).toPass({ timeout: 3_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId('status-size')).toBeVisible();
  await fits();

  // Narrower and narrower: size goes first, then zoom, and the save state never loses a letter.
  let sizeGoneAt = 0;
  let zoomGoneAt = 0;
  for (let width = 1280; width >= 960; width -= 40) {
    await page.setViewportSize({ width, height: 600 });
    await page.waitForTimeout(80);
    await fits();
    await expect(sync).toContainText('Unsaved changes');
    if (!sizeGoneAt && !(await page.getByTestId('status-size').isVisible())) sizeGoneAt = width;
    if (!zoomGoneAt && !(await page.getByTestId('status-zoom').isVisible())) zoomGoneAt = width;
    if (zoomGoneAt) expect(sizeGoneAt).toBeGreaterThanOrEqual(zoomGoneAt);
  }

  // A long save state on the smallest window still fits.
  await setState(page, { panelOpen: true });
  await page.evaluate(() => {
    const w = window as never as { __w: { recovery: { useRecovery: { setState(s: object): void } } } };
    w.__w.recovery.useRecovery.setState({ savedAt: Date.now() });
  });
  await expect(page.getByTestId('recovery-note')).toBeVisible();
  await page.waitForTimeout(80);
  await fits();
  expect(await page.getByTestId('status-size').isVisible()).toBe(false);

  // Room again: everything comes back.
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.getByTestId('status-size')).toBeVisible();
  await expect(page.getByTestId('status-zoom')).toBeVisible();
});

test('the room popover lines up with the segments panel', async ({ page }) => {
  await openPhantom(page);
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByPlaceholder('How others will see you').fill('Mina');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByTestId('room-link').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('room-pill').click();
  const menu = (await page.getByRole('menu').boundingBox())!;
  const row = (await page.locator('.segrow').first().boundingBox())!;
  // It covers the rows from edge to edge, so no piece of a row shows beside it.
  expect(menu.x).toBeLessThanOrEqual(row.x + 1);
  expect(menu.x + menu.width).toBeGreaterThanOrEqual(row.x + row.width - 1);
  const strip = (await page.locator('.strip').boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(strip.x + strip.width - 1);
  await page.getByRole('menuitem', { name: 'Leave room' }).or(page.getByRole('button', { name: 'Leave room' })).click();
});
