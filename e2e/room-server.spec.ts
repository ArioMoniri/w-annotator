import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { assemble, joinRoom as botJoin, KIND } from '../e2e-desktop/roombot.mjs';
import { cuttable, drag, joinRoom, maskDump, maskVoxels, openPhantom, reconnectNow, startRoom } from './helpers';

/**
 * These tests run their own room server, so they can stop and start it. The suite's
 * shared one (playwright.config.ts) is left alone.
 */
const PORT = Number(process.env.W_RELAY_PORT ?? 8787) + 7;
const BINARY = join(process.cwd(), 'target', 'debug', process.platform === 'win32' ? 'w-relay.exe' : 'w-relay');

let relay: ChildProcess | null = null;

async function startRelay(): Promise<void> {
  // The config's web server step has already built it with `cargo run`.
  if (!existsSync(BINARY)) throw new Error(`No relay binary at ${BINARY}. Run "cargo build -p w-relay" first.`);
  relay = spawn(BINARY, ['--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  await expect.poll(() => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
}

async function stopRelay(): Promise<void> {
  const child = relay;
  relay = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

test.beforeEach(startRelay);
test.afterEach(stopRelay);

/** A page whose Settings name this test's room server. */
async function hostPage(browser: import('@playwright/test').Browser) {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript((port) => {
    localStorage.setItem('w-annotator:settings', JSON.stringify({ tourSeen: true, server: `ws://127.0.0.1:${port}` }));
  }, PORT);
  return page;
}

test('a shared-copy room comes back after the room server restarts, and nothing is lost', async ({ browser }) => {
  const host = await hostPage(browser);
  const guest = await (await browser.newContext()).newPage();
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  expect(link).toContain(`:${PORT}/j/`);
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatar')).toHaveCount(1);

  // The server goes away and forgets everything: rooms, members, links.
  await stopRelay();
  await expect(host.getByTestId('sync')).toContainText('Offline');
  await expect(guest.getByTestId('sync')).toContainText('Offline');

  // Both keep working on their copies.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, -80], [-20, -70]);
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  const hosts = await maskDump(host);
  const guests2 = await maskVoxels(guest, 2);

  await startRelay();
  // The host opens the room again under the same id, with the same members and no new links.
  await reconnectNow(host);
  await expect(host.getByTestId('sync')).toContainText('Synced', { timeout: 40_000 });
  await reconnectNow(guest);
  await expect(guest.getByTestId('sync')).toContainText('Synced', { timeout: 40_000 });
  await expect(host.locator('.avatar')).toHaveCount(1);

  // There is no shared starting point any more, so the host's mask is the room's and
  // every voxel the guest has differently is kept for them to decide.
  await expect(guest.getByTestId('merge-review')).toContainText("Your version differs from the room's", { timeout: 20_000 });
  expect(await maskDump(guest)).toBe(hosts);
  expect(await maskDump(host)).toBe(hosts);
  await guest.getByRole('button', { name: 'Use mine' }).click();
  expect(await maskVoxels(guest, 2)).toBe(guests2);
  await expect.poll(async () => (await maskDump(host)) === (await maskDump(guest))).toBe(true);
  expect(await maskVoxels(host, 2)).toBe(guests2);

  // Edits flow again.
  const before = await maskVoxels(guest);
  await drag(host, 'axial', [30, -20], [70, -10]);
  await expect.poll(() => maskVoxels(guest)).toBeGreaterThan(before);
});

test('while the room server does not know the room, a member is told they are waiting for the host', async ({ browser }) => {
  const host = await hostPage(browser);
  const guest = await (await browser.newContext()).newPage();
  // The host's own connection is under the test's control, to keep the host away for a while.
  const hostWire = await cuttable(host);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  await joinRoom(guest, 'Ario', link);
  await expect(guest.locator('.segrow')).toHaveCount(2);
  await expect(host.locator('.avatar')).toHaveCount(1);

  // The room server restarts and has forgotten the room; the host is not back yet.
  await hostWire.cut();
  await stopRelay();
  await expect(guest.getByTestId('sync')).toContainText('Offline');
  await startRelay();
  await reconnectNow(guest);
  await guest.getByTestId('room-pill').click();
  await expect(guest.locator('.roommenu .note').filter({ hasText: 'Waiting' })).toHaveText('Waiting for the host to reopen the room.', { timeout: 20_000 });
  await guest.keyboard.press('Escape');
  // The member is still in the room and keeps working on their copy.
  await expect(guest.getByTestId('room-pill')).toContainText('Offline');
  await guest.keyboard.press('2');
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [-60, 40], [-20, 70]);
  const guests2 = await maskVoxels(guest, 2);

  // The host is back and opens the room again; the member comes in with the membership it had.
  hostWire.restore();
  await reconnectNow(host);
  await expect(host.getByTestId('sync')).toContainText('Synced', { timeout: 40_000 });
  await reconnectNow(guest);
  await expect(guest.getByTestId('sync')).toContainText('Synced', { timeout: 40_000 });
  await expect(host.locator('.avatar')).toHaveCount(1);
  await guest.getByTestId('room-pill').click();
  await expect(guest.locator('.roommenu')).not.toContainText('Waiting for the host');
  await guest.keyboard.press('Escape');
  // Their offline stroke is not lost: it is kept for them to decide, and "Use mine" gives it to the room.
  await guest.getByRole('button', { name: 'Use mine', exact: true }).click();
  await expect.poll(() => maskVoxels(host, 2)).toBe(guests2);
});

test('a client written apart from the app can join with a link and is sent what a member gets', async ({ browser }) => {
  const host = await hostPage(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');

  const bot = await botJoin(link, 'Bot');
  expect(bot.welcome.room.type).toBe('shared');
  expect(bot.welcome.self.role).toBe('editor');
  expect(bot.welcome.roster).toHaveLength(2);
  const hostId = bot.welcome.roster.find((m) => m.role === 'host')!.id;
  // What the relay itself said never contains a name.
  expect(JSON.stringify(bot.texts)).not.toContain('Mina');
  // The app shows the newcomer by the name it sent in an encrypted frame, and says its own the same way.
  await expect(host.locator('.avatars .avatar')).toHaveAttribute('title', 'Bot');
  await expect.poll(() => bot.frames.find((f) => f.kind === KIND.presence && f.meta.t === 'hi')?.meta.name).toBe('Mina');

  // The image and the mask, as slabs, with nothing that names a file.
  bot.send(KIND.syncRequest, { rid: 7, image: true, fp: null }, undefined, { to: hostId });
  const got = (t: string) => bot.frames.find((f) => f.kind === KIND.syncSlab && f.meta.rid === 7 && f.meta.t === t);
  await expect.poll(() => !!got('end')).toBe(true);
  const begin = got('begin')!;
  expect(begin.meta.dims).toEqual([48, 48, 48]);
  expect(Object.keys(begin.meta.image).sort()).toEqual(['dims', 'direction', 'dtype', 'origin', 'spacing']);
  expect(begin.meta.segments).toHaveLength(2);
  const mask = assemble(bot.frames, KIND.syncSlab, 7);
  expect(mask.length).toBe(48 * 48 * 48);
  expect(mask.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)).toBe(await maskVoxels(host));
  expect(assemble(bot.frames, KIND.imageSlab, 7).length).toBe(48 * 48 * 48 * 2);

  // A stroke in the app arrives as a patch with its place in the room's order.
  const seen = bot.frames.length;
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => bot.frames.slice(seen).find((f) => f.kind === KIND.patch)?.seq ?? 0).toBeGreaterThanOrEqual(1);

  // The link is spent.
  await expect(botJoin(link, 'Again')).rejects.toThrow(/4408 invite already used/);
  bot.close();
  await expect(host.locator('.avatars .avatar')).toHaveCount(0);
});
