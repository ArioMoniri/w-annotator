import { expect, test, type Page } from '@playwright/test';
import {
  INVITE_LINK,
  anotherLink,
  cuttable,
  drag,
  imageValue,
  joinRoom,
  jumpToVoxel,
  maskDump,
  maskVoxels,
  openPhantom,
  pixelAt,
  reconnectNow,
  sliceDump,
  startRoom,
  submitJoin,
  watchRoomTraffic,
} from './helpers';

/** A page of its own, as a second person on another computer would have. */
const opened: import('@playwright/test').BrowserContext[] = [];

async function person(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  return context.newPage();
}

// Each person's window is closed when the test is over. Left open, they pile up through the
// file, and the later tests share the machine with dozens of idle pages.
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** A fresh page that tries a link and stays on the join form. */
async function tryJoin(browser: import('@playwright/test').Browser, name: string, link: string): Promise<Page> {
  const page = await person(browser);
  await page.goto('/');
  await submitJoin(page, name, link);
  return page;
}

const errorToast = (page: Page) => page.locator('.toast[data-kind="error"]');

/* ───────────────────────── shared copy ───────────────────────── */

test('two people edit the same mask in a shared-copy room', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);

  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  expect(link).toMatch(INVITE_LINK);

  // The guest has nothing open and gets the image and mask from the room.
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatar').first()).toHaveText('A');
  await expect.poll(() => maskVoxels(guest)).toBe(await maskVoxels(host));
  // The copy is the real image: the same 16-bit values, not a picture of them.
  expect(await imageValue(guest, [24, 24, 24])).toBe(await imageValue(host, [24, 24, 24]));
  expect(await guest.evaluate(() => (window as never as { __w: { session: { getImage(): { name: string } } } }).__w.session.getImage().name)).toBe('Room image');

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

  // A rename travels as its own small message.
  await host.locator('.segrow .name').first().dblclick();
  await host.getByLabel('Segment name').fill('Liver');
  await host.keyboard.press('Enter');
  await expect(guest.locator('.segrow').first()).toContainText('Liver');

  // Each sees the other by name, and who the host is.
  await guest.getByTestId('room-pill').click();
  await expect(guest.getByTestId('room-kind')).toHaveText('Shared copy');
  await expect(guest.getByTestId('room-person')).toContainText('Mina');
  await expect(guest.getByTestId('room-person')).toContainText('Host');
  // Only the host can remove people or make links.
  await expect(guest.getByRole('button', { name: 'Remove Mina' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'New invite link' })).toHaveCount(0);

  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(host.locator('.avatar')).toHaveCount(0);
  // The guest keeps their copy.
  await expect(guest.locator('[data-view="axial"] canvas').first()).toBeVisible();
  expect(await maskVoxels(guest)).toBe(afterHost);
});

test('masks converge after two people paint over each other at once', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);

  await host.keyboard.press('b');
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  // Both drag along the same row towards each other, at the same time.
  await Promise.all([drag(host, 'axial', [-90, 0], [90, 0]), drag(guest, 'axial', [90, 0], [-90, 0])]);
  await expect.poll(async () => (await maskDump(host)) === (await maskDump(guest)), { timeout: 15_000 }).toBe(true);
  // Both strokes are in the result: the relay's order decided each voxel, nothing was thrown away wholesale.
  expect(await maskVoxels(host, 1)).toBeGreaterThan(0);
  expect(await maskVoxels(host, 2)).toBeGreaterThan(0);
});

test('a rename and a new segment made at the same moment both survive', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);

  await Promise.all([
    host.evaluate(() => window.__w.session.patchSegment(1, { name: 'Liver' })),
    guest.evaluate(() => window.__w.session.addSegment()),
  ]);
  for (const page of [host, guest]) {
    await expect(page.locator('.segrow')).toHaveCount(3);
    await expect(page.locator('.segrow').first()).toContainText('Liver');
  }
});

/* ───────────────────────── invites ───────────────────────── */

test('a link that does not lead to a room says so, and a bare code is no longer enough', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join a room', exact: true }).click();
  await page.getByPlaceholder('How others will see you').fill('Ario');
  await page.getByPlaceholder('Paste the invite link').fill('ZZZ-999');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Paste the whole invite link, including the part after #.');

  const relay = `http://localhost:${process.env.W_RELAY_PORT ?? 8787}`;
  await page.getByPlaceholder('Paste the invite link').fill(`${relay}/j/NOSUCHROOM23#AAECAwQFBgcICQoLDA0ODw`);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('No room at that link. Check the link and try again.');
});

test('an invite link works once', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');

  const first = await person(browser);
  await joinRoom(first, 'Ario', link);

  // Someone else with the same link is refused, and told what to do.
  const second = await tryJoin(browser, 'Ben', link);
  await expect(second.getByRole('alert')).toHaveText('This invite link was already used. Ask the host for a new one.');
  await expect(host.locator('.avatar')).toHaveCount(1);

  // A new link from the host lets them in.
  const fresh = await anotherLink(host);
  expect(fresh).toMatch(INVITE_LINK);
  expect(fresh).not.toBe(link);
  await second.getByPlaceholder('Paste the invite link').fill(fresh);
  await second.getByRole('button', { name: 'Join', exact: true }).click();
  await second.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 30_000 });
  await expect(host.locator('.avatar')).toHaveCount(2);
});

test('an invite link stops working when its time is up', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  await startRoom(host, 'Mina');
  // The app makes links that last a day; the test asks for one second so it can wait it out.
  const link = await anotherLink(host, 1);
  await host.waitForTimeout(1600);
  const late = await tryJoin(browser, 'Ario', link);
  await expect(late.getByRole('alert')).toHaveText('This invite link has expired. Ask the host for a new one.');
  await expect(host.locator('.avatar')).toHaveCount(0);
});

test('the host can switch a link off before it is used', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await host.getByTestId('room-pill').click();
  await expect(host.getByTestId('room-links')).toContainText('Link 1 · 1 use left · 24 h left');
  await host.getByRole('button', { name: 'Switch off' }).click();
  await expect(host.getByTestId('room-links')).toHaveCount(0);

  const guest = await tryJoin(browser, 'Ario', link);
  await expect(guest.getByRole('alert')).toHaveText('This invite link was switched off. Ask the host for a new one.');
});

/* ───────────────────────── removing people, ending the room ───────────────────────── */

test('the host removes someone from a shared-copy room, and they cannot come back', async ({ browser }) => {
  const host = await person(browser);
  const ario = await person(browser);
  const ben = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(ario, 'Ario', link);
  await joinRoom(ben, 'Ben', await anotherLink(host));
  await expect(host.locator('.avatar')).toHaveCount(2);

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Remove Ario' }).click();
  await expect(host.getByRole('dialog')).toContainText('Ario keeps the copy already on their computer');
  await host.getByRole('button', { name: 'Remove', exact: true }).click();

  // Ario is out within a second, is told who did it, and keeps the copy.
  await expect(errorToast(ario)).toHaveText(/Mina removed you from this room\. Your copy stays on this computer\./, { timeout: 2000 });
  await expect(ario.getByTestId('room-pill')).toHaveCount(0);
  await expect(ario.locator('[data-view="axial"] canvas').first()).toBeVisible();
  await expect(host.locator('.avatar')).toHaveCount(1);

  // The link they came in through went with them.
  await submitJoin(ario, 'Ario', link);
  await expect(ario.getByRole('dialog').getByRole('alert')).toHaveText('This invite link was switched off. Ask the host for a new one.');

  // The others carry on.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => maskVoxels(ben)).toBe(await maskVoxels(host));
  expect(await maskVoxels(ario)).toBeLessThan(await maskVoxels(host));
});

test('the host deletes a shared-copy room for everyone', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(host.locator('.avatar')).toHaveCount(1);
  const spare = await anotherLink(host);

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Delete room' }).click();
  await expect(host.getByRole('dialog')).toContainText('People keep the copies already on their computers');
  await host.getByRole('button', { name: 'Delete room' }).click();

  await expect(errorToast(guest)).toHaveText(/Mina deleted this room\. Your copy stays on this computer\./);
  await expect(guest.getByTestId('room-pill')).toHaveCount(0);
  await expect(host.getByTestId('room-pill')).toHaveCount(0);
  await expect(guest.locator('[data-view="axial"] canvas').first()).toBeVisible();

  // Its links are dead and the room is gone from the guest's list of rooms.
  const late = await tryJoin(browser, 'Ben', spare);
  await expect(late.getByRole('alert')).toHaveText('This room has ended.');
  expect(await guest.evaluate(() => localStorage.getItem('w-annotator:rooms'))).toBeNull();
});

/* ───────────────────────── offline work ───────────────────────── */

test('a shared-copy guest keeps working offline and is merged on return', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const link_ = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  const start = await maskVoxels(host);

  await link_.cut();
  await expect(guest.getByTestId('sync')).toHaveText('Offline · changes merge when you reconnect');
  await expect(host.locator('.avatar')).toHaveCount(0);

  // Both keep working, on different parts of the slice.
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  const guestAdded = (await maskVoxels(guest)) - start;
  expect(guestAdded).toBeGreaterThan(0);
  await host.keyboard.press('2');
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  const hostAdded = (await maskVoxels(host)) - start;
  expect(hostAdded).toBeGreaterThan(0);
  // Nothing crossed while the guest was away.
  expect(await maskVoxels(guest)).toBe(start + guestAdded);

  link_.restore();
  await reconnectNow(guest);
  await expect(guest.locator('.toast').filter({ hasText: 'Merged your offline work' })).toContainText(/Merged your offline work: [\d,]+ voxels on 1 slice added\./, { timeout: 30_000 });
  await expect(guest.getByTestId('sync')).toContainText('Synced');

  // Changes to different voxels are both kept, on both sides.
  await expect.poll(() => maskVoxels(host)).toBe(start + guestAdded + hostAdded);
  expect(await maskDump(guest)).toBe(await maskDump(host));
  await expect(guest.getByTestId('merge-review')).toHaveCount(0);
});

test("after offline work on the same voxels the room's version stays and mine is kept for review", async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);

  await wire.cut();
  await expect(guest.getByTestId('sync')).toContainText('Offline');

  // The same stroke, with different segments.
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  const mine = await maskVoxels(guest, 2);
  const rooms = await maskVoxels(host, 2);
  expect(mine).toBeGreaterThan(rooms);

  wire.restore();
  await reconnectNow(guest);

  // The room's version is on screen; mine is not lost, it waits.
  await expect(guest.getByTestId('merge-review')).toContainText(/Your version differs from the room's on 1 slice \([\d,]+ voxels\)/, { timeout: 30_000 });
  await expect.poll(async () => (await maskDump(guest)) === (await maskDump(host))).toBe(true);
  const merged = await maskVoxels(guest, 2);
  expect(merged).toBeLessThan(mine);

  // "Use mine" is an ordinary edit: everyone gets it, and it can be undone.
  await guest.getByRole('button', { name: 'Use mine' }).click();
  await expect(guest.getByTestId('merge-review')).toHaveCount(0);
  expect(await maskVoxels(guest, 2)).toBe(mine);
  await expect.poll(() => maskVoxels(host, 2)).toBe(mine);
  await guest.keyboard.press('Control+z');
  await expect.poll(() => maskVoxels(host, 2)).toBe(merged);
});

test('someone who left a shared-copy room can rejoin from their list of rooms and is merged', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatar')).toHaveCount(1);
  const start = await maskVoxels(host);

  await guest.getByTestId('room-pill').click();
  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(host.locator('.avatar')).toHaveCount(0);

  // Work goes on at both ends.
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  const total = (await maskVoxels(guest)) + (await maskVoxels(host)) - start;

  // The link is spent, but the guest is a member: the room is in their list.
  await guest.getByRole('button', { name: 'Share' }).click();
  await guest.getByRole('tab', { name: 'Join a room' }).click();
  await expect(guest.getByTestId('my-rooms')).toContainText("Mina's room");
  await guest.getByRole('button', { name: 'Rejoin' }).click();
  await expect(guest.getByTestId('room-pill')).toBeVisible();
  await expect.poll(() => maskVoxels(host)).toBe(total);
  expect(await maskDump(guest)).toBe(await maskDump(host));
});

/* ───────────────────────── view through the host's computer ───────────────────────── */

test('a view-through-host guest sees and edits without receiving the files', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const traffic = watchRoomTraffic(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  expect(link).toMatch(INVITE_LINK);

  await joinRoom(guest, 'Ario', link);
  await expect(guest.getByTestId('guest-banner')).toHaveText("Viewing through Mina's computer. Nothing is saved on this device.");
  await expect(guest.locator('.segrow')).toHaveCount(2);

  // The planes on screen arrive as 8-bit pictures; the mask on them matches the host's.
  await expect.poll(() => imageValue(guest, [24, 24, 24])).toBeGreaterThan(0);
  const kind = await guest.evaluate(() => (window as never as { __w: { session: { getImage(): { data: object } } } }).__w.session.getImage().data.constructor.name);
  expect(kind).toBe('Uint8Array');
  expect(await imageValue(host, [24, 24, 24])).toBeGreaterThan(255);
  // What the guest sees is what the host sees: the same grey at the same place, with the host's window.
  const spot: [number, number, number] = [28, 36, 24];
  await expect
    .poll(async () => Math.abs((await pixelAt(guest, 'axial', spot))[0] - (await pixelAt(host, 'axial', spot))[0]), { timeout: 10_000 })
    .toBeLessThanOrEqual(6);
  expect((await pixelAt(host, 'axial', spot))[0]).toBeGreaterThan(60);
  // Volumes and other measurements would be of the few planes the guest holds, so none are shown.
  expect(await guest.evaluate(() => Object.keys((window as never as { __w: { store: { getState(): { stats: object } } } }).__w.store.getState().stats).length)).toBe(0);
  // A voxel inside the phantom, away from the planes shown and the ones next to them, has not been sent.
  expect(await imageValue(guest, [30, 30, 30])).toBe(0);
  expect(await imageValue(host, [30, 30, 30])).toBeGreaterThan(0);
  // Scrolling there asks the host for that plane.
  await jumpToVoxel(guest, [30, 30, 30]);
  await expect.poll(() => imageValue(guest, [30, 30, 30])).toBeGreaterThan(0);

  // Guest paints; the host's mask, the only real one, changes. Host paints; the guest sees it.
  await jumpToVoxel(guest, [24, 24, 24]);
  const before = await maskVoxels(host);
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => maskVoxels(host)).toBeGreaterThan(before);
  const afterGuest = await maskVoxels(host);
  await host.keyboard.press('2');
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  expect(await maskVoxels(host)).toBeGreaterThan(afterGuest);
  // On the plane both are looking at, the guest has exactly the host's labels.
  await expect.poll(async () => (await sliceDump(guest, 24)) === (await sliceDump(host, 24))).toBe(true);

  // Saving is off for the guest, and nothing has been written on their device.
  await guest.keyboard.press('Control+s');
  await expect(guest.locator('.toast')).toContainText('Saving is off in this room');
  await expect(guest.getByTestId('sync')).toHaveText('Synced · nothing saved on this device');
  const stored = await guest.evaluate(async () => ({
    rooms: localStorage.getItem('w-annotator:rooms'),
    copies: await new Promise<number>((resolve) => {
      const open = indexedDB.open('w-annotator-recovery');
      open.onerror = () => resolve(0);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('data')) return resolve(0);
        const count = db.transaction('data').objectStore('data').count();
        count.onsuccess = () => resolve(count.result);
      };
    }),
  }));
  expect(stored.rooms).toBeNull();
  expect(stored.copies).toBe(0);

  // The host sees how much each guest has looked at.
  await host.getByTestId('room-pill').click();
  await expect(host.getByTestId('room-kind')).toHaveText('View through your computer');
  await expect(host.getByTestId('room-person')).toContainText(/\d+ slices seen/);
  await host.keyboard.press('Escape');

  // On the wire: no image or mask transfer of any kind, only planes that were asked for,
  // and far fewer bytes than the 16-bit image holds (48 × 48 × 48 × 2).
  expect(traffic.kinds[3] ?? 0).toBe(0);
  expect(traffic.kinds[4] ?? 0).toBe(0);
  expect(traffic.kinds[7]).toBeGreaterThan(0);
  expect(traffic.bytes).toBeLessThan((48 * 48 * 48 * 2) / 2);
});

test('a view-through-host guest is dropped and wiped when the host leaves', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(guest, 'Ario', link);
  await expect.poll(() => imageValue(guest, [24, 24, 24])).toBeGreaterThan(0);

  // The host closes the app.
  await hostCtx.close();

  // At once the guest sees nothing more of the image: the room is over, or the view is blank until it is.
  await expect(guest.getByTestId('room-veil').or(errorToast(guest))).toBeVisible({ timeout: 2000 });
  await expect(errorToast(guest)).toHaveText(/The host ended the session\. Nothing was saved on this device\./, { timeout: 20_000 });
  // Nothing is left to look at: no room, no views, no image in memory.
  await expect(guest.getByTestId('room-pill')).toHaveCount(0);
  await expect(guest.locator('[data-view="axial"]')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Open image' })).toBeVisible();
  expect(await guest.evaluate(() => (window as never as { __w: { session: { getImage(): unknown; getMask(): unknown } } }).__w.session.getImage())).toBeNull();
  expect(await guest.evaluate(() => (window as never as { __w: { session: { getMask(): unknown } } }).__w.session.getMask())).toBeNull();

  // The session is over for good: its links are dead.
  const late = await tryJoin(browser, 'Ben', link);
  await expect(late.getByRole('alert')).toHaveText('This room has ended.');
});

test('the host ends a view-through-host room, or removes one guest from it', async ({ browser }) => {
  const host = await person(browser);
  const ario = await person(browser);
  const ben = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(ario, 'Ario', link);
  await joinRoom(ben, 'Ben', await anotherLink(host));
  await expect(host.locator('.avatar')).toHaveCount(2);
  // Guests only ever talk to the host, who passes the names on.
  await ben.getByTestId('room-pill').click();
  await expect(ben.getByTestId('room-person').filter({ hasText: 'Ario' })).toHaveCount(1);
  await ben.keyboard.press('Escape');

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Remove Ario' }).click();
  await host.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(errorToast(ario)).toHaveText(/Mina removed you from this room\. Nothing was saved on this device\./, { timeout: 2000 });
  await expect(ario.locator('[data-view="axial"]')).toHaveCount(0);
  await expect(ben.getByTestId('guest-banner')).toBeVisible();

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'End room' }).click();
  await expect(host.getByRole('dialog')).toContainText('Everyone is disconnected at once');
  await host.getByRole('button', { name: 'End room' }).click();
  await expect(errorToast(ben)).toHaveText(/The host ended the session\. Nothing was saved on this device\./);
  await expect(ben.locator('[data-view="axial"]')).toHaveCount(0);
  await expect(host.getByTestId('room-pill')).toHaveCount(0);
  // The host keeps working on their own files.
  await expect(host.locator('[data-view="axial"] canvas').first()).toBeVisible();
});

test("a view-through-host guest's view is blanked while the connection to the host is down", async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(guest, 'Ario', link);
  await expect.poll(() => imageValue(guest, [24, 24, 24])).toBeGreaterThan(0);

  // The network blinks: the guest sees nothing until the host can be reached again.
  await wire.cut();
  // It is the guest's own connection that is down, and the app says so: the host has gone nowhere.
  await expect(guest.getByTestId('room-veil')).toHaveText('Offline. Reconnecting…', { timeout: 2000 });
  wire.restore();
  await reconnectNow(guest);
  await expect(guest.getByTestId('room-veil')).toHaveCount(0, { timeout: 12_000 });
  await expect(guest.getByTestId('guest-banner')).toBeVisible();

  // Edits flow again in both directions.
  const before = await maskVoxels(host);
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => maskVoxels(host)).toBeGreaterThan(before);
});

test('a view-through-host guest who is offline for a long time stays a member and comes back', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(guest, 'Ario', link);
  await expect.poll(() => imageValue(guest, [24, 24, 24])).toBeGreaterThan(0);

  // Only the guest's connection goes, and stays gone past the 15 seconds after which the pictures are cleared.
  await wire.cut();
  await expect(guest.getByTestId('room-veil')).toHaveText('Offline. Reconnecting…', { timeout: 2000 });
  await expect(guest.getByTestId('room-veil')).toContainText('cleared from this device', { timeout: 20_000 });
  // The pictures are gone from memory, as promised; the guest is still in the room and is told nothing untrue.
  expect(await imageValue(guest, [24, 24, 24])).toBe(0);
  await expect(guest.getByTestId('room-pill')).toBeVisible();
  await expect(errorToast(guest)).toHaveCount(0);
  await expect(guest.getByText('The host ended the session')).toHaveCount(0);
  // The host never noticed more than a guest going offline.
  await expect(host.getByTestId('room-pill')).toBeVisible();

  // The connection returns: the same guest is back without a new link, and sees the image again.
  wire.restore();
  await reconnectNow(guest);
  await expect(guest.getByTestId('room-veil')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => imageValue(guest, [24, 24, 24]), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(host.locator('.avatar')).toHaveCount(1);
  const before = await maskVoxels(host);
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => maskVoxels(host)).toBeGreaterThan(before);
});

test("a view-through-host guest is shown grey levels and the host's window, not numbers that mean nothing", async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(guest, 'Ario', link);
  await expect.poll(() => imageValue(guest, [24, 24, 24])).toBeGreaterThan(0);
  const numbers = (text: string | null) => /W\s*(\S+)\s*L\s*(\S+)/.exec(text ?? '')?.slice(1, 3).join(' ');
  const state = () => guest.evaluate(() => window.__w.store.getState());

  // The window in the guest's status bar is the host's, to read; the guest has no preset menu of their own.
  const hostWindow = numbers(await host.getByTestId('status-window').textContent());
  expect(hostWindow).toBeTruthy();
  await expect(guest.getByTestId('host-window')).toContainText("Host's window");
  await expect.poll(async () => numbers(await guest.getByTestId('host-window').textContent())).toBe(hostWindow);
  await expect(guest.getByTestId('status-window')).toHaveCount(0);

  // Stepping through presets cannot turn the picture black and white: there is one window for grey levels.
  await guest.keyboard.press('p');
  await guest.keyboard.press('p');
  expect((await state()).voi).toEqual({ lower: 0, upper: 255 });
  // The threshold brush works on the grey levels it can see, from 0 to 255.
  expect((await state()).image.range).toEqual([0, 255]);
  expect((await state()).threshold).toEqual([128, 255]);
  await guest.keyboard.press('w');
  await expect(guest.locator('#wl-preset option:not([disabled])')).toHaveText(['Full range']);

  // The value under the cursor is called what it is.
  const box = (await guest.locator('[data-view="axial"]').boundingBox())!;
  await guest.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(guest.getByTestId('value')).toContainText('Grey');
  await expect(guest.getByTestId('value')).not.toContainText('HU');

  // The mask has the room's neutral name, and the 3D pane says why it is empty.
  await expect(guest.locator('.filerow', { hasText: 'Room mask' })).toHaveCount(1);
  await expect(guest.locator('.filerow', { hasText: 'New mask' })).toHaveCount(0);
  await expect(guest.getByTestId('no-3d')).toHaveText("The 3D view stays on the host's computer.");

  // The host changes its window; the guest's read-out follows.
  await host.keyboard.press('p');
  const next = numbers(await host.getByTestId('status-window').textContent());
  expect(next).not.toBe(hostWindow);
  await expect.poll(async () => numbers(await guest.getByTestId('host-window').textContent()), { timeout: 10_000 }).toBe(next);
});

test('the host of a shared-copy room is asked before leaving, and the others are told what it means', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  await openPhantom(host);
  await joinRoom(guest, 'Ario', await startRoom(host, 'Mina'));
  await expect(host.locator('.avatar')).toHaveCount(1);
  // Past the quiet seconds after joining, when arrivals and departures are not announced.
  await guest.waitForTimeout(3500);

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Leave room' }).click();
  const ask = host.getByRole('dialog');
  await expect(ask).toContainText('Leave the room?');
  await expect(ask).toContainText('Others can keep working');
  await expect(ask).toContainText('Nobody can invite or remove people until you come back');
  // Cancel leaves everything as it was.
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(host.getByTestId('room-pill')).toBeVisible();

  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Leave room' }).click();
  await host.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(host.getByTestId('room-pill')).toHaveCount(0);
  const left = host.locator('.toast', { hasText: 'You left the room' });
  await expect(left).toBeVisible();
  // It stays long enough to read.
  await host.waitForTimeout(2500);
  await expect(left).toBeVisible();

  // The guest hears that it was the host who went, and what that changes.
  await expect(guest.locator('.toast', { hasText: 'Mina, the host, left' })).toContainText('You can keep working');
  await expect(guest.getByTestId('room-pill')).toBeVisible();
  const before = await maskVoxels(guest);
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  expect(await maskVoxels(guest)).toBeGreaterThan(before);
});

/* ───────────────────────── the dialog ───────────────────────── */

test('starting a room offers two kinds, described in plain words', async ({ page }) => {
  await openPhantom(page);
  await page.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('radio', { name: 'Shared copy' })).toBeChecked();
  await expect(dialog).toContainText('Everyone gets the image and the mask and keeps a copy. They can keep working without you.');
  await expect(dialog).toContainText("Others see and edit the mask through your computer. They don't receive the files and can't save.");
  await expect(dialog).toContainText("it can't stop someone photographing or recording their screen");
  expect(await dialog.innerText()).not.toMatch(/!|secure|protected/i);

  // The name comes from Settings and goes back there; nothing else is asked.
  await page.getByPlaceholder('How others will see you').fill('Mina');
  await dialog.getByRole('radio', { name: 'View through my computer' }).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog).toContainText('Each link works for one person and stops working after 24 hours.');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('w-annotator:settings')!).displayName)).toBe('Mina');

  // The close button never sits on the content.
  const close = (await dialog.getByRole('button', { name: 'Close' }).boundingBox())!;
  for (const part of [dialog.getByRole('heading', { name: 'Room started' }), dialog.getByTestId('room-link')]) {
    const box = (await part.boundingBox())!;
    const apart = box.x + box.width <= close.x || close.x + close.width <= box.x || box.y + box.height <= close.y || close.y + close.height <= box.y;
    expect(apart).toBe(true);
  }

  // Another person needs another link.
  const first = await dialog.getByTestId('room-link').textContent();
  await dialog.getByRole('button', { name: 'Link for another person' }).click();
  await expect(dialog.getByTestId('room-link')).not.toHaveText(first!);
});
