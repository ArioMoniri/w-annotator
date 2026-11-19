import { expect, test, type Page } from '@playwright/test';
import { openPhantom } from './helpers';

// --bg-surface in each theme, as the browser reports it.
const DARK_SURFACE = 'rgb(18, 20, 23)';
const LIGHT_SURFACE = 'rgb(247, 248, 249)';

const topBar = (page: Page) => page.locator('header.topbar');
const appearance = (page: Page) => page.getByRole('group', { name: 'Appearance' });
const savedMode = (page: Page) => page.evaluate(() => localStorage.getItem('w-annotator:theme'));

test('system is the default and follows the OS live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(appearance(page).getByRole('button', { name: 'Match system appearance' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(topBar(page)).toHaveCSS('background-color', DARK_SURFACE);

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(topBar(page)).toHaveCSS('background-color', DARK_SURFACE);
});

test('a chosen mode changes the top bar, ignores the OS and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await appearance(page).getByRole('button', { name: 'Light appearance' }).click();
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);
  expect(await savedMode(page)).toBe('light');

  await page.reload();
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);
  await expect(appearance(page).getByRole('button', { name: 'Light appearance' })).toHaveAttribute('aria-pressed', 'true');

  await page.emulateMedia({ colorScheme: 'light' });
  await appearance(page).getByRole('button', { name: 'Dark appearance' }).click();
  await expect(topBar(page)).toHaveCSS('background-color', DARK_SURFACE);
  await page.reload();
  await expect(topBar(page)).toHaveCSS('background-color', DARK_SURFACE);

  await appearance(page).getByRole('button', { name: 'Match system appearance' }).click();
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);
  expect(await savedMode(page)).toBe('system');
});

test('the file menu switches appearance by keyboard', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openPhantom(page);
  await page.locator('.filebtn').click();
  const light = page.getByRole('menu').getByRole('button', { name: 'Light', exact: true });
  await light.focus();
  await page.keyboard.press('Enter');
  await expect(light).toHaveAttribute('aria-pressed', 'true');
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);
  // The menu stays open so the change can be seen and undone.
  await page.getByRole('menu').getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(topBar(page)).toHaveCSS('background-color', DARK_SURFACE);
  expect(await savedMode(page)).toBe('dark');
});

test('the image stays on black in light mode, with its overlays styled for a dark image', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPhantom(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(topBar(page)).toHaveCSS('background-color', LIGHT_SURFACE);
  for (const view of ['axial', 'sagittal', 'coronal', 'volume3d']) {
    await expect(page.locator(`[data-view="${view}"]`)).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  }
  // Orientation letters and corner text keep the light-on-dark colours.
  await expect(page.locator('[data-view="axial"] .orient.t')).toHaveCSS('color', 'rgb(231, 233, 236)');
  await expect(page.locator('[data-view="axial"] .overlay.tl')).toHaveCSS('color', 'rgb(166, 173, 183)');
});

test('the saved theme is on the page before the app starts', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('w-annotator:theme', 'light'));
  // Hold the app back: only the inline script in index.html has run.
  await page.route('**/src/main.tsx*', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#root')).toBeEmpty();
});
