import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { joinRoom as botJoin, KIND } from '../e2e-desktop/roombot.mjs';
import { anotherLink, drag, joinRoom, maskDump, maskVoxels, openPhantom, startRoom } from './helpers';

/**
 * What someone in a room, or whoever runs the room server, can try against the others.
 * The findings these tests come from are in docs/reviews/rooms-security.md.
 */

const opened: import('@playwright/test').BrowserContext[] = [];

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  return context.newPage();
}

// Each person's window is closed when the test is over. Left open, they pile up through the
// file, and the later tests share the machine with dozens of idle pages.
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

const maskAt = (page: Page, index: number) =>
  page.evaluate((i) => (window.__w.session.getMask().data as Uint8Array)[i], index);

/** `u32 n`, then `(u32 start, u32 length)` per run, then the values: a patch as it travels. */
function patchBytes(runs: [start: number, length: number][], value: number): Uint8Array {
  const total = runs.reduce((n, r) => n + r[1], 0);
  const out = new Uint8Array(4 + runs.length * 8 + total);
  const view = new DataView(out.buffer);
  view.setUint32(0, runs.length, true);
  runs.forEach(([start, length], i) => {
    view.setUint32(4 + i * 8, start, true);
    view.setUint32(8 + i * 8, length, true);
  });
  out.fill(value, 4 + runs.length * 8);
  return out;
}

/* ───────────────────────── a member who means harm ───────────────────────── */

test('a patch that reaches outside the mask changes nothing, and a name cannot hide what it is', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const link = await startRoom(host, 'Mina');
  // A name with a mark that turns the rest of it around, and a bell character.
  const eve = await botJoin(link, 'Eve\u202Egro\u0007');
  await expect(host.locator('.avatar')).toHaveCount(1);
  await host.getByTestId('room-pill').click();
  const shown = await host.getByTestId('room-person').filter({ hasText: 'Eve' }).first().innerText();
  expect(shown).toContain('Evegro');
  expect(shown.replace(/\n/g, ' ')).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/);
  await host.keyboard.press('Escape');

  const before = await maskDump(host);
  expect(await maskAt(host, 0)).toBe(0);
  // The first run is fine; the second lies far outside a 48 x 48 x 48 mask.
  eve.send(KIND.patch, { c: 1 }, patchBytes([[0, 4], [0xfffffff0, 4]], 9), { seq: 1 });
  // An honest edit after it, so there is something to wait for.
  eve.send(KIND.patch, { c: 2 }, patchBytes([[10, 2]], 1), { seq: 2 });
  await expect.poll(() => maskAt(host, 10)).toBe(1);
  // Nothing of the bad patch was written: not even the run that would have fitted.
  expect(await maskAt(host, 0)).toBe(0);
  const after = await maskDump(host);
  expect(after.slice(0, 10) + after.slice(12)).toBe(before.slice(0, 10) + before.slice(12));
  // And the room goes on.
  await expect(host.getByTestId('room-pill')).toBeVisible();
  eve.close();
});

test('asking for the image over and over gets one transfer, not twenty', async ({ browser }) => {
  const host = await person(browser);
  await openPhantom(host);
  const eve = await botJoin(await startRoom(host, 'Mina'), 'Eve');
  await expect(host.locator('.avatar')).toHaveCount(1);
  const hostId = eve.welcome.roster.find((m) => m.role === 'host')!.id;
  for (let rid = 1; rid <= 20; rid++) eve.send(KIND.syncRequest, { rid, image: true, fp: null }, undefined, { to: hostId });
  await expect.poll(() => eve.frames.some((f) => f.kind === KIND.syncSlab && f.meta.t === 'end'), { timeout: 20_000 }).toBe(true);
  await host.waitForTimeout(1500);
  // Each new request replaced the one before it: only the last ran to its end.
  const ended = eve.frames.filter((f) => f.kind === KIND.syncSlab && f.meta.t === 'end');
  expect(ended.map((f) => f.meta.rid)).toEqual([20]);
  // The host was not slowed into losing its connection.
  await expect(host.getByTestId('sync')).not.toContainText('Offline');
  eve.close();
});

/* ───────────────────────── a room server that means harm ───────────────────────── */

interface Tamper {
  /** Sends the first patch the page received once more, as the newest edit of the room. */
  replayFirstPatch(): void;
  /** Keeps the next edit from the page, and numbers the ones after it so that nothing seems to be missing. */
  dropNextPatch(): void;
  hostId: number;
}

/**
 * Stands between a page and the room server, as the server's operator does. It can send an
 * old edit again under a new number, and it can stamp one member's frame with another's id.
 */
async function tamper(page: Page, opts: { relabelToHost?: boolean } = {}): Promise<Tamper> {
  const control: Tamper = { replayFirstPatch: () => undefined, dropNextPatch: () => undefined, hostId: 0 };
  await page.routeWebSocket(/\/v2\/rooms\//, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    let shift = 0;
    let last = 0;
    let first: Buffer | null = null;
    let drop = false;
    control.dropNextPatch = () => {
      drop = true;
    };
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string') {
        const msg = JSON.parse(m);
        if (msg.t === 'welcome') control.hostId = msg.roster.find((p: { role: string }) => p.role === 'host').id;
        if (msg.t === 'ack') {
          msg.seq += shift;
          last = msg.seq;
          ws.send(JSON.stringify(msg));
        } else ws.send(m);
        return;
      }
      const frame = Buffer.from(m);
      const kind = frame[1];
      if (kind === 1 && drop) {
        drop = false;
        shift--;
        return;
      }
      if (kind === 1 || kind === 2) {
        last = Number(frame.readBigUInt64LE(12)) + shift;
        frame.writeBigUInt64LE(BigInt(last), 12);
        if (kind === 1 && !first) first = Buffer.from(frame);
      }
      ws.send(frame);
      if (opts.relabelToHost && kind === 5 && frame.readUInt32LE(4) !== control.hostId) {
        // The same bytes again, but stamped as coming from the host.
        const forged = Buffer.from(frame);
        forged.writeUInt32LE(control.hostId, 4);
        ws.send(forged);
      }
    });
    control.replayFirstPatch = () => {
      if (!first) throw new Error('No patch seen yet');
      const again = Buffer.from(first);
      shift++;
      last++;
      again.writeBigUInt64LE(BigInt(last), 12);
      ws.send(again);
    };
  });
  return control;
}

test('an edit the room server sends a second time is not applied a second time', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const relay = await tamper(guest);
  await openPhantom(host);
  await joinRoom(guest, 'Ario', await startRoom(host, 'Mina'));
  await expect(guest.locator('.segrow')).toHaveCount(2);
  const start = await maskVoxels(host);

  // The host paints, then takes it back.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  const painted = await maskVoxels(host);
  expect(painted).toBeGreaterThan(start);
  await expect.poll(() => maskVoxels(guest)).toBe(painted);
  await host.keyboard.press('Control+z');
  await expect.poll(() => maskVoxels(host)).toBe(start);
  await expect.poll(() => maskVoxels(guest)).toBe(start);

  // The room server sends the stroke again, numbered as the room's newest edit.
  relay.replayFirstPatch();
  await guest.waitForTimeout(1000);
  // The repeat changed nothing.
  expect(await maskVoxels(guest)).toBe(start);
  expect(await maskDump(guest)).toBe(await maskDump(host));

  // And it does not go unnoticed. The guest was shown an edit the host never saw; the next thing
  // that passes between them shows the difference, and both stop taking edits from this room.
  await drag(host, 'axial', [30, -20], [70, -10]);
  for (const page of [guest, host]) {
    await expect(page.locator('.toast[data-kind="error"]').filter({ hasText: FORK })).toBeVisible({ timeout: 15_000 });
  }
});

const FORK = "This room's server delivered different edits to different people. Your copy is kept. Leave and start a new room.";

test('an edit the room server keeps from one person is noticed, and nobody loses their own work', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const relay = await tamper(guest);
  await openPhantom(host);
  await joinRoom(guest, 'Ario', await startRoom(host, 'Mina'));
  await expect(guest.locator('.segrow')).toHaveCount(2);
  const start = await maskVoxels(host);

  // An honest stroke first: nothing is said about a room that is in order.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  const first = await maskVoxels(host);
  expect(first).toBeGreaterThan(start);
  await expect.poll(() => maskVoxels(guest)).toBe(first);
  await guest.waitForTimeout(2500);
  await expect(guest.locator('.toast[data-kind="error"]')).toHaveCount(0);
  await expect(host.locator('.toast[data-kind="error"]')).toHaveCount(0);

  // The room server leaves the host's next stroke out for the guest and closes the gap in the numbering.
  relay.dropNextPatch();
  await drag(host, 'axial', [30, -20], [70, -10]);
  const second = await maskVoxels(host);
  expect(second).toBeGreaterThan(first);
  // Another stroke from the host reaches the guest under the number of the one that was kept back.
  await drag(host, 'axial', [-70, -60], [-40, -50]);
  for (const page of [guest, host]) {
    await expect(page.locator('.toast[data-kind="error"]').filter({ hasText: FORK })).toBeVisible({ timeout: 15_000 });
  }
  await guest.getByTestId('room-pill').click();
  await expect(guest.locator('.note')).toHaveText(FORK);
  await guest.keyboard.press('Escape');

  // Each keeps what they have. What the guest paints from here on stays the guest's.
  const hostHas = await maskVoxels(host);
  const guestHad = await maskVoxels(guest);
  await guest.keyboard.press('b');
  await drag(guest, 'axial', [50, 50], [80, 60]);
  expect(await maskVoxels(guest)).toBeGreaterThan(guestHad);
  await host.waitForTimeout(1000);
  expect(await maskVoxels(host)).toBe(hostHas);
});

test('what the host sends one person cannot be read by another, and a removed person reads nothing sent after', async ({ browser }) => {
  const host = await person(browser);
  // Whoever runs the room server sees every frame, and here hands them all to the wrong people.
  const leaked: { kind: number; to: number; bytes: Buffer }[] = [];
  await host.routeWebSocket(ROOM_SOCKET, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m !== 'string') {
        const bytes = Buffer.from(m);
        leaked.push({ kind: bytes[1], to: bytes.readUInt32LE(8), bytes });
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openPhantom(host);
  const ana = await botJoin(await startRoom(host, 'Mina'), 'Ana');
  const ben = await botJoin(await anotherLink(host), 'Ben');
  await expect(host.locator('.avatar')).toHaveCount(2);
  const hostId = ana.welcome.roster.find((m) => m.role === 'host')!.id;

  // Ana asks for the image. Every slab is for her alone.
  ana.send(KIND.syncRequest, { rid: 7, image: true, fp: null }, undefined, { to: hostId });
  await expect.poll(() => ana.frames.some((f) => f.kind === KIND.syncSlab && f.meta.rid === 7 && f.meta.t === 'end'), { timeout: 20_000 }).toBe(true);
  const slabs = leaked.filter((f) => (f.kind === KIND.syncSlab || f.kind === KIND.imageSlab) && f.to === ana.self);
  expect(slabs.length).toBeGreaterThan(3);
  expect(slabs.filter((f) => ben.canRead(f.bytes, hostId))).toEqual([]);
  // Nor the keys the host handed her.
  const keysForAna = leaked.filter((f) => f.kind === KIND.key && f.to === ana.self);
  expect(keysForAna.length).toBeGreaterThan(0);
  expect(keysForAna.filter((f) => ben.canRead(f.bytes, hostId))).toEqual([]);

  // While Ben is a member he reads the room's edits, as he should.
  await host.keyboard.press('b');
  await drag(host, 'axial', [-60, 40], [-20, 70]);
  await expect.poll(() => ben.frames.some((f) => f.kind === KIND.patch)).toBe(true);
  const before = leaked.filter((f) => f.kind === KIND.patch);
  expect(before.some((f) => ben.canRead(f.bytes, hostId))).toBe(true);

  // The host removes Ben. The room moves to a new key, which Ana is handed and Ben is not.
  const sent = leaked.length;
  await host.getByTestId('room-pill').click();
  await host.getByRole('button', { name: 'Remove Ben' }).click();
  await host.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(host.locator('.avatar')).toHaveCount(1);
  await expect.poll(() => ben.closed?.code).toBe(4403);
  await host.keyboard.press('b');
  const patches = ana.frames.filter((f) => f.kind === KIND.patch).length;
  await drag(host, 'axial', [30, -20], [70, -10]);
  await expect.poll(() => ana.frames.filter((f) => f.kind === KIND.patch).length).toBeGreaterThan(patches);
  const after = leaked.slice(sent).filter((f) => f.kind === KIND.patch);
  expect(after.length).toBeGreaterThan(0);
  // The frames carry the new epoch, Ana reads them, and Ben, who still holds the old key, reads none.
  expect(after.every((f) => f.bytes.readUInt32LE(20) === 2)).toBe(true);
  expect(after.filter((f) => ben.canRead(f.bytes, hostId))).toEqual([]);
  expect(after.every((f) => ana.canRead(f.bytes, hostId))).toBe(true);
  ana.close();
});

const ROOM_SOCKET = new RegExp('/v2/rooms/');

test('the room server cannot pass one member off as the host', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  const eve = await person(browser);
  await tamper(guest, { relabelToHost: true });
  await openPhantom(host);
  await joinRoom(guest, 'Ario', await startRoom(host, 'Mina'));
  await expect(guest.locator('.segrow')).toHaveCount(2);
  // Eve joins; everything she says about herself also reaches Ario stamped as the host's.
  await joinRoom(eve, 'Eve', await anotherLink(host));
  await expect(guest.locator('.avatar')).toHaveCount(2);
  await eve.mouse.move(400, 400);
  await eve.mouse.move(420, 420);
  await guest.waitForTimeout(1000);

  await guest.getByTestId('room-pill').click();
  const people = guest.getByTestId('room-person');
  await expect(people.filter({ hasText: 'Host' })).toContainText('Mina');
  await expect(people.filter({ hasText: 'Host' })).not.toContainText('Eve');
  await expect(people.filter({ hasText: 'Eve' })).toHaveCount(1);
});

test('a room server that calls a view-through-host room a shared copy is not believed', async ({ browser }) => {
  const host = await person(browser);
  const guest = await person(browser);
  let welcomes = 0;
  let cut: () => void = () => undefined;
  const fromHost: number[] = [];
  await host.routeWebSocket(/\/v2\/rooms\//, (ws) => {
    const server = ws.connectToServer();
    // The server's side stays open when the page's side is cut, as when a connection breaks.
    ws.onClose(() => undefined);
    ws.onMessage((m) => {
      if (typeof m !== 'string') fromHost.push(Buffer.from(m)[1]);
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"t":"welcome"') && ++welcomes > 1) {
        // From the second sign-in on, the server says the room is a shared copy.
        ws.send(m.replace('"type":"host-view"', '"type":"shared"'));
      } else ws.send(m);
    });
    cut = () => void ws.close();
  });
  await openPhantom(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await joinRoom(guest, 'Ario', link);
  await expect(host.locator('.avatar')).toHaveCount(1);

  cut();
  // The host leaves the room and says why, instead of carrying on as the host of a shared copy.
  await expect(host.locator('.toast[data-kind="error"]')).toContainText('does not fit this room', { timeout: 30_000 });
  await expect(host.getByTestId('room-pill')).toHaveCount(0);
  // Whatever the guest asks for now, no image or mask slab ever leaves the host.
  await host.waitForTimeout(1000);
  expect(fromHost.filter((kind) => kind === 3 || kind === 4)).toEqual([]);
});
