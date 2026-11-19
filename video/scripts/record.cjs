// usage: APP=http://localhost:1420/ DATA=<folder> node video/scripts/record.cjs   (needs the app and the relay running)
// Records a scripted session of the real app frame by frame (no real-time capture, so a slow machine does not matter).
// Output: JPEG frames for window A (host) and B (guest) and a manifest with, for every 30 fps output frame,
// which screenshot is on screen, where each cursor is, whether the button is down, the scene and the camera target.
const { chromium } = require('playwright'); const fs = require('fs');
const APP = process.env.APP || 'http://localhost:1420/';
// DATA must hold chest_ct.mha and lungs.nii.gz (see README.md for where they come from).
const DATA = process.env.DATA || __dirname + '/../out/data';
const OUT = process.env.OUT || __dirname + '/../out/rec';
const DSF = +(process.env.DSF || 1.5), UNTIL = process.env.UNTIL || '';
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const man = { fps: 30, w: 1440, h: 900, dsf: DSF, frames: [] };
let scene = 'open', dual = false;
const mk = () => ({ pg: null, x: 1010, y: 690, down: false, img: -1, n: 0, cam: [1, 720, 450] });
const win = { A: mk(), B: mk() };
const r1 = (v) => Math.round(v * 10) / 10;
const settle = async (pg, ms = 40) => { await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await pg.waitForTimeout(ms); };
async function snap(k) { const w = win[k]; await w.pg.screenshot({ path: `${OUT}/${k}${String(w.n).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 93 }); w.img = w.n++; }
async function frame(live = false) {
  if (live) { await snap('A'); if (dual) await snap('B'); }
  const A = win.A, B = win.B;
  man.frames.push({ s: scene, d: dual ? 1 : 0, a: A.img, ac: [r1(A.x), r1(A.y), A.down ? 1 : 0], az: A.cam.slice(), b: dual ? B.img : -1, bc: [r1(B.x), r1(B.y), B.down ? 1 : 0], bz: B.cam.slice() });
}
const hold = async (n, live = true) => { for (let i = 0; i < n; i++) await frame(live && i === 0); };
const cam = (k, z, cx, cy) => { win[k].cam = [z, cx, cy]; };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wait = (k) => settle(win[k].pg, dual ? 140 : 40);
async function move(k, x, y, n, live = 3) {
  const w = win[k]; const x0 = w.x, y0 = w.y, dx = x - x0, dy = y - y0, len = Math.hypot(dx, dy) || 1; const bow = Math.min(36, len * 0.07);
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n), s = Math.sin(Math.PI * e) * bow;
    w.x = x0 + dx * e - (dy / len) * s; w.y = y0 + dy * e + (dx / len) * s;
    await w.pg.mouse.move(w.x, w.y);
    const doSnap = live > 0 && (i % live === 0 || i === n); if (doSnap) await wait(k);
    await frame(doSnap);
  }
}
async function click(k, { count = 1, after = null, holdFrames = 6, raw = null } = {}) {
  const w = win[k]; w.down = true; await frame(false); await frame(false); await frame(false);
  if (raw) await raw(); else await w.pg.mouse.click(w.x, w.y, { clickCount: count });
  w.down = false; if (after) await after(); await settle(w.pg, 160); await hold(holdFrames);
}
async function stroke(k, pts, n, { shift = false } = {}) {
  const w = win[k]; const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  if (shift) await w.pg.keyboard.down('Shift');
  await w.pg.mouse.move(pts[0][0], pts[0][1]); await w.pg.mouse.down(); w.down = true; await wait(k); await frame(true);
  for (let i = 1; i <= n; i++) {
    let d = (0.5 - Math.cos(Math.PI * i / n) / 2) * total, j = 0; while (j < seg.length - 1 && d > seg[j]) d -= seg[j++];
    const f = Math.min(1, d / (seg[j] || 1)); w.x = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f; w.y = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
    await w.pg.mouse.move(w.x, w.y); await wait(k); await frame(true);
  }
  await w.pg.mouse.up(); w.down = false; if (shift) await w.pg.keyboard.up('Shift'); await settle(w.pg, 200); await hold(5);
}
async function wheel(k, steps, dir, framesPer = 2) { const w = win[k]; for (let i = 0; i < steps; i++) { await w.pg.mouse.wheel(0, dir * 100); await settle(w.pg, 90); await frame(true); for (let j = 1; j < framesPer; j++) await frame(false); } }
const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const box = (pg, v) => pg.locator(`[data-view="${v}"]`).boundingBox();
const P = (b, u, v) => { const s = Math.min(b.width, b.height); return [b.x + b.width / 2 + u * s, b.y + b.height / 2 + v * s]; };
const st = (pg) => pg.evaluate(() => { const s = window.__w.store.getState(); return { slices: s.slices, toasts: s.toasts.map(t => t.kind + ':' + t.message), segs: s.segments.map(x => x.index + ':' + x.name + (x.locked ? ':L' : '') + (x.visible ? '' : ':H')), active: s.activeSegment, tool: s.tool, room: s.room && s.room.status, peers: s.peers.length, hover: s.hover }; });
const hoverSeg = async (pg, x, y) => { await pg.mouse.move(x, y); await pg.waitForTimeout(45); return pg.evaluate(() => { const h = window.__w.store.getState().hover; return h ? h.segment : -1; }); };
// first point going outward along +u where the segment under the cursor stops being `seg`
async function edge(pg, b, v, u0, u1, seg) { let inside = false; for (let u = u0; u <= u1; u += 0.008) { const s = await hoverSeg(pg, ...P(b, u, v)); if (s === seg) inside = true; else if (inside) return u; } return null; }
const idle = (p) => p.waitForFunction(() => window.__w.store.getState().busy === null, null, { timeout: 240000 });
async function newPage(br) { const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DSF, acceptDownloads: true, colorScheme: 'dark' }); const p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERR', e.message)); await p.goto(APP); await p.waitForFunction(() => '__w' in window); return p; }
// Click the real control; if the browser's file chooser does not come up (it sometimes does not on a loaded machine), hand the same file to the app directly.
const pick = (pg, k, file, role) => async () => {
  const p = pg.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null); await pg.mouse.click(win[k].x, win[k].y); const c = await p;
  if (c) { await c.setFiles(file); return; }
  console.log('no file chooser for', role, '- using session.openFiles'); await pg.keyboard.press('Escape');
  await pg.route('**/__data/*', (route) => route.fulfill({ path: file }));
  await pg.evaluate(async ({ name, role }) => { const bytes = new Uint8Array(await (await fetch('/__data/' + name)).arrayBuffer()); await window.__w.session.openFiles([{ name, bytes }], role); }, { name: file.split('/').pop(), role });
  await pg.unroute('**/__data/*');
};
const log = (...a) => console.log(`[${man.frames.length}]`, ...a);
const done = (name) => { if (UNTIL === name) throw new Error('STOP'); };

(async () => {
  const br = await chromium.launch({ args });
  const A = win.A.pg = await newPage(br); const pg = A;
  try {
    // ── 1. open image and mask ──
    scene = 'open'; await hold(14);
    await move('A', ...(await center(A.getByRole('button', { name: 'Open image', exact: true }))), 26);
    await click('A', { holdFrames: 26, raw: pick(A, 'A', DATA + '/chest_ct.mha', 'image'), after: async () => { await A.waitForFunction(() => window.__w.store.getState().image !== null, null, { timeout: 240000 }); await idle(A); await A.locator('[data-view="axial"] canvas').first().waitFor(); await A.evaluate(() => window.__w.session.setVoi(-1350, 150)); await A.waitForTimeout(2500); } });
    await move('A', ...(await center(A.locator('.filebtn'))), 22);
    await click('A', { holdFrames: 6 });
    await move('A', ...(await center(A.getByRole('menuitem', { name: /Open mask/ }))), 12);
    await click('A', { holdFrames: 34, raw: pick(A, 'A', DATA + '/lungs.nii.gz', 'mask'), after: async () => { await A.waitForFunction(() => window.__w.store.getState().maskName !== null, null, { timeout: 240000 }); await idle(A);
      await A.evaluate(() => { const s = window.__w.session; s.patchSegment(3, { name: 'Left lung' }); s.patchSegment(4, { name: 'Right lung' }); s.patchSegment(5, { name: 'Airways' }); s.setVoi(-1350, 150); }); await A.waitForTimeout(3000); } });
    log('open', JSON.stringify(await st(A))); done('open');

    // ── 2. scroll, paint, erase ──
    scene = 'paint';
    let ax = await box(A, 'axial'), co = await box(A, 'coronal');
    const axc = [ax.x + ax.width / 2, ax.y + ax.height / 2];
    cam('A', 1.7, axc[0], axc[1]);
    await move('A', ...P(ax, 0.05, 0.08), 22);
    const s0 = (await st(A)).slices.axial.index;
    // which wheel direction increases the index
    await A.mouse.wheel(0, 100); await A.waitForTimeout(150); const up = (await st(A)).slices.axial.index > s0 ? 1 : -1; await A.mouse.wheel(0, -100); await A.waitForTimeout(150);
    await wheel('A', 9, -up, 2); await hold(3); await wheel('A', 9 + (61 - s0), up, 2); await hold(4);
    log('scrolled', JSON.stringify((await st(A)).slices.axial));
    await move('A', ...(await center(A.locator('[data-tool="brush"]'))), 20);
    await click('A', { holdFrames: 5, after: async () => { await A.evaluate(() => { const s = window.__w.session; s.selectSegment(3); s.setBrushSize(16); }); } });
    // find the outer edge of the left lung (screen right) on this slice
    const vs = [-0.13, -0.09, -0.05, -0.01, 0.03, 0.07, 0.11]; const es = [];
    for (const v of vs) es.push(await edge(A, ax, v, 0.22, 0.47, 3));
    log('axial edge', JSON.stringify(es)); if (es.some(e => e === null)) throw new Error('no axial edge');
    await A.mouse.move(win.A.x, win.A.y);
    const pts = vs.map((v, i) => P(ax, es[i] + 0.012, v));
    await move('A', pts[0][0], pts[0][1], 22, 2);
    await stroke('A', pts, 34); await hold(4, false);
    const er = [6, 5, 4, 3].map(i => P(ax, es[i] + 0.034, vs[i]));
    await move('A', er[0][0], er[0][1], 10, 2);
    await stroke('A', er, 22, { shift: true }); await hold(4, false);
    // a stroke in the coronal view
    cam('A', 1.7, co.x + co.width / 2, co.y + co.height / 2);
    const cvs = [-0.16, -0.11, -0.06, -0.01, 0.04, 0.09]; const ces = [];
    for (const v of cvs) ces.push(await edge(A, co, v, 0.10, 0.70, 3));
    log('coronal edge', JSON.stringify(ces)); await A.mouse.move(win.A.x, win.A.y);
    if (ces.every(e => e !== null)) { const cp = cvs.map((v, i) => P(co, ces[i] + 0.012, v)); await move('A', cp[0][0], cp[0][1], 26, 2); await stroke('A', cp, 28); await hold(6, false); }
    log('paint', JSON.stringify(await st(A))); done('paint');

    // ── 3. fill between slices ──
    scene = 'fill';
    await A.evaluate(() => { const s = window.__w.session; s.addSegment(); s.setBrushSize(26); });
    const NEW = (await st(A)).active;
    // a spot between the lungs that is free on this slice and six slices away
    const cands = [[0.02, -0.10], [0.0, -0.13], [0.04, -0.07], [-0.02, -0.08], [0.03, -0.14], [0.0, -0.04]]; const ok = cands.map(() => true);
    const probe = async () => { for (let i = 0; i < cands.length; i++) for (const [du, dv] of [[0, 0], [0.045, 0], [-0.045, 0], [0, 0.045], [0, -0.045]]) if ((await hoverSeg(A, ...P(ax, cands[i][0] + du, cands[i][1] + dv))) !== 0) ok[i] = false; };
    await probe(); await A.mouse.move(...axc); for (let i = 0; i < 6; i++) { await A.mouse.wheel(0, up * 100); await A.waitForTimeout(120); } await probe();
    await A.mouse.move(...axc); for (let i = 0; i < 6; i++) { await A.mouse.wheel(0, -up * 100); await A.waitForTimeout(120); }
    const ci = ok.indexOf(true); log('fill spot', JSON.stringify(ok), JSON.stringify((await st(A)).slices.axial)); if (ci < 0) throw new Error('no free spot');
    const [fu, fv] = cands[ci]; const dab = (r) => [0, 1, 2, 3, 4, 5, 6].map(i => P(ax, fu + r * Math.cos(i * 1.05), fv + r * Math.sin(i * 1.05)));
    cam('A', 1.7, axc[0], axc[1]);
    await A.mouse.move(win.A.x, win.A.y); await move('A', ...dab(0.012)[0], 26, 2);
    await stroke('A', dab(0.012), 10);
    await wheel('A', 6, up, 2);
    await stroke('A', dab(0.02), 10);
    cam('A', 1.25, 560, 380);
    await move('A', ...(await center(A.getByRole('button', { name: 'Fill between slices' }))), 22, 2);
    cam('A', 1, 720, 450);
    await click('A', { holdFrames: 16 });
    await move('A', ...P(ax, fu + 0.12, fv + 0.16), 14, 2);
    cam('A', 1.7, axc[0], axc[1]);
    await wheel('A', 6, -up, 4); await hold(8);
    log('fill', JSON.stringify(await st(A))); done('fill');

    // ── 4. rename, lock, hide ──
    scene = 'segments';
    cam('A', 1.9, 1260, 190);
    const row = (name) => A.locator('.segrow', { hasText: name });
    const newName = (await st(A)).segs.find(s => s.startsWith(NEW + ':')).split(':')[1];
    await move('A', ...(await center(row(newName).locator('.name'))), 26);
    await click('A', { count: 2, holdFrames: 4 });
    await A.keyboard.press('Control+A');
    for (const ch of 'Mediastinum') { await A.keyboard.type(ch); await settle(A, 30); await frame(true); await frame(false); }
    await A.keyboard.press('Enter'); await settle(A, 120); await hold(8);
    await move('A', ...(await center(row('Right lung').locator('.name'))), 12);
    await move('A', ...(await center(row('Right lung').getByLabel('Lock', { exact: true }))), 10, 2);
    await click('A', { holdFrames: 10 });
    await move('A', ...(await center(row('Airways').locator('.name'))), 10);
    await move('A', ...(await center(row('Airways').getByLabel('Hide', { exact: true }))), 8, 2);
    cam('A', 1.25, 900, 360);
    await click('A', { holdFrames: 18 });
    log('segments', JSON.stringify(await st(A))); done('segments');

    // ── 5. room ──
    scene = 'room';
    cam('A', 1.3, 760, 380);
    await move('A', ...(await center(A.getByRole('button', { name: 'Share' }))), 24);
    await click('A', { holdFrames: 5 });
    const nameField = A.getByPlaceholder('How others will see you'); await nameField.fill('');
    await move('A', ...(await center(nameField)), 10); await hold(2);
    for (const ch of 'Mina') { await A.keyboard.type(ch); await settle(A, 30); await frame(true); await frame(false); }
    await move('A', ...(await center(A.getByRole('button', { name: 'Start', exact: true }))), 12);
    await click('A', { holdFrames: 24, after: async () => { await A.getByTestId('room-link').waitFor({ timeout: 60000 }); } });
    const link = (await A.getByTestId('room-link').textContent()).trim(); log('link', link);
    await move('A', ...(await center(A.getByRole('button', { name: 'Done', exact: true }))), 12);
    await click('A', { holdFrames: 4 });
    // the second person joins (not on screen until both windows are shown)
    const B = win.B.pg = await newPage(br);
    await B.getByRole('button', { name: 'Join a room', exact: true }).click();
    await B.getByPlaceholder('How others will see you').fill('Sam');
    await B.getByPlaceholder('Paste the invite link').fill(link);
    await B.getByRole('button', { name: 'Join', exact: true }).click();
    await B.waitForFunction(() => { const s = window.__w.store.getState(); return s.image !== null && s.busy === null && s.maskName !== null; }, null, { timeout: 300000 });
    await B.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 60000 }); await B.waitForTimeout(2500);
    const bax = await box(B, 'axial'); await B.mouse.move(bax.x + bax.width / 2, bax.y + bax.height / 2);
    for (let n = 0; n < 60; n++) { const cur = (await st(B)).slices.axial.index, want = (await st(A)).slices.axial.index; if (cur === want) break; await B.mouse.wheel(0, (cur < want ? up : -up) * 100); await B.waitForTimeout(120); }
    await B.evaluate(() => { const s = window.__w.session; s.setVoi(-1350, 150); s.selectSegment(4); s.setTool('brush'); s.setBrushSize(16); });
    await A.evaluate(() => { const s = window.__w.session; s.selectSegment(3); s.setTool('brush'); s.setBrushSize(16); });
    await B.waitForTimeout(1500);
    log('joined', JSON.stringify(await st(B)), JSON.stringify(await st(A)));
    // Sam paints the right lung edge (screen left) unless it is locked for him too; then the left lung
    const bLocked = (await st(B)).segs.some(s => s.startsWith('4:') && s.includes(':L'));
    const bvs = [-0.10, -0.06, -0.02, 0.02, 0.06, 0.10]; const bes = [];
    if (bLocked) await B.evaluate(() => window.__w.session.selectSegment(3));
    for (const v of bvs) bes.push(bLocked ? await edge(B, bax, v + 0.16, 0.2, 0.47, 3) : await edge(B, bax, v, -0.22, -0.47, 4).catch(() => null));
    log('B edge', bLocked, JSON.stringify(bes));
    win.B.x = bax.x + bax.width * 0.5; win.B.y = bax.y + bax.height * 0.8; await B.mouse.move(win.B.x, win.B.y);
    await A.mouse.move(win.A.x, win.A.y);
    dual = true; cam('A', 1, 720, 450); cam('B', 1, 720, 450);
    await hold(20);
    cam('A', 1.55, axc[0] + 60, axc[1]); cam('B', 1.55, axc[0] + 60, axc[1]);
    const bp = bvs.map((v, i) => P(bax, bes[i] + 0.012, v + (bLocked ? 0.16 : 0)));
    await move('B', bp[0][0], bp[0][1], 22, 2);
    await stroke('B', bp, 30);
    // Mina answers on the front of the left lung
    const avs = [-0.2, -0.17, -0.14]; // short stroke further up the same edge
    const aes = []; for (const v of avs) aes.push(await edge(A, ax, v, 0.12, 0.47, 3)); await A.mouse.move(win.A.x, win.A.y);
    log('A edge 2', JSON.stringify(aes));
    if (aes.every(e => e !== null)) { const ap = avs.map((v, i) => P(ax, aes[i] + 0.012, v)); await move('A', ap[0][0], ap[0][1], 18, 2); await stroke('A', ap, 18); }
    await hold(12);
    log('room', JSON.stringify(await st(A)), JSON.stringify(await st(B))); done('room');

    // ── 6. save ──
    dual = false; scene = 'save'; cam('A', 1.3, 380, 260);
    await hold(8);
    await move('A', ...(await center(A.locator('.filebtn'))), 24);
    await click('A', { holdFrames: 6 });
    await move('A', ...(await center(A.getByRole('menuitem', { name: /Save mask/ }))), 12);
    cam('A', 1, 720, 450);
    const dl = A.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    await click('A', { holdFrames: 40, after: async () => { const d = await dl; log('download', d && d.suggestedFilename()); await A.waitForTimeout(400); } });
    log('save', JSON.stringify(await st(A)));
  } catch (e) { if (e.message !== 'STOP') { console.error('FAILED at frame', man.frames.length, e); process.exitCode = 1; } }
  fs.writeFileSync(OUT + '/manifest.json', JSON.stringify(man));
  log('frames', man.frames.length, 'shots A', win.A.n, 'B', win.B.n);
  await br.close();
})();
