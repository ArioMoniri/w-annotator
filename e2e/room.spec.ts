import { expect, test } from '@playwright/test';
import { drag, maskVoxels, openPhantom } from './helpers';

test('two people edit the same mask in a room', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await openPhantom(host);
  await host.getByRole('button', { name: 'Share' }).click();
  await host.getByPlaceholder('How others will see you').fill('Mina');
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  const link = (await host.getByTestId('room-link').textContent())!.trim();
  expect(link).toMatch(/^ws:\/\/.+\/r\/[A-Z0-9]{6}$/);
  await host.keyboard.press('Escape');

  // The guest has nothing open and gets the image and mask from the room.
  await guest.goto('/');
  await guest.getByRole('button', { name: 'Join a room', exact: true }).click();
  await guest.getByPlaceholder('How others will see you').fill('Ario');
  await guest.getByPlaceholder('Paste the invite link').fill(link);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 30_000 });
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatar').first()).toHaveText('A');
  await expect.poll(() => maskVoxels(guest)).toBe(await maskVoxels(host));

  // Host paints; the guest sees it.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  const afterHost = await maskVoxels(host);
  await expect.poll(() => maskVoxels(guest)).toBe(afterHost);

  // Guest erases; the host sees it.
  await guest.keyboard.press('e');
  await drag(guest, 'axial', [30, -20], [70, -10]);
  const afterGuest = await maskVoxels(guest);
  expect(afterGuest).toBeLessThan(afterHost);
  await expect.poll(() => maskVoxels(host)).toBe(afterGuest);

  // Undo on the guest side reaches the host too.
  await guest.keyboard.press('Control+z');
  await expect.poll(() => maskVoxels(host)).toBe(afterHost);

  // A rename travels with the segment list.
  await host.locator('.segrow .name').first().dblclick();
  await host.getByLabel('Segment name').fill('Liver');
  await host.keyboard.press('Enter');
  await expect(guest.locator('.segrow').first()).toContainText('Liver');

  await guest.getByTestId('room-pill').click();
  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(host.locator('.avatar')).toHaveCount(0);

  await hostCtx.close();
  await guestCtx.close();
});

test('masks converge after two people paint over each other at once', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
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
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  // Both drag along the same row towards each other, at the same time.
  await Promise.all([drag(host, 'axial', [-90, 0], [90, 0]), drag(guest, 'axial', [90, 0], [-90, 0])]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dump = (p: typeof host) => p.evaluate(() => Array.from((window as any).__w.session.getMask().data as Uint8Array).join(''));
  await expect.poll(async () => (await dump(host)) === (await dump(guest)), { timeout: 15_000 }).toBe(true);
});

test('joining a room that does not exist says so', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join a room', exact: true }).click();
  await page.getByPlaceholder('How others will see you').fill('Ario');
  await page.getByPlaceholder('Paste the invite link').fill('ZZZ-999');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No room with that code');
});
