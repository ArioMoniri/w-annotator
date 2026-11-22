import { expect, test, type Page } from '@playwright/test';
import { openPhantom, tintedPixels } from './helpers';

/**
 * Trackpad input cannot be produced by a test, so these dispatch the wheel and
 * gesture events a trackpad makes: many small fractional deltas in a stream.
 * Mouse wheel notches go through the browser's real input path.
 */

interface Sent {
  /** Slice index of the view after each event. */
  indices: number[];
  /** Whether every event had its default action prevented. */
  prevented: boolean;
}

type Init = { deltaX?: number; deltaY?: number; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean };

/** Dispatches wheel events on a view's canvas, a few ms apart, at an offset from the view's centre. */
async function wheel(page: Page, view: string, events: Init[], at: [number, number] = [0, 0]): Promise<Sent> {
  const sent = await page.evaluate(
    async ({ view, events, at }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (window as any).__w;
      const cell = document.querySelector(`[data-view="${view}"]`)!;
      const target = cell.querySelector('canvas')!;
      const rect = cell.getBoundingClientRect();
      const indices: number[] = [];
      let prevented = true;
      for (const init of events) {
        const e = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: 0,
          // Whole pixels: a wheel event's position is an integer.
          clientX: Math.round(rect.left + rect.width / 2) + at[0],
          clientY: Math.round(rect.top + rect.height / 2) + at[1],
          ...init,
        });
        if (target.dispatchEvent(e)) prevented = false;
        indices.push(view === 'volume3d' ? 0 : w.engine.getSlice(view).index);
        await new Promise((r) => setTimeout(r, 4));
      }
      return { indices, prevented };
    },
    { view, events, at },
  );
  // Longer than the pause that ends a trackpad scroll, so the next call starts a new one.
  await page.waitForTimeout(320);
  return sent;
}

/** A two-finger scroll: `count` events of `dy` pixels with a little sideways jitter. */
const scroll = (count: number, dy: number, more: Init = {}): Init[] =>
  Array.from({ length: count }, (_, i) => ({ deltaY: dy, deltaX: i % 3 === 0 ? 0.5 : 0, ...more }));

const slice = (page: Page, view = 'axial') =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate((view) => (window as any).__w.engine.getSlice(view).index as number, view);
const zoom = (page: Page, view = 'axial') =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate((view) => (window as any).__w.engine.getZoom(view) as number, view);

/** The image point drawn at an offset from the centre of a view. */
const worldAt = (page: Page, view: string, at: [number, number]) =>
  page.evaluate(
    ({ view, at }) => {
      const rect = document.querySelector(`[data-view="${view}"]`)!.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2) - rect.left + at[0];
      const y = Math.round(rect.top + rect.height / 2) - rect.top + at[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__w.engine.canvasToWorld(view, x, y) as number[];
    },
    { view, at },
  );

/** Whether the page itself has been scrolled or zoomed. */
const pageMoved = (page: Page) =>
  page.evaluate(() => window.scrollX !== 0 || window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || (window.visualViewport?.scale ?? 1) !== 1);

async function hover(page: Page, view: string, at: [number, number] = [0, 0]): Promise<void> {
  const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + at[0], box.y + box.height / 2 + at[1]);
}

async function mouseSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Mouse and trackpad' }).click();
}

const closeSettings = (page: Page) => page.keyboard.press('Escape');

/**
 * One notch of a mouse wheel. Elsewhere it goes through the browser's real
 * input path. On a Mac, Playwright's wheel arrives as a smooth pixel scroll,
 * which is what a trackpad sends, so the event a notched mouse makes there is
 * dispatched instead: a small fractional delta, with Cmd as the zoom key.
 */
const macWebKit = (page: Page) => process.platform === 'darwin' && page.context().browser()?.browserType().name() === 'webkit';
async function notch(page: Page, direction: 1 | -1, held?: 'Shift' | 'Zoom'): Promise<void> {
  if (macWebKit(page)) {
    await wheel(page, 'axial', [{ deltaY: direction * 12.0007, shiftKey: held === 'Shift', metaKey: held === 'Zoom' }]);
    return;
  }
  const key = held === 'Zoom' ? 'Control' : held;
  if (key) await page.keyboard.down(key);
  await page.mouse.wheel(0, direction * 100);
  await page.waitForTimeout(80);
  if (key) await page.keyboard.up(key);
}

test('a trackpad scroll moves through the slices smoothly and in proportion to its distance', async ({ page }) => {
  await openPhantom(page);
  const start = await slice(page);

  // 145 px at the default 29 px per slice.
  const first = await wheel(page, 'axial', scroll(58, 2.5));
  expect(first.prevented).toBe(true);
  expect(first.indices.at(-1)).toBe(start + 5);
  const steps = first.indices.map((v, i) => v - (i ? first.indices[i - 1] : start));
  expect(Math.min(...steps)).toBe(0);
  expect(Math.max(...steps)).toBe(1);

  // Twice the distance the other way goes twice as far.
  const back = await wheel(page, 'axial', scroll(116, -2.5));
  expect(back.indices.at(-1)).toBe(start + 5 - 10);
  await expect(page.locator('[data-view="axial"] .overlay.bl')).toHaveText(`Slice ${start - 5 + 1} / 48`);
  expect(await pageMoved(page)).toBe(false);
});

test('deltas smaller than one pixel still add up to slices', async ({ page }) => {
  await openPhantom(page);
  const start = await slice(page);
  const sent = await wheel(page, 'axial', scroll(150, 0.4));
  expect(sent.prevented).toBe(true);
  expect(sent.indices.at(-1)).toBe(start + 2);
});

test('a mouse wheel moves one slice per notch, five with Shift, and zooms with Ctrl', async ({ page }) => {
  await openPhantom(page);
  await hover(page, 'axial');
  const start = await slice(page);
  for (let i = 0; i < 3; i++) {
    await notch(page, 1);
  }
  expect(await slice(page)).toBe(start + 3);
  await notch(page, -1);
  expect(await slice(page)).toBe(start + 2);

  await notch(page, 1, 'Shift');
  expect(await slice(page)).toBe(start + 7);

  const before = await zoom(page);
  await notch(page, -1, 'Zoom');
  expect((await zoom(page)) / before).toBeCloseTo(Math.exp(0.1), 2);
  expect(await slice(page)).toBe(start + 7);
  expect(await pageMoved(page)).toBe(false);
});

test('a pinch zooms continuously and keeps the point under the pointer where it is', async ({ page }) => {
  await openPhantom(page);
  const at: [number, number] = [70, -45];
  const start = await slice(page);
  const z0 = await zoom(page);
  const p0 = await worldAt(page, 'axial', at);
  const far0 = await worldAt(page, 'axial', [-100, 80]);

  // Fingers apart: ctrlKey wheel events with small negative deltas, 40 px in all.
  const out = await wheel(page, 'axial', Array.from({ length: 50 }, () => ({ deltaY: -0.8, ctrlKey: true })), at);
  expect(out.prevented).toBe(true);
  const z1 = await zoom(page);
  expect(z1 / z0).toBeCloseTo(Math.exp(0.4), 2);
  const p1 = await worldAt(page, 'axial', at);
  for (let i = 0; i < 3; i++) expect(p1[i]).toBeCloseTo(p0[i], 3);
  // Zooming did happen about that point: a point elsewhere in the view is a different one now.
  const far1 = await worldAt(page, 'axial', [-100, 80]);
  expect(Math.hypot(far1[0] - far0[0], far1[1] - far0[1], far1[2] - far0[2])).toBeGreaterThan(5);

  // Fingers together by the same amount brings the view back.
  await wheel(page, 'axial', Array.from({ length: 50 }, () => ({ deltaY: 0.8, ctrlKey: true })), at);
  expect((await zoom(page)) / z0).toBeCloseTo(1, 3);
  const far2 = await worldAt(page, 'axial', [-100, 80]);
  for (let i = 0; i < 3; i++) expect(far2[i]).toBeCloseTo(far0[i], 3);

  expect(await slice(page)).toBe(start);
  expect(await pageMoved(page)).toBe(false);
});

test('a Safari pinch gesture zooms about the pointer and its default is prevented', async ({ page }) => {
  await openPhantom(page);
  const at: [number, number] = [-60, 50];
  const z0 = await zoom(page);
  const p0 = await worldAt(page, 'axial', at);
  const prevented = await page.evaluate((at) => {
    const cell = document.querySelector('[data-view="axial"]')!;
    const rect = cell.getBoundingClientRect();
    const send = (type: string, scale: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { scale, rotation: 0, clientX: Math.round(rect.left + rect.width / 2) + at[0], clientY: Math.round(rect.top + rect.height / 2) + at[1] });
      return !cell.querySelector('canvas')!.dispatchEvent(e);
    };
    const all = [send('gesturestart', 1)];
    for (const scale of [1.05, 1.12, 1.2, 1.31, 1.42, 1.5]) all.push(send('gesturechange', scale));
    all.push(send('gestureend', 1.5));
    return all.every(Boolean);
  }, at);
  expect(prevented).toBe(true);
  expect((await zoom(page)) / z0).toBeCloseTo(1.5, 3);
  const p1 = await worldAt(page, 'axial', at);
  for (let i = 0; i < 3; i++) expect(p1[i]).toBeCloseTo(p0[i], 3);

  // A gesture anywhere else in the window is stopped too, so the window never zooms.
  const elsewhere = await page.evaluate(() => {
    const e = new Event('gesturestart', { bubbles: true, cancelable: true });
    Object.assign(e, { scale: 1 });
    return !document.body.dispatchEvent(e);
  });
  expect(elsewhere).toBe(true);
  expect(await pageMoved(page)).toBe(false);
});

test('a sideways swipe does nothing and a drifting scroll does not pan', async ({ page }) => {
  await openPhantom(page);
  const start = await slice(page);
  const p0 = await worldAt(page, 'axial', [0, 0]);
  const swipe = await wheel(
    page,
    'axial',
    Array.from({ length: 40 }, (_, i) => ({ deltaX: 6, deltaY: i % 4 === 0 ? 0.5 : 0 })),
  );
  expect(swipe.prevented).toBe(true);
  expect(await slice(page)).toBe(start);

  await wheel(page, 'axial', Array.from({ length: 40 }, () => ({ deltaX: 1, deltaY: 3 })));
  expect(await slice(page)).toBe(start + 4);
  const p1 = await worldAt(page, 'axial', [0, 0]);
  // Only the slice changed: the two in-plane coordinates of the centre are the same.
  expect(p1[0]).toBeCloseTo(p0[0], 3);
  expect(p1[1]).toBeCloseTo(p0[1], 3);
  expect(await pageMoved(page)).toBe(false);
});

test('Shift scrolls five times as fast and Alt changes the brush size', async ({ page }) => {
  await openPhantom(page);
  const start = await slice(page);
  // 58 px: two slices plain, ten with Shift.
  await wheel(page, 'axial', scroll(29, 2, { shiftKey: true }));
  expect(await slice(page)).toBe(start + 10);

  await page.keyboard.press('b');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size = () => page.evaluate(() => (window as any).__w.store.getState().brushSize as number);
  const before = await size();
  // 48 px up is three steps of 16 px: 8 mm to 9, 10, then 12.
  const sent = await wheel(page, 'axial', scroll(24, -2, { altKey: true }));
  expect(sent.prevented).toBe(true);
  expect(before).toBe(8);
  expect(await size()).toBe(12);
  await expect(page.getByLabel('Brush size in millimetres')).toHaveValue('12');
  expect(await slice(page)).toBe(start + 10);

  // With no brush tool, Alt+scroll is an ordinary scroll.
  await page.keyboard.press('c');
  await wheel(page, 'axial', scroll(29, -2, { altKey: true }));
  expect(await size()).toBe(12);
  expect(await slice(page)).toBe(start + 8);
});

test('scroll and pinch zoom the 3D view', async ({ page }) => {
  await openPhantom(page);
  // The 3D view draws some time after the slices; wait for it, then let it settle.
  await expect.poll(() => tintedPixels(page, 'volume3d'), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const before = await tintedPixels(page, 'volume3d');
  expect(before).toBeGreaterThan(0);
  const axial = await slice(page);

  const sent = await wheel(page, 'volume3d', scroll(40, -3));
  expect(sent.prevented).toBe(true);
  await page.waitForTimeout(500);
  const scrolled = await tintedPixels(page, 'volume3d');
  expect(scrolled).toBeGreaterThan(before * 1.2);

  await wheel(page, 'volume3d', Array.from({ length: 30 }, () => ({ deltaY: -1, ctrlKey: true })));
  await page.waitForTimeout(500);
  expect(await tintedPixels(page, 'volume3d')).toBeGreaterThan(scrolled * 1.2);
  expect(await slice(page)).toBe(axial);
  expect(await pageMoved(page)).toBe(false);
});

test('the Mouse and trackpad settings change what the gestures do, and are kept', async ({ page }) => {
  await openPhantom(page);
  const start = await slice(page);

  await mouseSettings(page);
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Mouse and trackpad' })).toBeVisible();
  await page.getByRole('group', { name: 'Scroll direction' }).getByRole('button', { name: 'Reversed' }).click();
  await closeSettings(page);
  await wheel(page, 'axial', scroll(58, 2.5));
  expect(await slice(page)).toBe(start - 5);

  // A faster trackpad speed: 8 px per slice at the top of the range.
  await mouseSettings(page);
  await page.getByRole('group', { name: 'Scroll direction' }).getByRole('button', { name: 'Natural' }).click();
  await page.getByRole('slider', { name: 'Trackpad scroll speed' }).fill('10');
  await closeSettings(page);
  await wheel(page, 'axial', scroll(16, 2.5));
  expect(await slice(page)).toBe(start - 5 + 5);

  // Two-finger scroll pans; Shift changes slice.
  await mouseSettings(page);
  await page.getByRole('slider', { name: 'Trackpad scroll speed' }).fill('5');
  await page.getByRole('group', { name: 'Two-finger scroll' }).getByRole('button', { name: 'Pan' }).click();
  await closeSettings(page);
  const c0 = await worldAt(page, 'axial', [0, 0]);
  const moved = await worldAt(page, 'axial', [30, 60]);
  await wheel(page, 'axial', Array.from({ length: 30 }, () => ({ deltaX: 1, deltaY: 2 })));
  expect(await slice(page)).toBe(start);
  // The image followed the fingers: what was at the centre is now 30 px left and 60 px up.
  const c1 = await worldAt(page, 'axial', [0, 0]);
  for (let i = 0; i < 3; i++) expect(c1[i]).toBeCloseTo(moved[i], 3);
  expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeGreaterThan(1);
  await wheel(page, 'axial', scroll(29, 2, { shiftKey: true }));
  expect(await slice(page)).toBe(start + 2);

  // Pinch off: the gesture is still swallowed, but nothing zooms.
  await mouseSettings(page);
  await page.getByRole('group', { name: 'Two-finger scroll' }).getByRole('button', { name: 'Change slice' }).click();
  await page.getByRole('switch', { name: 'Pinch to zoom' }).click();
  await closeSettings(page);
  const z0 = await zoom(page);
  const pinch = await wheel(page, 'axial', Array.from({ length: 30 }, () => ({ deltaY: -1, ctrlKey: true })));
  expect(pinch.prevented).toBe(true);
  expect(await zoom(page)).toBe(z0);
  expect(await pageMoved(page)).toBe(false);

  // The mouse wheel zooms, and a higher zoom speed zooms further per notch.
  await mouseSettings(page);
  await page.getByRole('switch', { name: 'Mouse wheel zooms' }).click();
  await closeSettings(page);
  await hover(page, 'axial');
  await notch(page, -1);
  const z1 = await zoom(page);
  expect(z1 / z0).toBeCloseTo(Math.exp(0.1), 2);
  expect(await slice(page)).toBe(start + 2);
  await mouseSettings(page);
  await page.getByRole('slider', { name: 'Zoom speed' }).fill('10');
  await closeSettings(page);
  await hover(page, 'axial');
  await notch(page, -1);
  expect((await zoom(page)) / z1).toBeCloseTo(Math.exp(0.4), 2);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings')!) as Record<string, unknown>);
  expect(saved).toMatchObject({ scrollDirection: 'natural', trackpadSpeed: 5, twoFingerScroll: 'slice', pinchZoom: false, wheelZooms: true, zoomSpeed: 10 });
  await page.reload();
  await page.waitForFunction(() => '__w' in window);
  await mouseSettings(page);
  await expect(page.getByRole('switch', { name: 'Mouse wheel zooms' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Pinch to zoom' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('slider', { name: 'Zoom speed' })).toHaveValue('10');
});

test('the shortcuts list describes the mouse and trackpad gestures', async ({ page }) => {
  await openPhantom(page);
  await page.keyboard.press('?');
  const list = page.locator('.shortcuts');
  await expect(list.getByRole('heading', { name: 'Mouse and trackpad' })).toBeVisible();
  await expect(list).toContainText('Change slice, five at a time');
  await expect(list).toContainText(`${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Scroll or pinch`);
  await expect(list).toContainText('Brush size, with a brush tool');
});

test('Ctrl and the wheel never zoom the window, on the image or beside it', async ({ page }) => {
  await openPhantom(page);
  const outcome = await page.evaluate(() => {
    const send = (el: Element) => !el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -3, ctrlKey: true }));
    return [send(document.querySelector('[data-view="axial"] canvas')!), send(document.querySelector('.topbar, header, body')!), send(document.body)];
  });
  expect(outcome).toEqual([true, true, true]);
  expect(await pageMoved(page)).toBe(false);
});
