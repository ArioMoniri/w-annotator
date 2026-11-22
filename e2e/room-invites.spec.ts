import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { joinRoom as botJoin, KIND } from '../e2e-desktop/roombot.mjs';
import { drag, joinRoom, maskDump, maskVoxels, openPhantom, startRoom, submitJoin } from './helpers';

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

/** A fresh page that tries a link and stays on the join form. */
async function tryJoin(browser: Browser, name: string, link: string): Promise<Page> {
  const page = await person(browser);
  await page.goto('/');
  await submitJoin(page, name, link);
  return page;
}

/** Starts a room and stays on the step that hands out links. */
async function startAndStay(page: Page, name: string, kind = 'Shared copy'): Promise<void> {
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByPlaceholder('How others will see you').fill(name);
  await page.getByRole('radio', { name: kind }).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('room-link')).toBeVisible();
}

const linkOn = async (page: Page) => (await page.getByTestId('room-link').textContent())!.trim();

/* ───────────────────────── invite options ───────────────────────── */

test('a link can be made for up to five people, for an hour, with a note for the host', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  await startAndStay(host, 'Mina');
  const dialog = host.getByRole('dialog');

  // Nothing new to look at until it is asked for: the options are folded away, and the first link is the usual one.
  await expect(dialog.getByTestId('room-link-rule')).toContainText('Each link works for one person and stops working after 24 hours.');
  await expect(dialog.getByLabel('Stops working after')).toBeHidden();
  const first = await linkOn(host);

  await dialog.getByText('Link options').click();
  await expect(dialog.getByLabel('Stops working after')).toHaveValue('day');
  await expect(dialog.getByLabel('Works for')).toHaveValue('one');
  await expect(dialog.getByTestId('link-uses-help')).toHaveText('The link stops working once one person has joined.');
  await dialog.getByLabel('Stops working after').selectOption({ label: '1 hour' });
  await dialog.getByLabel('Works for').selectOption({ label: 'Up to 5 people' });
  await expect(dialog.getByTestId('link-uses-help')).toHaveText('The link stops working once five people have joined.');
  await dialog.getByLabel('Note for your own list').fill('for the team');
  await dialog.getByRole('button', { name: 'New link' }).click();
  await expect(dialog.getByTestId('room-link')).not.toHaveText(first);
  await expect(dialog.getByTestId('room-link-rule')).toContainText('This link works for up to 5 people and stops working after 1 hour.');
  // A note belongs to one link.
  await expect(dialog.getByLabel('Note for your own list')).toHaveValue('');
  expect(await dialog.innerText()).not.toMatch(/!/);
  const shared = await linkOn(host);
  await host.keyboard.press('Escape');

  // Two people come in through the same link.
  const ben = await person(browser);
  const cleo = await person(browser);
  await joinRoom(ben, 'Ben', shared);
  await joinRoom(cleo, 'Cleo', shared);
  await expect(host.locator('.avatars .avatar')).toHaveCount(2);
  await expect.poll(() => maskVoxels(cleo)).toBe(await maskVoxels(host));

  // The host's list: the note, the uses left as the room server counts them, the time left, and the way to switch it off.
  await host.getByTestId('room-pill').click();
  const links = host.getByTestId('room-links');
  await expect(links).toContainText('for the team · 3 of 5 uses left · 60 min left');
  await expect(links).toContainText('Link 1 · 1 use left · 24 h left');
  // The note is the host's own: it is not in what the room server keeps for the link, and nobody else has it.
  expect(await ben.evaluate(() => JSON.stringify(localStorage))).not.toContain('for the team');

  const row = links.locator('.link').filter({ hasText: 'for the team' });
  await row.getByRole('button', { name: 'Switch off' }).click();
  await expect(links).not.toContainText('for the team');
  await host.keyboard.press('Escape');
  const late = await tryJoin(browser, 'Dan', shared);
  await expect(late.getByRole('alert')).toHaveText('This invite link was switched off. Ask the host for a new one.');
  // The two who are in stay in.
  await expect(host.locator('.avatars .avatar')).toHaveCount(2);
});

test('a link for one person is used up by the first, and says so to the second', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  const ben = await person(browser);
  await joinRoom(ben, 'Ben', link);
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);
  const late = await tryJoin(browser, 'Cleo', link);
  await expect(late.getByRole('alert')).toHaveText('This invite link was already used. Ask the host for a new one.');
  // Used up, it is no longer in the list of links that work.
  await host.getByTestId('room-pill').click();
  await expect(host.getByTestId('room-links')).toHaveCount(0);
});

test('a link with no limit lets people in until it is used up by time, and the room server counts', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  await startRoom(host, 'Mina');

  // From the room menu, with the same choices as in the dialog.
  await host.getByTestId('room-pill').click();
  const menu = host.locator('.roommenu');
  await menu.getByText('Link options').click();
  await menu.getByLabel('Stops working after').selectOption({ label: '7 days' });
  await menu.getByLabel('Works for').selectOption({ label: 'No limit' });
  await expect(menu.getByTestId('link-uses-help')).toHaveText('Anyone who has the link can join until it expires.');
  await menu.getByLabel('Note for your own list').fill('for Sam');
  await menu.getByRole('button', { name: 'New invite link' }).click();
  await expect(host.getByTestId('room-links')).toContainText('for Sam · no limit · 7 days left');
  const open = await host.evaluate(async () => (await window.__w.session.listInvites()).find((i: { label: string }) => i.label === 'for Sam').link as string);
  await host.keyboard.press('Escape');

  for (const name of ['Ben', 'Cleo']) await joinRoom(await person(browser), name, open);
  await expect(host.locator('.avatars .avatar')).toHaveCount(2);
  await host.getByTestId('room-pill').click();
  await expect(host.getByTestId('room-links')).toContainText('for Sam · no limit, 2 joined · 7 days left');

  // The count and the time are the room server's: the app only shows them.
  const kept = await host.evaluate(async () => (await window.__w.session.listInvites()).find((i: { label: string }) => i.label === 'for Sam'));
  expect(kept.maxUses).toBe(0);
  expect(kept.uses).toBe(2);
  expect(kept.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  expect(kept.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000 + 5000);
});

test('a link of a view-through-host room is always for one person', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  await startAndStay(host, 'Mina', 'View through my computer');
  const dialog = host.getByRole('dialog');
  await dialog.getByText('Link options').click();
  await expect(dialog.getByLabel('Works for')).toHaveCount(0);
  await expect(dialog.getByTestId('link-options')).toContainText('In this kind of room each link works for one person.');
  await dialog.getByLabel('Stops working after').selectOption({ label: '1 hour' });
  await dialog.getByRole('button', { name: 'Link for another person' }).click();
  await expect(dialog.getByTestId('room-link-rule')).toContainText('Each link works for one person and stops working after 1 hour.');
  const link = await linkOn(host);
  await host.keyboard.press('Escape');

  const ben = await person(browser);
  await joinRoom(ben, 'Ben', link);
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);
  const late = await tryJoin(browser, 'Cleo', link);
  await expect(late.getByRole('alert')).toHaveText('This invite link was already used. Ask the host for a new one.');
});

/* ───────────────────────── roles ───────────────────────── */

const role = (host: Page, name: string) => host.getByRole('combobox', { name: `What ${name} can do` });
const brush = (page: Page) => page.getByRole('radio', { name: 'Brush', exact: true });

test('the host changes someone to view only and back, and it holds at once', async ({ browser }) => {
  const host = await person(browser);
  const ben = await person(browser);
  const cleo = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(ben, 'Ben', link);
  await joinRoom(cleo, 'Cleo', await host.evaluate(() => window.__w.session.createInvite()));
  await expect(host.locator('.avatars .avatar')).toHaveCount(2);
  await expect(ben.locator('.segrow')).toHaveCount(2);
  await expect(cleo.locator('.segrow')).toHaveCount(2);

  // Ben edits like anyone.
  await ben.keyboard.press('b');
  await drag(ben, 'axial', [-60, 40], [-20, 70]);
  const start = await maskVoxels(ben);
  await expect.poll(() => maskVoxels(host)).toBe(start);

  await host.getByTestId('room-pill').click();
  await expect(role(host, 'Ben')).toHaveValue('editor');
  await expect(role(host, 'Ben').locator('option')).toHaveText(['Can edit', 'Can view']);
  await role(host, 'Ben').selectOption({ label: 'Can view' });
  await expect(host.locator('.toast').filter({ hasText: 'Ben can view only now.' })).toBeVisible();
  await expect(role(host, 'Ben')).toHaveValue('viewer');
  await host.keyboard.press('Escape');

  // Ben is told, his edit tools are off with the reason, and the tool in his hand is put down.
  await expect(ben.locator('.toast').filter({ hasText: 'Mina changed you to view only.' })).toBeVisible();
  await expect(brush(ben)).toHaveAttribute('aria-disabled', 'true');
  await expect(brush(ben)).toHaveAttribute('data-tip', 'You can view this room but not edit it. The host can change that.');
  await expect(ben.getByRole('radio', { name: 'Crosshair' })).toHaveAttribute('aria-checked', 'true');
  await ben.keyboard.press('b');
  await expect(ben.locator('.toast').filter({ hasText: 'You can view this room but not edit it. The host can change that.' })).toBeVisible();
  await drag(ben, 'axial', [30, -20], [70, -10]);
  await ben.keyboard.press('Control+z');
  await ben.getByRole('button', { name: 'Add segment' }).click();
  await expect(ben.locator('.segrow')).toHaveCount(2);
  expect(await maskVoxels(ben)).toBe(start);
  // In his own menu, and in Cleo's, it says what he is.
  await ben.getByTestId('room-pill').click();
  await expect(ben.locator('.roommenu')).toContainText('You · view only');
  await ben.keyboard.press('Escape');
  await cleo.getByTestId('room-pill').click();
  await expect(cleo.getByTestId('room-person').filter({ hasText: 'Ben' })).toContainText('View only');
  await cleo.keyboard.press('Escape');

  // He still sees what the others do.
  await cleo.keyboard.press('2');
  await cleo.keyboard.press('b');
  await drag(cleo, 'axial', [-60, -80], [-20, -70]);
  const more = await maskVoxels(cleo);
  expect(more).toBeGreaterThan(start);
  await expect.poll(() => maskVoxels(ben)).toBe(more);
  await expect.poll(() => maskVoxels(host)).toBe(more);

  // And back.
  await host.getByTestId('room-pill').click();
  await role(host, 'Ben').selectOption({ label: 'Can edit' });
  await host.keyboard.press('Escape');
  await expect(ben.locator('.toast').filter({ hasText: 'Mina changed you back to editing.' })).toBeVisible();
  await expect(brush(ben)).toHaveAttribute('aria-disabled', 'false');
  await ben.keyboard.press('b');
  await drag(ben, 'axial', [30, -20], [70, -10]);
  const after = await maskVoxels(ben);
  expect(after).not.toBe(more);
  await expect.poll(() => maskVoxels(host)).toBe(after);
  await expect.poll(() => maskVoxels(cleo)).toBe(after);
  expect(await maskDump(ben)).toBe(await maskDump(host));
});

test('strokes of a new viewer that the room has not taken leave their screen', async ({ browser }) => {
  const host = await person(browser);
  const ben = await person(browser);
  await openPhantom(host);
  await joinRoom(ben, 'Ben', await startRoom(host, 'Mina'));
  await expect(ben.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);
  const start = await maskVoxels(host);

  // Ben's edits stop reaching the room server, as if they were still on their way.
  await ben.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      const bytes = data instanceof Uint8Array ? data : null;
      // Frame kinds 1 and 2 are edits; everything else goes through.
      if (bytes && (bytes[1] === 1 || bytes[1] === 2)) return;
      send.call(this, data);
    };
  });
  await ben.keyboard.press('b');
  await drag(ben, 'axial', [-60, 40], [-20, 70]);
  expect(await maskVoxels(ben)).toBeGreaterThan(start);
  expect(await maskVoxels(host)).toBe(start);

  await host.getByTestId('room-pill').click();
  await role(host, 'Ben').selectOption({ label: 'Can view' });
  await host.keyboard.press('Escape');
  await expect(ben.locator('.toast').filter({ hasText: 'Mina changed you to view only.' })).toBeVisible();
  // What the room never took is gone from his screen: he sees what everyone has.
  await expect.poll(() => maskVoxels(ben)).toBe(start);
  expect(await maskDump(ben)).toBe(await maskDump(host));
});

test('a guest of a view-through-host room can be changed to view only', async ({ browser }) => {
  const host = await person(browser);
  const ben = await person(browser);
  await openPhantom(host);
  await joinRoom(ben, 'Ben', await startRoom(host, 'Mina', 'View through my computer'));
  await expect(ben.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);

  await ben.keyboard.press('b');
  await drag(ben, 'axial', [-60, 40], [-20, 70]);
  const start = await maskVoxels(host);
  await expect.poll(() => maskVoxels(host)).toBeGreaterThan(0);

  await host.getByTestId('room-pill').click();
  await role(host, 'Ben').selectOption({ label: 'Can view' });
  await host.keyboard.press('Escape');
  await expect(ben.locator('.toast').filter({ hasText: 'Mina changed you to view only.' })).toBeVisible();
  await expect(brush(ben)).toHaveAttribute('aria-disabled', 'true');
  const settled = await maskVoxels(host);
  await drag(ben, 'axial', [30, -20], [70, -10]);
  await ben.keyboard.press('b');
  await drag(ben, 'axial', [30, -20], [70, -10]);
  expect(await maskVoxels(host)).toBe(settled);
  expect(settled).toBeGreaterThanOrEqual(start);

  // The host's strokes still arrive.
  await host.keyboard.press('2');
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  const more = await maskVoxels(host);
  expect(more).toBeGreaterThan(settled);
  await expect.poll(async () => (await ben.evaluate(() => (window.__w.session.getMask().data as Uint8Array).reduce((n, v) => n + (v === 2 ? 1 : 0), 0))) > 0).toBe(true);
});

test('someone on an older app is not offered a change they would not be told of', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  // A client that says nothing about what it can do, as an app from before this did.
  const bot = await botJoin(link, 'Old Ben');
  await expect(host.locator('.avatars .avatar')).toHaveCount(1);
  await host.getByTestId('room-pill').click();
  await expect(role(host, 'Old Ben')).toBeDisabled();
  await expect(host.getByTestId('room-person').locator('.rolebox')).toHaveAttribute('data-tip', 'Old Ben needs a newer W Annotator before this can be changed.');
  // Removing them still works.
  await expect(host.getByRole('button', { name: 'Remove Old Ben' })).toBeEnabled();
  await host.keyboard.press('Escape');

  // What holds a viewer to looking is the room server, whatever their app does: made a viewer
  // behind the menu's back, the old client's edit is refused and reaches nobody.
  const before = await maskDump(host);
  expect(await host.evaluate((id) => window.__w.session.setMemberRole(id, 'viewer'), bot.welcome.self.id)).toBe(true);
  // One run of four voxels set to segment 1, as a patch (`ROOMS-PROTOCOL.md` §18.2).
  const patch = new Uint8Array(4 + 8 + 4);
  const view = new DataView(patch.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 4, true);
  patch.fill(1, 12);
  bot.send(KIND.patch, { c: 1, s: 'oldclient' }, patch, { seq: 1 });
  await expect.poll(() => bot.texts.some((m) => m.t === 'error' && m.code === 'forbidden' && m.kind === KIND.patch)).toBe(true);
  expect(await maskDump(host)).toBe(before);
  bot.close();
});
