/**
 * End-to-end tests of the built desktop app, driven through WebDriver.
 * Linux and Windows only; see README.md.
 *
 *   pnpm tauri build --debug --no-bundle
 *   xvfb-run -a pnpm e2e:desktop      (Linux)
 *   pnpm e2e:desktop                  (Windows)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { click, drag, idle, launch, maskVoxels, sleep, store, until } from './driver.mjs';
import { count, N, readNifti, writeFixtures } from './fixtures.mjs';

const TOOLS = ['crosshair', 'pan', 'zoom', 'window', 'measure', 'brush', 'eraser', 'threshold', 'scissors', 'fill'];

describe('with nothing open', () => {
  let app;
  before(async () => {
    app = await launch();
  });
  after(() => app?.quit());

  test('the app starts with its title and the empty state', async () => {
    const { browser } = app;
    assert.equal(await browser.getTitle(), 'W Annotator');
    assert.equal(await (await browser.$('main.empty h1')).getText(), 'Drop an image and a mask');
    assert.ok(await (await browser.$('button=Open image')).isDisplayed());
    assert.ok(await (await browser.$('button=Join a room')).isDisplayed());
    assert.equal(await (await browser.$('.topbar .brand')).getText(), 'W Annotator');
    assert.equal(await store(browser, (s) => s.image), null);
  });
});

describe('with an image and a mask from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w-desktop-e2e-'));
  const saveDir = join(dir, 'saved');
  const fx = writeFixtures(join(dir, 'in'));
  writeFixtures(saveDir); // creates the folder; the app must replace the mask in it
  let app;
  let browser;

  before(async () => {
    app = await launch({ args: [fx.imagePath, fx.maskPath], env: { W_E2E_SAVE_DIR: saveDir } });
    browser = app.browser;
    await idle(browser);
  });
  after(async () => {
    await app?.quit();
    rmSync(dir, { recursive: true, force: true });
  });

  const tool = () => store(browser, (s) => s.tool);
  const pick = async (id) => {
    await (await browser.$(`[data-tool="${id}"]`)).click();
    await until(tool, (t) => t === id, { what: `the ${id} tool` });
  };
  const press = (label) => browser.$(`button[aria-label="${label}"]`).then((b) => b.click());
  const undo = async () => (await press('Undo'), sleep(400));
  const redo = async () => (await press('Redo'), sleep(400));
  const rows = () => browser.$$('.segrow').length;
  const sliceDown = async (n) => {
    for (let i = 0; i < n; i++) await browser.keys(['ArrowDown']);
    await sleep(300);
  };

  test('both files open and both segments are listed', async () => {
    const title = await browser.execute(() => document.querySelector('.filebtn').textContent);
    assert.match(title, /phantom_ct\.mha/);
    assert.match(title, /phantom_seg\.nii\.gz/);
    assert.equal(await rows(), 2);
    assert.deepEqual(await store(browser, (s) => s.image.dims), [N, N, N]);
    // The mask is on the image grid, so the app holds exactly the voxels that were written.
    assert.equal(await maskVoxels(browser, 1), count(fx.mask, 1));
    assert.equal(await maskVoxels(browser, 2), count(fx.mask, 2));
    assert.ok(await (await browser.$('[data-view="axial"] canvas')).isDisplayed());
  });

  test('every tool on the rail can be selected', async () => {
    for (const id of TOOLS) {
      await pick(id);
      assert.equal(await (await browser.$(`[data-tool="${id}"]`)).getAttribute('aria-checked'), 'true');
      assert.equal(await (await browser.$('.strip')).getAttribute('data-strip'), id);
    }
    await browser.keys(['b']);
    assert.equal(await tool(), 'brush');
    await browser.keys(['c']);
    assert.equal(await tool(), 'crosshair');
  });

  test('the brush paints, and undo and redo restore the mask', async () => {
    const start = await maskVoxels(browser, 1);
    await pick('brush');
    await drag(browser, 'axial', [-60, 40], [-20, 70]);
    const painted = await maskVoxels(browser, 1);
    assert.ok(painted > start, `brush painted nothing (${start} to ${painted})`);
    await undo();
    assert.equal(await maskVoxels(browser, 1), start);
    await redo();
    assert.equal(await maskVoxels(browser, 1), painted);
    await undo();
  });

  test('the eraser removes voxels', async () => {
    const start = await maskVoxels(browser);
    await pick('eraser');
    await browser.keys([']']);
    await drag(browser, 'axial', [30, -20], [70, -10]);
    const erased = await maskVoxels(browser);
    assert.ok(erased < start, `eraser removed nothing (${start} to ${erased})`);
    await undo();
    assert.equal(await maskVoxels(browser), start);
  });

  test('the threshold brush paints only inside the range', async () => {
    await pick('threshold');
    await browser.execute(() => {
      window.__before = window.__w.session.getMask().data.slice();
      window.__w.session.setToolOption({ threshold: [200, 400] });
    });
    await browser.keys([']']);
    await browser.keys([']']);
    await drag(browser, 'axial', [-150, 60], [150, 60]);
    const result = await browser.execute(() => {
      const image = window.__w.session.getImage().data;
      const mask = window.__w.session.getMask().data;
      let painted = 0;
      let outside = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || window.__before[i]) continue;
        painted++;
        if (image[i] < 200 || image[i] > 400) outside++;
      }
      return { painted, outside };
    });
    assert.ok(result.painted > 0, 'threshold brush painted nothing');
    assert.equal(result.outside, 0);
    await undo();
  });

  test('scissors erase inside a rectangle', async () => {
    const start = await maskVoxels(browser);
    await pick('scissors');
    assert.deepEqual(await store(browser, (s) => [s.scissorsShape, s.scissorsAction]), ['rectangle', 'erase']);
    await drag(browser, 'axial', [-140, -140], [140, 140]);
    const cut = await maskVoxels(browser);
    assert.ok(cut < start, `scissors removed nothing (${start} to ${cut})`);
    await undo();
    assert.equal(await maskVoxels(browser), start);
  });

  test('fill floods an enclosed area and stops at its edge', async () => {
    // Move to a slice with no mask, draw a closed square outline, then click inside it.
    await pick('brush');
    await browser.execute(() => window.__w.session.setBrushSize(3));
    await click(browser, 'axial', [0, 0]);
    await undo();
    await sliceDown(12);
    const corners = [
      [-70, -70],
      [70, -70],
      [70, 70],
      [-70, 70],
    ];
    for (let i = 0; i < 4; i++) await drag(browser, 'axial', corners[i], corners[(i + 1) % 4]);
    const outline = await maskVoxels(browser, 1);
    await pick('fill');
    await click(browser, 'axial', [0, 0]);
    const filled = await maskVoxels(browser, 1);
    const added = filled - outline;
    assert.ok(added > 20, `fill added ${added} voxels`);
    assert.ok(added < (N * N) / 2, `fill leaked out of the outline (${added} voxels)`);
    await undo();
    assert.equal(await maskVoxels(browser, 1), outline);
    for (let i = 0; i < 4; i++) await undo();
    await browser.execute(() => window.__w.session.setBrushSize(8));
  });

  test('fill between slices joins two painted slices', async () => {
    await pick('brush');
    await sliceDown(3);
    const start = await maskVoxels(browser, 1);
    await drag(browser, 'axial', [-20, 0], [20, 0]);
    const one = await maskVoxels(browser, 1);
    await sliceDown(4);
    await drag(browser, 'axial', [-20, 0], [20, 0]);
    const two = await maskVoxels(browser, 1);
    assert.ok(one > start && two > one);
    // Wait for the brush options, and say what the strip held if they never show.
    const strip = () => browser.execute(() => `${document.querySelector('.strip')?.getAttribute('data-strip')}: ${document.querySelector('.strip')?.textContent}`);
    await until(strip, (text) => text.includes('Fill between slices'), { what: 'the brush options' });
    await (await browser.$('.strip').$('button*=Fill between slices')).click();
    await sleep(500);
    const joined = await maskVoxels(browser, 1);
    assert.ok(joined - start > (two - start) * 1.5, `only ${joined - two} voxels were added between the slices`);
    await undo();
    assert.equal(await maskVoxels(browser, 1), two);
  });

  test('a segment can be added, renamed, hidden, locked and deleted', async () => {
    await (await browser.$('button[aria-label="Add segment"]')).click();
    await until(rows, (n) => n === 3, { what: 'the new segment' });
    const row = await browser.$('.segrow[data-segment="3"]');
    assert.equal(await row.getAttribute('aria-selected'), 'true');

    await row.moveTo();
    await (await row.$('button[aria-label="More for Segment 3"]')).click();
    await (await browser.$('.menu').$('button*=Rename')).click();
    const input = await browser.$('input[aria-label="Segment name"]');
    await input.waitForExist({ timeout: 5000 });
    // The field opens focused with the old name selected, so typing replaces it.
    await browser.keys([...'Liver']);
    await browser.keys(['Enter']);
    // textContent, because WebKit's driver leaves text that cannot be selected out of getText().
    await until(() => browser.execute(() => document.querySelector('.segrow[data-segment="3"] .name')?.textContent), (t) => t === 'Liver', { what: 'the new name' });
    assert.equal(await store(browser, (s) => s.segments.find((x) => x.index === 3).name), 'Liver');

    await pick('brush');
    await drag(browser, 'axial', [-40, -40], [40, -40]);
    const painted = await maskVoxels(browser, 3);
    assert.ok(painted > 0);

    await row.moveTo();
    await (await row.$('button[aria-label="Hide"]')).click();
    assert.equal(await row.getAttribute('data-hidden'), 'true');
    await (await row.$('button[aria-label="Show"]')).click();
    assert.equal(await row.getAttribute('data-hidden'), 'false');

    await (await row.$('button[aria-label="Lock"]')).click();
    assert.equal(await store(browser, (s) => s.segments.find((x) => x.index === 3).locked), true);
    await drag(browser, 'axial', [-40, 40], [40, 40]);
    assert.equal(await maskVoxels(browser, 3), painted, 'a locked segment was painted');
    await (await row.$('button[aria-label="Unlock"]')).click();

    await (await row.$('button[aria-label="More for Liver"]')).click();
    await (await browser.$('.menu button.item.danger')).click();
    await until(rows, (n) => n === 2, { what: 'the segment to go' });
    assert.equal(await maskVoxels(browser, 3), 0);
  });

  test('saving writes a NIfTI mask that holds the edited voxels', async () => {
    await (await browser.$('.filebtn')).click();
    const save = await browser.$('.menu').$('button*=Save mask');
    await save.click();
    await until(() => store(browser, (s) => s.dirty), (d) => d === false, { what: 'the save to finish' });
    assert.equal(await store(browser, (s) => s.maskName), 'phantom_seg.nii.gz');

    const saved = readNifti(join(saveDir, 'phantom_seg.nii.gz'));
    assert.equal(saved.gzipped, true);
    assert.equal(saved.headerSize, 348);
    assert.equal(saved.magic, 'n+1');
    assert.deepEqual(saved.dims, [N, N, N]);
    assert.deepEqual(saved.spacing, [1, 1, 1]);
    assert.equal(saved.datatype, 2);
    assert.equal(saved.bitpix, 8);
    assert.equal(saved.bytesAfterHeader, N * N * N);
    for (const label of [1, 2]) assert.equal(count(saved.data, label), await maskVoxels(browser, label));
    assert.equal(count(saved.data), await maskVoxels(browser));
    // The earlier tests left edits behind, so this is not the file the app was started with.
    assert.notEqual(count(saved.data, 1), count(fx.mask, 1));
    // The file given on the command line was not touched.
    assert.equal(count(readNifti(fx.maskPath).data, 1), count(fx.mask, 1));
  });

  test('Share hosts a room in the app and a second client can join it', async () => {
    await (await browser.$('button*=Share')).click();
    await (await browser.$('input[placeholder="How others will see you"]')).setValue('Mina');
    assert.equal(await store(browser, (s) => s.roomModal), 'start');
    await (await browser.$('form.form button[type="submit"]')).click();
    const linkBox = await browser.$('[data-testid="room-link"]');
    await linkBox.waitForExist({ timeout: 15_000 });
    const link = (await linkBox.getText()).trim();
    const parts = /^ws:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)\/r\/([A-Z0-9]{6})$/.exec(link);
    assert.ok(parts, `unexpected invite link ${link}`);
    const [, host, port] = parts;
    const note = await (await browser.$('[data-testid="room-note"]')).getText();
    // A machine with no network gets a loopback link, and the dialog says so.
    if (host === '127.0.0.1') assert.match(note, /only works on this computer/);
    else assert.match(note, /same network or VPN/);
    assert.equal(await store(browser, (s) => s.room.hosting && s.room.status), 'online');
    assert.equal(await (await fetch(`http://${host}:${port}/health`)).text(), 'ok');
    await (await browser.$('button=Done')).click();

    // A second person, played by a plain WebSocket client in this process.
    const texts = [];
    const frames = [];
    const ws = new WebSocket(`${link}?name=Bot`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev) => (typeof ev.data === 'string' ? texts.push(JSON.parse(ev.data)) : frames.push(new Uint8Array(ev.data))));
    const got = (t) => texts.find((m) => m.t === t);
    const welcome = await until(() => got('welcome'), Boolean, { what: 'the welcome message' });
    assert.equal(welcome.peers.length, 1);
    assert.equal(welcome.peers[0].name, 'Mina');
    const hostId = welcome.peers[0].id;

    const avatar = await browser.$('.avatars .avatar');
    await avatar.waitForExist({ timeout: 10_000 });
    assert.equal(await avatar.getText(), 'B');
    assert.equal(await avatar.getAttribute('title'), 'Bot');

    ws.send(JSON.stringify({ t: 'need-snapshot', to: hostId, imageToo: true }));
    const snapshot = await until(() => got('snapshot'), Boolean, { what: 'the snapshot announcement' });
    assert.equal(snapshot.from, hostId);
    assert.equal(snapshot.to, welcome.id);
    assert.deepEqual(snapshot.mask.dims, [N, N, N]);
    assert.deepEqual(snapshot.image.dims, [N, N, N]);
    assert.equal(snapshot.segments.length, 2);
    assert.equal(snapshot.total, snapshot.image.bytes + snapshot.mask.bytes);
    // Frames: u32 sender, u8 kind (2 = snapshot), payload.
    const received = () => frames.filter((f) => f[4] === 2).reduce((n, f) => n + f.length - 5, 0);
    await until(received, (n) => n >= snapshot.total, { what: 'the snapshot data' });
    assert.equal(received(), snapshot.total);
    const payload = Buffer.concat(frames.filter((f) => f[4] === 2).map((f) => f.subarray(5)));
    assert.equal(new DataView(frames[0].buffer).getUint32(0, true), hostId);
    const mask = gunzipSync(payload.subarray(snapshot.image.bytes));
    assert.equal(mask.length, N * N * N);
    assert.equal(count(mask), await maskVoxels(browser));
    assert.equal(gunzipSync(payload.subarray(0, snapshot.image.bytes)).length, N * N * N * 2);

    // A stroke in the app reaches the guest as a patch frame (kind 1).
    await pick('brush');
    await drag(browser, 'axial', [-60, 40], [-20, 70]);
    await until(() => frames.some((f) => f[4] === 1), Boolean, { what: 'the stroke to reach the guest' });

    ws.close();
    await until(() => browser.$$('.avatars .avatar').length, (n) => n === 0, { what: 'the avatar to disappear' });
    assert.deepEqual(await store(browser, (s) => s.peers), []);

    await (await browser.$('[data-testid="room-pill"]')).click();
    await (await browser.$('button=Leave room')).click();
    await until(() => store(browser, (s) => s.room), (r) => r === null, { what: 'the room to close' });
    // Leaving stops the relay.
    await until(() => fetch(`http://${host}:${port}/health`).then(() => false, () => true), Boolean, { what: 'hosting to stop' });
  });
});
