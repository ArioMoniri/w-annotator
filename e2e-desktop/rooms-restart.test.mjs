/**
 * A room hosted by the desktop app outlives the app (ROOMS.md task 2.4): the host closes
 * the app, opens it again with the same image and mask, reopens the room from "Rooms you
 * have joined", and a member comes back with the membership it had.
 * Linux and Windows only, like app.test.mjs; see README.md.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { drag, idle, launch, maskVoxels, openInWindow, store, until } from './driver.mjs';
import { count, writeFixtures } from './fixtures.mjs';
import { KIND, assemble, joinRoom } from './roombot.mjs';

const IDENTIFIER = 'com.wannotator.app';

describe('a room hosted by the app, across a restart of the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w-desktop-rooms-'));
  const fx = writeFixtures(join(dir, 'in'));
  // On Linux the app's data goes to a folder of this test's own, the same one for both launches.
  // Windows has no such switch for the app's files: there the app's real data folder is used, and
  // the room is deleted at the end. What the webview keeps (the app's list of rooms) gets a folder
  // of the test's own there too, so the second launch finds what the first one left.
  const dataHome = join(dir, 'data');
  const env = process.platform === 'win32' ? { WEBVIEW2_USER_DATA_FOLDER: join(dir, 'webview') } : { XDG_DATA_HOME: dataHome };
  const appData =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), IDENTIFIER)
      : join(dataHome, IDENTIFIER);
  const hostedFile = join(appData, 'rooms', 'hosted.json');
  const kept = () => (existsSync(hostedFile) ? JSON.parse(readFileSync(hostedFile, 'utf8')) : null);

  let app = null;
  const bots = [];
  after(async () => {
    for (const bot of bots) bot.close();
    await app?.quit();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the webview's files for a moment; the folder is in the system's temporary folder */
    }
  });

  const open = async () => {
    app = await launch({ env });
    await openInWindow(app.browser, [fx.imagePath, fx.maskPath]);
    await idle(app.browser);
    return app.browser;
  };
  const session = (browser, body, ...args) => browser.execute(`return (async (...a) => { const s = window.__w.session; ${body} })(...arguments)`, ...args);
  const healthy = (host, port) => fetch(`http://${host}:${port}/health`).then((r) => r.ok, () => false);

  test('the host reopens the room and a member comes back with the membership it had', async () => {
    let browser = await open();

    /* ── the first run: start the room, let people in, make a link with a note ── */
    await (await browser.$('button*=Share')).click();
    await (await browser.$('input[placeholder="How others will see you"]')).setValue('Mina');
    await (await browser.$('form.form button[type="submit"]')).click();
    const linkBox = await browser.$('[data-testid="room-link"]');
    await linkBox.waitForExist({ timeout: 15_000 });
    const link = (await linkBox.getText()).trim();
    const parts = /^http:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)\/j\/([A-Z0-9]{12})#[A-Za-z0-9_-]{22}$/.exec(link);
    assert.ok(parts, `unexpected invite link ${link}`);
    const [, host, port, roomId] = parts;
    await (await browser.$('button=Done')).click();
    assert.equal(await store(browser, (s) => s.room.hosting && s.room.status), 'online');

    const ben = await joinRoom(link, 'Ben');
    bots.push(ben);
    assert.equal(ben.welcome.self.role, 'editor');
    // The host says, inside an encrypted frame, that the room runs on its own computer.
    const hi = await until(() => ben.frames.find((f) => f.kind === KIND.presence && f.meta.t === 'hi'), Boolean, { what: "the host's greeting" });
    assert.equal(hi.meta.hosted, true);

    // A link for five with a note, used once; and the host makes Cleo a viewer.
    const five = await session(browser, "return s.createInvite({ uses: 'five', duration: 'week', label: 'for the team' });");
    const cleo = await joinRoom(five, 'Cleo');
    bots.push(cleo);
    assert.equal(await session(browser, "return s.setMemberRole(a[0], 'viewer');", cleo.welcome.self.id), true);
    await until(() => store(browser, (s) => s.peers.length), (n) => n === 2, { what: 'both members to show' });
    const voxels = await maskVoxels(browser);

    // What the room server needs is in a file of the app's own, for this user only, and holds nothing of the image.
    const file = await until(kept, (f) => f?.relay.rooms[0]?.members.length === 2 && f.relay.rooms[0].invites.some((i) => i.uses === 1 && i.maxUses === 5), {
      what: `the room to be kept in ${hostedFile}`,
    });
    assert.equal(file.format, 1);
    assert.equal(file.port, Number(port));
    assert.equal(file.relay.version, 1);
    assert.equal(file.relay.rooms[0].id, roomId);
    assert.equal(file.relay.rooms[0].type, 'shared');
    assert.deepEqual(file.relay.rooms[0].members.map((m) => m.role).sort(), ['editor', 'viewer']);
    const text = readFileSync(hostedFile, 'utf8');
    for (const word of ['Mina', 'Ben', 'Cleo', 'for the team', 'phantom']) assert.ok(!text.includes(word), `the file names "${word}"`);
    if (process.platform !== 'win32') {
      assert.equal(statSync(hostedFile).mode & 0o777, 0o600);
      assert.equal(statSync(join(appData, 'rooms')).mode & 0o777, 0o700);
    }

    /* ── the app is closed: the room is down, and its members are told nothing false ── */
    await app.quit();
    app = null;
    await until(() => healthy(host, port), (up) => !up, { what: 'the room server to stop with the app' });
    await until(() => ben.closed, Boolean, { what: 'the member to notice' });
    assert.notEqual(ben.closed.code, 4410, 'the room was not deleted');
    // Nobody can come in while it is down.
    await assert.rejects(joinRoom(link, 'Ben', ben.member));

    /* ── the second run: same image and mask, the room is opened again ── */
    browser = await open();
    assert.equal(await store(browser, (s) => s.room), null);
    assert.equal(await healthy(host, port), false, 'nothing is hosted until the host opens the room');
    await (await browser.$('button*=Share')).click();
    await (await browser.$('[role="tab"]=Join a room')).click();
    const mine = await browser.$('[data-testid="my-rooms"]');
    await mine.waitForExist({ timeout: 5_000 });
    assert.match(await mine.getText(), /Your room/);
    await (await mine.$('button=Reopen')).click();
    await until(() => store(browser, (s) => s.room && s.room.hosting && s.room.status), (st) => st === 'online', { what: 'the room to be open again' });
    assert.equal(await store(browser, (s) => s.room.id), roomId);
    assert.equal(await store(browser, (s) => s.room.role), 'host');
    // On the same address as before, so the links people have still point at it.
    assert.equal(await healthy(host, port), true);

    // Ben comes back with the key he had: no new link, the same role, and the host sees him.
    const back = await joinRoom(link, 'Ben', ben.member);
    bots.push(back);
    assert.equal(back.welcome.self.id, ben.welcome.self.id);
    assert.equal(back.welcome.self.role, 'editor');
    assert.equal(back.welcome.roster.length, 3);
    assert.equal(back.welcome.roster.find((m) => m.id === cleo.welcome.self.id).role, 'viewer');
    // The room server kept the people and the links, not the edits: the order starts again.
    assert.equal(back.welcome.room.head, 0);
    await until(() => store(browser, (s) => s.peers.map((p) => p.name).join()), (names) => names === 'Ben', { what: 'Ben to show in the people list' });

    // The mask is the host's, as it was: a member who asks is sent it.
    const hostId = back.welcome.roster.find((m) => m.role === 'host').id;
    back.send(KIND.syncRequest, { rid: 9, image: false, fp: null }, undefined, { to: hostId });
    await until(() => back.frames.find((f) => f.kind === KIND.syncSlab && f.meta.rid === 9 && f.meta.t === 'end'), Boolean, { what: 'the mask from the host' });
    assert.equal(count(assemble(back.frames, KIND.syncSlab, 9)), voxels);

    // Edits flow again both ways, signed and in order, with the keys both sides kept: Ben's edit
    // reaches the host's mask, and a stroke of the host reaches Ben.
    const patch = new Uint8Array(4 + 8 + 4);
    const view = new DataView(patch.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(8, 4, true);
    patch.fill(1, 12);
    back.send(KIND.patch, { c: 1, s: 'back' }, patch, { seq: 1 });
    await until(() => browser.execute(() => Array.from(window.__w.session.getMask().data.subarray(0, 4)).join()), (v) => v === '1,1,1,1', { what: "Ben's edit to reach the host's mask" });
    const seen = back.frames.length;
    await browser.execute(() => window.__w.session.setTool('brush'));
    await drag(browser, 'axial', [-60, 40], [-20, 70]);
    const stroke = await until(() => back.frames.slice(seen).find((f) => f.kind === KIND.patch), Boolean, { what: "the host's stroke to reach Ben" });
    assert.equal(stroke.from, hostId);
    assert.ok(stroke.seq >= 2);
    // Nobody is told the room server delivered different edits: the order began again, and so did the count over it.
    assert.equal(await store(browser, (s) => s.room.note), null);
    assert.ok(!(await store(browser, (s) => s.toasts.map((t) => t.text).join(' | '))).includes('delivered different edits'));

    // The link for five still has the one use spent, and the host's note for it is still there.
    const links = await session(browser, 'return (await s.listInvites()).map((i) => ({ label: i.label, uses: i.uses, maxUses: i.maxUses, revoked: i.revoked }));');
    assert.deepEqual(links.find((i) => i.label === 'for the team'), { label: 'for the team', uses: 1, maxUses: 5, revoked: false });
    // The first link was used up before the restart, and still is.
    await assert.rejects(joinRoom(link, 'Dan'), /4408 invite already used/);

    // Reopening a room and keeping it needed nothing the content security policy refuses.
    assert.deepEqual(await browser.execute('return window.__w.blocked'), []);

    /* ── deleting the room removes what was kept of it ── */
    await (await browser.$('[data-testid="room-pill"]')).click();
    await (await browser.$('button=Delete room')).click();
    const ask = await browser.$('.modal');
    await ask.waitForDisplayed({ timeout: 5_000 });
    await (await ask.$('button=Delete room')).click();
    await until(() => store(browser, (s) => s.room), (r) => r === null, { what: 'the room to close' });
    await until(() => back.closed, Boolean, { what: 'the member to be told' });
    assert.equal(back.closed.code, 4410);
    // No member, key or link of the room is left in the file; only that this id was deleted, so a
    // member who comes back later is told so instead of waiting.
    const after = await until(kept, (f) => f === null || f.relay.rooms.length === 0, { what: 'the room to leave the file' });
    if (after) {
      assert.deepEqual(after.relay.tombstones.map((t) => [t.id, t.reason]), [[roomId, 'room deleted']]);
      assert.ok(!readFileSync(hostedFile, 'utf8').includes(file.relay.rooms[0].host));
    }
    assert.equal(await browser.execute(() => localStorage.getItem('w-annotator:rooms')), null);
  });
});
