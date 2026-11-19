import { expect, test, type Page } from '@playwright/test';
import { openPhantom } from './helpers';

// These tests are about the first launch, so they start with nothing saved.
test.use({ storageState: { cookies: [], origins: [] } });

const card = (page: Page) => page.getByTestId('tour-card');
const hole = (page: Page) => page.getByTestId('tour-hole');
const tourSeen = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('w-annotator:settings') ?? '{}') as { tourSeen?: boolean }).tourSeen === true);

const FULL = ['views', 'tools', 'brush', 'options', 'interpolate', 'segments', 'undo', 'save', 'share', 'shortcuts'];
const SHORT = ['drop', 'join', 'settings'];

/** The card is fully inside the window. */
async function expectCardOnScreen(page: Page): Promise<void> {
  const size = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = (await card(page).boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
    })
    .toBe(true);
}

/** The cut-out covers every element the step points at, and the card does not hide them completely. */
async function expectHoleOnTargets(page: Page): Promise<void> {
  const names = ((await card(page).getAttribute('data-targets')) ?? '').split(' ').filter(Boolean);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const target = page.locator(`[data-tour~="${name}"]`).first();
    await expect(target).toBeVisible();
    await expect
      .poll(async () => {
        const t = (await target.boundingBox())!;
        const h = await hole(page).boundingBox();
        if (!h) return 'no hole';
        const covered = h.x <= t.x + 1 && h.y <= t.y + 1 && h.x + h.width >= t.x + t.width - 1 && h.y + h.height >= t.y + t.height - 1;
        return covered ? 'covered' : `hole ${JSON.stringify(h)} target ${JSON.stringify(t)}`;
      })
      .toBe('covered');
  }
}

async function walk(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    await expect(card(page)).toHaveAttribute('data-step', id);
    await expectHoleOnTargets(page);
    await expectCardOnScreen(page);
    await page.getByRole('button', { name: 'Next' }).click();
  }
}

test('first launch offers the tour, the sample walk reaches the end, and it does not come back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Welcome tour' })).toBeVisible();
  expect(await tourSeen(page)).toBe(false);

  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  await expect(page.locator('.segrow')).toHaveCount(2);
  await walk(page, FULL);

  await expect(card(page)).toContainText("You're set.");
  expect(await tourSeen(page)).toBe(true);
  await page.getByRole('button', { name: 'Keep the sample open' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page.locator('[data-view="axial"] canvas').first()).toBeVisible();
  // The brush was only picked to show its options.
  await expect(page.locator('[data-tool="crosshair"]')).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('at 1024x640 every card is on screen and every cut-out is on its control', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto('/');
  await expectCardOnScreen(page);
  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  await walk(page, FULL);
  await expectCardOnScreen(page);
  await page.getByRole('button', { name: 'Close the sample' }).click();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();

  // And the short version, on the empty state.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Look around without it' }).click();
  await walk(page, SHORT);
  await expectCardOnScreen(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  expect(await tourSeen(page)).toBe(true);
});

test('the cut-out follows its control when the window is resized', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next' }).click();
  await expect(card(page)).toHaveAttribute('data-step', 'segments');
  await expectHoleOnTargets(page);
  await page.setViewportSize({ width: 1024, height: 640 });
  await expectHoleOnTargets(page);
  await expectCardOnScreen(page);
});

test('Esc skips the tour for good', async ({ page }) => {
  await page.goto('/');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  expect(await tourSeen(page)).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('arrow keys and Enter move between steps, and the app behind does not react', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  await expect(card(page)).toHaveAttribute('data-step', 'views');
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toHaveAttribute('data-step', 'tools');
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveAttribute('data-step', 'brush');
  await page.keyboard.press('ArrowLeft');
  await expect(card(page)).toHaveAttribute('data-step', 'tools');
  // "e" is the eraser shortcut; it must not reach the app.
  await page.keyboard.press('e');
  await expect(page.locator('[data-tool="eraser"]')).toHaveAttribute('aria-checked', 'false');
  // Tab stays inside the card.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tour-card"]'))).toBe(true);
  }
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  expect(await tourSeen(page)).toBe(true);
});

test('the tour can be replayed from Settings, on an image that is already open', async ({ page }) => {
  await openPhantom(page);
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Help' }).click();
  await page.getByRole('button', { name: 'Replay the welcome tour' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await walk(page, FULL);
  // It is their own image, so there is no sample to close.
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-view="axial"] canvas').first()).toBeVisible();
});

test('?tour=0 keeps the tour away on a first launch', async ({ page }) => {
  await page.goto('/?tour=0');
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  expect(await tourSeen(page)).toBe(false);
});

test('with reduced motion the hints stand still and the cut-out does not travel', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  await expect(card(page)).toHaveAttribute('data-step', 'views');
  await expect(page.locator('.tour-hint .hint-wheel')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.tour-dim i').first()).toHaveCSS('transition-duration', '0s');
  await expect(card(page)).toHaveCSS('transition-duration', '0s');
});
