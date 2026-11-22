import { expect, test, type Page } from '@playwright/test';
import { drag, openPhantom } from './helpers';

const voxels = (page: Page): Promise<number[]> => page.evaluate(() => Array.from(window.__w.session.getMask().data as Uint8Array));

const copies = (page: Page): Promise<{ key: string; savedAt: number }[]> =>
  page.evaluate(async () => {
    await window.__w.recovery.settled();
    return window.__w.recovery.copies();
  });

/** Paint a stroke and wait until its recovery copy has been written. */
async function paintAndWaitForCopy(page: Page): Promise<void> {
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  await expect(page.getByTestId('sync')).toHaveText('Unsaved changes');
  await expect(page.getByTestId('recovery-note')).toHaveText(/^ · recovery copy \d\d:\d\d$/, { timeout: 10_000 });
}

/** Reload without saving, the way a crash or a closed tab ends a session. */
async function crash(page: Page): Promise<void> {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.waitForFunction(() => '__w' in window);
}

test('unsaved edits come back after a reload, with the exact voxels and segment names', async ({ page }) => {
  await openPhantom(page);
  const original = await voxels(page);
  await page.locator('.segrow .name').first().dblclick();
  await page.getByLabel('Segment name').fill('Liver');
  await page.keyboard.press('Enter');
  await paintAndWaitForCopy(page);
  const edited = await voxels(page);
  expect(edited).not.toEqual(original);
  // The status bar names the copy and never says the mask file was saved.
  await expect(page.getByTestId('sync')).not.toHaveText(/Saved/);

  await crash(page);
  await expect(page.getByTestId('recovery-waiting')).toHaveText('Recovered work is available for 1 image. Open the image to restore it.');

  await openPhantom(page);
  const bar = page.getByTestId('recovery-bar');
  await expect(bar).toContainText(/Unsaved edits from \d\d:\d\d on \d{1,2} [A-Z][a-z]+ were found for this image\./);
  // Nothing changes until the user chooses.
  expect(await voxels(page)).toEqual(original);
  await expect(page.locator('.segrow').first()).toContainText('Segment 1');

  await bar.getByRole('button', { name: 'Restore' }).click();
  await expect(bar).toHaveCount(0);
  expect(await voxels(page)).toEqual(edited);
  await expect(page.locator('.segrow').first()).toContainText('Liver');
  await expect(page.getByTestId('sync')).toHaveText('Unsaved changes');

  // Restoring is one undo step.
  await page.keyboard.press('Control+z');
  await expect.poll(() => voxels(page)).toEqual(original);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => voxels(page)).toEqual(edited);
});

test('the same image opened without its mask is offered the copy too', async ({ page }) => {
  await openPhantom(page);
  await paintAndWaitForCopy(page);
  const edited = await voxels(page);
  await crash(page);
  await openPhantom(page, false);
  await page.getByTestId('recovery-bar').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByTestId('recovery-bar')).toHaveCount(0);
  expect(await voxels(page)).toEqual(edited);
  await expect(page.locator('.segrow')).toHaveCount(2);
});

test('discard removes the recovery copy', async ({ page }) => {
  await openPhantom(page);
  const original = await voxels(page);
  await paintAndWaitForCopy(page);
  await crash(page);
  await openPhantom(page);
  const bar = page.getByTestId('recovery-bar');
  await bar.getByRole('button', { name: 'Discard' }).click();
  await expect(bar).toHaveCount(0);
  expect(await voxels(page)).toEqual(original);
  expect(await copies(page)).toEqual([]);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  await expect(page.getByTestId('recovery-waiting')).toHaveCount(0);
  await openPhantom(page);
  await expect(page.getByTestId('recovery-bar')).toHaveCount(0);
});

test('saving the mask removes the recovery copy', async ({ page }) => {
  await openPhantom(page);
  await paintAndWaitForCopy(page);
  expect(await copies(page)).toHaveLength(1);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  await download;
  await expect(page.getByTestId('sync')).toHaveText('Saved');
  await expect(page.getByTestId('recovery-note')).toHaveCount(0);
  expect(await copies(page)).toEqual([]);
});

test("closing with Don't save removes the recovery copy", async ({ page }) => {
  await openPhantom(page);
  await paintAndWaitForCopy(page);
  await page.evaluate(() => window.__w.session.closeImage());
  await page.getByRole('button', { name: "Don't save" }).click();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
  expect(await copies(page)).toEqual([]);
  await expect(page.getByTestId('recovery-waiting')).toHaveCount(0);
});

test('turning autosave off removes copies and stops making them', async ({ page }) => {
  await openPhantom(page);
  await paintAndWaitForCopy(page);
  expect(await copies(page)).toHaveLength(1);

  await page.evaluate(() => window.__w.settings.setSetting('autosave', false));
  await expect(page.getByText('Autosave is off. Recovery copies were removed.')).toBeVisible();
  await expect(page.getByTestId('recovery-note')).toHaveCount(0);
  expect(await copies(page)).toEqual([]);

  await drag(page, 'axial', [-60, -60], [-20, -40]);
  await page.waitForTimeout(4500);
  expect(await copies(page)).toEqual([]);
  await expect(page.getByTestId('sync')).toHaveText('Unsaved changes');

  // The choice is remembered: after a reload nothing is offered and nothing is kept.
  await crash(page);
  await expect(page.getByTestId('recovery-waiting')).toHaveCount(0);
  await openPhantom(page);
  await expect(page.getByTestId('recovery-bar')).toHaveCount(0);
  await page.keyboard.press('b');
  await drag(page, 'axial', [-60, 40], [-20, 70]);
  await page.waitForTimeout(4500);
  expect(await copies(page)).toEqual([]);

  // Back on, the unsaved edits are covered again.
  await page.evaluate(() => window.__w.settings.setSetting('autosave', true));
  await expect(page.getByTestId('recovery-note')).toBeVisible({ timeout: 10_000 });
  expect(await copies(page)).toHaveLength(1);
});

test('everyone in a room keeps their own recovery copy', async ({ browser }) => {
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
  await expect(guest.locator('.segrow')).toHaveCount(2);

  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  await expect(host.getByTestId('recovery-note')).toBeVisible({ timeout: 10_000 });
  await expect(guest.getByTestId('recovery-note')).toBeVisible({ timeout: 10_000 });
  await expect(guest.getByTestId('sync')).toHaveText('Synced · not saved to file');
  expect(await copies(host)).toHaveLength(1);
  expect(await copies(guest)).toHaveLength(1);

  // The guest's copy carries the neutral name from the room, not the host's file name.
  const stored = await guest.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('w-annotator-recovery');
      open.onsuccess = () => resolve(open.result);
    });
    const all = await new Promise<Uint8Array[]>((resolve) => {
      const request = db.transaction('data').objectStore('data').getAll();
      request.onsuccess = () => resolve(request.result);
    });
    return new TextDecoder().decode(all[0].subarray(0, 400));
  });
  expect(stored).toContain('"maskName":"Room mask"');
  expect(stored).not.toContain('phantom');

  await hostCtx.close();
  await guestCtx.close();
});
