import { expect, test, type Page } from '@playwright/test';
import { openPhantom } from './helpers';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
/** Opens the app and waits until it is listening for keys. */
async function launch(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Drop an image and a mask' }).waitFor();
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('heading', { name: 'Drop an image and a mask' }).waitFor();
}

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings') ?? '{}') as Record<string, unknown>);

test('Settings opens with the shortcut, moves by arrow keys, traps focus and closes with Esc', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('Control+,');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('data-section', 'profile');

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: 'Appearance' })).toBeVisible();
  // One section at a time.
  await expect(page.getByLabel('Your name in rooms')).toHaveCount(0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('tab', { name: 'Help' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeFocused();

  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('Settings opens from the empty state and from the file menu, and ? goes to Shortcuts', async ({ page }) => {
  await launch(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);

  await openPhantom(page);
  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await expect(page.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-action="tool.brush"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Help' }).click();
  await dialog(page).getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.locator('[data-action="app.settings"]')).toHaveText('Ctrl+,');
});

test('the Settings shortcut can be changed', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('?');
  await page.locator('[data-action="app.settings"]').click();
  await page.keyboard.press('Control+j');
  await expect(page.locator('[data-action="app.settings"]')).toHaveText('Ctrl+J');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press('Control+j');
  await expect(dialog(page)).toBeVisible();
});

test('the name is saved as it is typed and the room dialog uses it and writes back to it', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('Control+,');
  const name = page.getByLabel('Your name in rooms');
  await expect(name).toHaveAttribute('maxlength', '24');
  await name.fill('Mina Okafor');
  expect((await saved(page)).displayName).toBe('Mina Okafor');

  await reload(page);
  await page.getByRole('button', { name: 'Join a room', exact: true }).click();
  await expect(page.getByPlaceholder('How others will see you')).toHaveValue('Mina Okafor');
  await page.getByPlaceholder('How others will see you').fill('Mina O');
  await page.getByPlaceholder('Paste the invite link').fill('ZZZ-999');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No room with that code');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+,');
  await expect(page.getByLabel('Your name in rooms')).toHaveValue('Mina O');
});

test('a name change in Settings reaches the other person in the room at once', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

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
  await expect(host.locator('.avatar').first()).toHaveText('A');

  await guest.keyboard.press('Control+,');
  await guest.getByLabel('Your name in rooms').fill('Zed Brook');
  await expect(host.locator('.avatar').first()).toHaveText('ZB');
  await expect(host.locator('.avatar').first()).toHaveAttribute('title', 'Zed Brook');
  await guest.keyboard.press('Escape');
  await guest.getByTestId('room-pill').click();
  await expect(guest.locator('.person').first()).toContainText('Zed Brook');
  await guest.keyboard.press('Escape');

  // Someone who joins afterwards sees the new name too.
  const lateCtx = await browser.newContext();
  const late = await lateCtx.newPage();
  await late.goto('/');
  await late.getByRole('button', { name: 'Join a room', exact: true }).click();
  await late.getByPlaceholder('How others will see you').fill('Kim');
  await late.getByPlaceholder('Paste the invite link').fill(link);
  await late.getByRole('button', { name: 'Join', exact: true }).click();
  await late.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 30_000 });
  await expect(late.locator('.avatar[title="Zed Brook"]')).toHaveCount(1);
  await expect(late.locator('.avatar[title="Ario"]')).toHaveCount(0);

  await hostCtx.close();
  await guestCtx.close();
  await lateCtx.close();
});

test('Reduce motion sets the attribute, stops transitions and is remembered', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  const toggle = page.getByRole('switch', { name: 'Reduce motion' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim())).toBe('0ms');

  await reload(page);
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByRole('switch', { name: 'Reduce motion' }).press('Space');
  await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion');
});

test('the appearance control in Settings changes the theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await launch(page);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await dialog(page).getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Autosave is on by default and the switch is remembered', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Files' }).click();
  const autosave = page.getByRole('switch', { name: 'Autosave' });
  await expect(autosave).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Keeps a recovery copy of unsaved mask edits on this device.')).toBeVisible();
  await autosave.click();
  expect((await saved(page)).autosave).toBe(false);

  await page.getByLabel('Room server').fill('wss://rooms.example.org');
  expect((await saved(page)).server).toBe('wss://rooms.example.org');

  await reload(page);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Files' }).click();
  await expect(page.getByRole('switch', { name: 'Autosave' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Room server')).toHaveValue('wss://rooms.example.org');
});

test('Help shows the version and licence, and opens the report dialog', async ({ page }) => {
  await launch(page);
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Help' }).click();
  await expect(page.getByText(/version \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByText('Free for non-commercial use. © Ariorad Moniri.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Report a problem' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
});

test('Settings fits a 1024x640 window in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await launch(page);
    await page.keyboard.press('?');
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    // The last shortcut can be scrolled to inside the pane.
    await page.locator('[data-action="app.settings"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-action="app.settings"]')).toBeInViewport();
  }
});
