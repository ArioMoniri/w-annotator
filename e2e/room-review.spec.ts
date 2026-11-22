import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { cuttable, drag, joinRoom, jumpToVoxel, maskDump, maskVoxels, openPhantom, reconnectNow, sliceDump, startRoom } from './helpers';

/** A page of its own, as another person on another computer would have. */
const opened: BrowserContext[] = [];

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  return context.newPage();
}

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** Stored slices of the phantom where nothing is painted and no pixel of the image is white. */
const SLICES = [8, 12, 40];

/** How many voxels of one stored slice hold `label`. */
const onSlice = (page: Page, k: number, label: number): Promise<number> =>
  page.evaluate(
    ({ k, label }) => {
      const vol = window.__w.session.getMask();
      const n = vol.dims[0] * vol.dims[1];
      return (vol.data as Uint8Array).subarray(k * n, (k + 1) * n).reduce((sum: number, v: number) => sum + (v === label ? 1 : 0), 0);
    },
    { k, label },
  );

/** The number the axial view's own counter shows. */
const axialNumber = (page: Page): Promise<number> => page.evaluate(() => window.__w.store.getState().slices.axial.index + 1);

/** How many pixels of the axial view are pure white: the outline of my version, on slices where the image has none. */
const whitePixels = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector('[data-view="axial"] canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.min(px[i], px[i + 1], px[i + 2]) > 250) n++;
    return n;
  });

/**
 * A guest goes offline and paints segment 2 on each of `slices`; the host paints the same
 * strokes with segment 1 meanwhile. Back online, the room's version stays and the guest's
 * is kept aside on each of those slices.
 */
async function conflictOn(browser: Browser, slices: number[]): Promise<{ host: Page; guest: Page; wire: { cut(): Promise<void>; restore(): void }; link: string }> {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);

  await wire.cut();
  await expect(guest.getByTestId('sync')).toContainText('Offline');
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  await host.keyboard.press('b');
  for (const k of slices) {
    await jumpToVoxel(guest, [24, 24, k]);
    await jumpToVoxel(host, [24, 24, k]);
    await drag(guest, 'axial', [-60, 40], [-20, 70]);
    await drag(host, 'axial', [-60, 40], [-20, 70]);
    expect(await onSlice(guest, k, 2)).toBeGreaterThan(0);
    expect(await onSlice(host, k, 1)).toBeGreaterThan(0);
  }
  return { host, guest, wire, link };
}

test('after offline work each slice that differs is reviewed on its own', async ({ browser }) => {
  const { host, guest, wire } = await conflictOn(browser, SLICES);
  const mine = Object.fromEntries(await Promise.all(SLICES.map(async (k) => [k, await sliceDump(guest, k)] as const)));
  const mineCount = Object.fromEntries(await Promise.all(SLICES.map(async (k) => [k, await onSlice(guest, k, 2)] as const)));

  wire.restore();
  await reconnectNow(guest);
  const bar = guest.getByTestId('merge-review');
  await expect(bar).toContainText(/Your version differs from the room's on 3 slices \([\d,]+ voxels\)\. The room's version is shown; yours is the white outline, kept until you choose\./, { timeout: 30_000 });
  expect(await bar.innerText()).not.toMatch(/!/);
  // The room's version is what is in the mask, for both.
  await expect.poll(async () => (await maskDump(guest)) === (await maskDump(host))).toBe(true);

  // The slices are listed by the number the axial view shows for them.
  const list = guest.getByRole('combobox', { name: 'Slices to review' });
  await expect(list.locator('option')).toHaveText([/^Axial slice \d+ · [\d,]+ voxels$/, /^Axial slice \d+ · [\d,]+ voxels$/, /^Axial slice \d+ · [\d,]+ voxels$/]);
  // The guest is on the last slice painted: the bar says what differs here.
  await expect(bar).toContainText(/This slice: [\d,]+ voxels\./);
  await expect(list.locator('option:checked')).toHaveText(new RegExp(`^Axial slice ${await axialNumber(guest)} · `));

  // My version of this slice is outlined in white over the room's.
  await expect.poll(() => whitePixels(guest)).toBeGreaterThan(40);
  // A slice with nothing to decide has no such outline, and the buttons for one slice are off there.
  await jumpToVoxel(guest, [24, 24, 4]);
  await expect.poll(() => whitePixels(guest)).toBe(0);
  await expect(bar).not.toContainText('This slice');
  await expect(guest.getByRole('button', { name: 'Use mine', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(guest.getByRole('button', { name: 'Use mine', exact: true })).toHaveAttribute('data-tip', 'Go to a slice that differs to choose for it.');
  const untouched = await maskDump(guest);
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click({ force: true });
  expect(await maskDump(guest)).toBe(untouched);

  // Next and previous, by button and by key, go from one such slice to the other and round again.
  const shown = () => guest.evaluate(() => window.__w.session.reviewShownSlice());
  await guest.getByRole('button', { name: 'Next slice to review' }).click();
  await expect.poll(shown).toBe(8);
  await guest.getByRole('button', { name: 'Next slice to review' }).click();
  await expect.poll(shown).toBe(12);
  await guest.locator('[data-view="axial"]').hover();
  await guest.keyboard.press('Alt+ArrowDown');
  await expect.poll(shown).toBe(40);
  await guest.keyboard.press('Alt+ArrowDown');
  await expect.poll(shown).toBe(8);
  await guest.keyboard.press('Alt+ArrowUp');
  await expect.poll(shown).toBe(40);
  await guest.getByRole('button', { name: 'Previous slice to review' }).click();
  await expect.poll(shown).toBe(12);
  // The list takes you to a slice too.
  await list.selectOption({ index: 0 });
  await expect.poll(shown).toBe(8);
  await list.selectOption({ index: 1 });
  await expect.poll(shown).toBe(12);
  await expect(list.locator('option:checked')).toHaveText(new RegExp(`^Axial slice ${await axialNumber(guest)} · `));
  await expect.poll(() => whitePixels(guest)).toBeGreaterThan(40);

  // "Use mine" for this slice is one ordinary edit: the room gets it, the other slices wait.
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click();
  await expect(bar).toContainText(/on 2 slices/);
  expect(await sliceDump(guest, 12)).toBe(mine[12]);
  await expect.poll(() => onSlice(host, 12, 2)).toBe(mineCount[12]);
  expect(await onSlice(host, 8, 2)).toBe(0);
  expect(await onSlice(host, 40, 2)).toBe(0);
  await expect.poll(() => whitePixels(guest)).toBe(0);
  // And it is undone as one step, for everyone.
  await guest.keyboard.press('Control+z');
  await expect.poll(() => onSlice(host, 12, 2)).toBe(0);
  await guest.keyboard.press('Control+Shift+z');
  await expect.poll(() => onSlice(host, 12, 2)).toBe(mineCount[12]);
  await expect(bar).toContainText(/on 2 slices/);

  // "Keep the room's" for a slice changes nothing in the mask and lets my version of it go.
  await guest.getByRole('button', { name: 'Next slice to review' }).click();
  await expect.poll(shown).toBe(40);
  const before = await maskDump(guest);
  await guest.getByRole('button', { name: "Keep the room's", exact: true }).click();
  await expect(bar).toContainText(/on 1 slice \(/);
  expect(await maskDump(guest)).toBe(before);
  await expect.poll(() => whitePixels(guest)).toBe(0);

  // One slice left: nothing to go through, so the bar is the two choices and a way to the slice.
  await expect(list).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Next slice to review' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Use mine for all' })).toHaveCount(0);
  await guest.getByRole('button', { name: 'Go to the slice' }).click();
  await expect.poll(shown).toBe(8);
  await expect(guest.getByRole('button', { name: 'Go to the slice' })).toHaveCount(0);
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => onSlice(host, 8, 2)).toBe(mineCount[8]);
  await expect.poll(async () => (await maskDump(host)) === (await maskDump(guest))).toBe(true);
});

test('every slice can be decided at once, either way, and "Use mine for all" is one undo step', async ({ browser }) => {
  const { host, guest, wire } = await conflictOn(browser, [8, 40]);
  const two = (await onSlice(guest, 8, 2)) + (await onSlice(guest, 40, 2));
  wire.restore();
  await reconnectNow(guest);
  const bar = guest.getByTestId('merge-review');
  await expect(bar).toContainText(/on 2 slices/, { timeout: 30_000 });
  const rooms = await maskVoxels(guest, 2);

  await guest.getByRole('button', { name: 'Use mine for all' }).click();
  await expect(bar).toHaveCount(0);
  expect(await maskVoxels(guest, 2)).toBe(rooms + two);
  await expect.poll(() => maskVoxels(host, 2)).toBe(rooms + two);
  await guest.keyboard.press('Control+z');
  expect(await maskVoxels(guest, 2)).toBe(rooms);
  await expect.poll(() => maskVoxels(host, 2)).toBe(rooms);
  // Undo does not bring the question back: it was answered.
  await expect(bar).toHaveCount(0);

  // The other way round, with a second round of offline work.
  await wire.cut();
  await expect(guest.getByTestId('sync')).toContainText('Offline');
  await guest.keyboard.press('1');
  await host.keyboard.press('2');
  for (const k of [10, 38]) {
    await jumpToVoxel(guest, [24, 24, k]);
    await jumpToVoxel(host, [24, 24, k]);
    await drag(guest, 'axial', [-60, 40], [-20, 70]);
    await drag(host, 'axial', [-60, 40], [-20, 70]);
  }
  wire.restore();
  await reconnectNow(guest);
  await expect(bar).toContainText(/on 2 slices/, { timeout: 30_000 });
  const hosts = await maskDump(host);
  await guest.getByRole('button', { name: "Keep the room's for all" }).click();
  await expect(bar).toHaveCount(0);
  expect(await maskDump(guest)).toBe(hosts);
  expect(await maskDump(host)).toBe(hosts);
});

test('my version stays kept aside after leaving the room, and choosing it then is offline work', async ({ browser }) => {
  const { host, guest, wire } = await conflictOn(browser, [8]);
  const mine = await onSlice(guest, 8, 2);
  wire.restore();
  await reconnectNow(guest);
  const bar = guest.getByTestId('merge-review');
  await expect(bar).toContainText(/on 1 slice \(/, { timeout: 30_000 });

  // Leaving does not answer the question.
  await guest.getByTestId('room-pill').click();
  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(guest.getByTestId('room-pill')).toHaveCount(0);
  await expect(bar).toContainText(/on 1 slice \(/);
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click();
  await expect(bar).toHaveCount(0);
  expect(await onSlice(guest, 8, 2)).toBe(mine);
  expect(await onSlice(host, 8, 2)).toBe(0);

  // Back in the room it is merged like any work done while away. The host has not touched those
  // voxels since, so there is nothing to ask this time.
  await guest.getByRole('button', { name: 'Share' }).click();
  await guest.getByRole('tab', { name: 'Join a room' }).click();
  await guest.getByTestId('my-rooms').getByRole('button', { name: 'Rejoin' }).click();
  await expect(guest.getByTestId('sync')).toContainText('Synced', { timeout: 30_000 });
  await expect.poll(() => onSlice(host, 8, 2)).toBe(mine);
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await maskDump(host)) === (await maskDump(guest))).toBe(true);
});

/* ───────────────────────── across a restart of the app ───────────────────────── */

/** Reload without saving, the way a crash or a closed window ends a session. */
async function crash(page: Page): Promise<void> {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.waitForFunction(() => '__w' in window);
}

/** Opens the phantom again and takes back the unsaved mask the app kept. */
async function reopenAndRestore(page: Page): Promise<void> {
  await openPhantom(page);
  await page.getByTestId('recovery-bar').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByTestId('recovery-bar')).toHaveCount(0);
}

async function rejoin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('tab', { name: 'Join a room' }).click();
  await page.getByTestId('my-rooms').getByRole('button', { name: 'Rejoin' }).click();
}

test('offline work survives a restart of the app and is still merged three-way', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  const room = /\/j\/([A-Z0-9]+)#/.exec(link)![1];
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  const start = await maskVoxels(host);

  // Offline, the guest paints; its recovery copy is written, and with it what the room had.
  await wire.cut();
  await expect(guest.getByTestId('sync')).toContainText('Offline');
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  const guestAdded = (await maskVoxels(guest)) - start;
  expect(guestAdded).toBeGreaterThan(0);
  await expect(guest.getByTestId('recovery-note')).toHaveText(/recovery copy \d\d:\d\d$/, { timeout: 15_000 });
  await guest.evaluate(() => window.__w.recovery.settled());
  const guests = await maskDump(guest);

  // Meanwhile the host paints somewhere else.
  await host.keyboard.press('2');
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  const hostAdded = (await maskVoxels(host)) - start;
  expect(hostAdded).toBeGreaterThan(0);

  // The guest's app goes away and comes back; they open the image and take their unsaved mask back.
  await crash(guest);
  await reopenAndRestore(guest);
  expect(await maskDump(guest)).toBe(guests);
  // What the room had when they left came back with that mask.
  await expect.poll(() => guest.evaluate((id) => window.__w.session.hasMergeBase(id), room)).toBe(true);

  wire.restore();
  await rejoin(guest);
  // Three-way: their work is added, the host's is taken, and nothing is left to ask, because the
  // two changed different voxels. Merged two-way, every one of those voxels would be a question.
  await expect(guest.locator('.toast').filter({ hasText: 'Merged your offline work' })).toContainText(/Merged your offline work: [\d,]+ voxels on 1 slice added\./, { timeout: 30_000 });
  await expect(guest.getByTestId('merge-review')).toHaveCount(0);
  await expect.poll(() => maskVoxels(host)).toBe(start + guestAdded + hostAdded);
  expect(await maskDump(guest)).toBe(await maskDump(host));
});

test('a mask that is not the one the room copy was written for is merged two-way, as before', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const wire = await cuttable(guest);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  const room = /\/j\/([A-Z0-9]+)#/.exec(link)![1];
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);

  await wire.cut();
  await expect(guest.getByTestId('sync')).toContainText('Offline');
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  await expect(guest.getByTestId('recovery-note')).toHaveText(/recovery copy \d\d:\d\d$/, { timeout: 15_000 });
  await guest.evaluate(() => window.__w.recovery.settled());

  // After the restart the guest opens the mask from its file and does not take the unsaved one back:
  // that file never saw what the room copy was written for.
  await crash(guest);
  await openPhantom(guest);
  await guest.getByTestId('recovery-bar').getByRole('button', { name: 'Discard' }).click();
  await expect(guest.getByTestId('recovery-bar')).toHaveCount(0);
  await guest.evaluate(() => window.__w.recovery.settled());
  expect(await guest.evaluate((id) => window.__w.session.hasMergeBase(id), room)).toBe(false);
});

test('what a merge kept aside is still there after a restart of the app', async ({ browser }) => {
  const { host, guest, wire } = await conflictOn(browser, [8, 40]);
  const mine8 = await onSlice(guest, 8, 2);
  const savedAt = () => guest.evaluate(() => window.__w.recovery.useRecovery.getState().savedAt ?? 0);
  await expect.poll(savedAt, { timeout: 15_000 }).toBeGreaterThan(0);
  const before = await savedAt();
  wire.restore();
  await reconnectNow(guest);
  const bar = guest.getByTestId('merge-review');
  await expect(bar).toContainText(/on 2 slices/, { timeout: 30_000 });
  // The merge left unsaved changes, so a recovery copy follows, and what was kept aside goes with it.
  await expect.poll(savedAt, { timeout: 15_000 }).toBeGreaterThan(before);
  await guest.evaluate(() => window.__w.recovery.settled());

  await wire.cut();
  await crash(guest);
  await reopenAndRestore(guest);
  await expect(bar).toContainText(/on 2 slices/);
  await expect(guest.getByRole('combobox', { name: 'Slices to review' }).locator('option')).toHaveCount(3);

  // It still does what it did: my version of a slice, as an edit.
  await jumpToVoxel(guest, [24, 24, 8]);
  await expect(bar).toContainText(/This slice/);
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click();
  await expect(bar).toContainText(/on 1 slice \(/);
  expect(await onSlice(guest, 8, 2)).toBe(mine8);

  // And the room gets it on return, as offline work.
  wire.restore();
  await rejoin(guest);
  await expect(guest.getByTestId('sync')).toContainText('Synced', { timeout: 30_000 });
  await expect.poll(() => onSlice(host, 8, 2)).toBe(mine8);
  await expect(bar).toContainText(/on 1 slice \(/);
});
