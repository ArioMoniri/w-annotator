// usage: APP=http://localhost:4173/ DATA=<folder> node video/scripts/record.cjs   (needs a served build of the app and the relay running)
// Records a scripted session of the real app frame by frame (no real-time capture, so a slow machine does not matter).
// Output: JPEG frames for window A (Mina) and B (Sam) and a manifest with, for every 30 fps output frame,
// which screenshot is on screen, where each cursor is, whether the button is down, the scene, the camera target,
// the axial slice number, the key that is held and how far the two dropped files have travelled.
//
// The storyboard, one caption per scene (the captions are in src/Launch.tsx):
//   open    two files are dropped on the empty window; the four views appear
//   paint   a bite missing from the right lung is brushed in
//   cut     a stray piece of the mask is removed with a freehand loop of the scissors
//   fill    a new segment is painted on three slices; "Fill between slices" previews the rest and Apply writes it
//   window  the window read-out in the status bar is opened and two presets are chosen
//   kinds   Share is opened: the two kinds of room, then the invite link
//   room    two windows; each person fills a gap in a different lung and both see both strokes
//   save    Ctrl+S; the status goes from "Unsaved changes" to "Saved"
// The bite, the stray piece and the two gaps are made by this script off camera, with the app's own eraser and brush,
// so that each correction has something plain to correct.
const { chromium } = require('playwright'); const fs = require('fs');
const APP = (process.env.APP || 'http://localhost:4173/').replace(/\/?$/, '/') + '?tour=0';
// DATA must hold chest_ct.mha and lungs.nii.gz (see README.md for where they come from).
const DATA = process.env.DATA || __dirname + '/../out/data';
const OUT = process.env.OUT || __dirname + '/../out/rec';
const DSF = +(process.env.DSF || 2), UNTIL = process.env.UNTIL || '';
const W = 1280, H = 800;
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const man = { fps: 30, w: W, h: H, frames: [] };
let scene = 'open', dual = false, key = '', drop = -1, slice = 0, cutNext = false;
const mk = () => ({ pg: null, x: 640, y: 400, down: false, img: -1, n: 0, cam: [1, W / 2, H / 2] });
const win = { A: mk(), B: mk() };
const r1 = (v) => Math.round(v * 10) / 10;
const settle = async (pg, ms = 40) => { await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await pg.waitForTimeout(ms); };
async function snap(k) { const w = win[k]; await w.pg.screenshot({ path: `${OUT}/${k}${String(w.n).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 92 }); w.img = w.n++; }
const readSlice = async () => { slice = await win.A.pg.evaluate(() => { const s = window.__w.store.getState(); return s.image ? s.slices.axial.index + 1 : 0; }); };
function push() {
  const A = win.A, B = win.B;
  man.frames.push({ s: scene, d: dual ? 1 : 0, a: A.img, ac: [r1(A.x), r1(A.y), A.down ? 1 : 0], az: A.cam.slice(), b: dual ? B.img : -1, bc: [r1(B.x), r1(B.y), B.down ? 1 : 0], bz: B.cam.slice(), sl: slice, k: key, dp: drop, c: cutNext ? 1 : 0 });
  cutNext = false;
}
/**
 * Plays one list of steps per window, one step per output frame. A step is a function that does something in the
 * real app, or null for a frame in which that window only waits. A frame is photographed when a step ran.
 */
async function play(lists) {
  const n = Math.max(...Object.values(lists).map(l => l.length));
  for (let i = 0; i < n; i++) {
    let acted = false;
    for (const k of Object.keys(lists)) { const step = lists[k][i]; if (step) { if ((await step()) !== false) acted = true; } }
    if (acted) { await settle(win.A.pg, dual ? 150 : 50); if (dual) await settle(win.B.pg, 60); await snap('A'); if (dual) await snap('B'); await readSlice(); }
    push();
  }
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rest = (n) => Array(n).fill(null);
/** Something that changes what is recorded but not the picture (the camera, the scene). */
const set = (fn) => [async () => { await fn(); return false; }];
const shot = (fn) => [async () => { if (fn) await fn(); }];
const cam = (k, c) => set(() => { win[k].cam = c.slice(); });
function mv(k, x, y, n) {
  const w = win[k]; let x0, y0, bow, len, dx, dy;
  return Array.from({ length: n }, (_, j) => async () => {
    if (j === 0) { x0 = w.x; y0 = w.y; dx = x - x0; dy = y - y0; len = Math.hypot(dx, dy) || 1; bow = Math.min(30, len * 0.06); }
    const e = ease((j + 1) / n), s = Math.sin(Math.PI * e) * bow;
    w.x = x0 + dx * e - (dy / len) * s; w.y = y0 + dy * e + (dx / len) * s; await w.pg.mouse.move(w.x, w.y);
  });
}
/** Press, wait two frames, release: long enough for the ripple the composition draws on a press. */
function click(k, fn) {
  const w = win[k];
  return [async () => { w.down = true; return false; }, null, async () => { if (fn) await fn(); else await w.pg.mouse.click(w.x, w.y); w.down = false; }];
}
function stroke(k, pts, n, { shift = false } = {}) {
  const w = win[k]; const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  const at = (i) => { let d = (0.5 - Math.cos(Math.PI * i / n) / 2) * total, j = 0; while (j < seg.length - 1 && d > seg[j]) d -= seg[j++]; const f = Math.min(1, d / (seg[j] || 1)); return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f]; };
  const steps = [async () => { if (shift) { await w.pg.keyboard.down('Shift'); key = 'shift'; } await w.pg.mouse.move(pts[0][0], pts[0][1]); await w.pg.mouse.down(); w.down = true; }];
  for (let i = 1; i <= n; i++) steps.push(async () => { [w.x, w.y] = at(i); await w.pg.mouse.move(w.x, w.y); });
  steps.push(async () => { await w.pg.mouse.up(); w.down = false; if (shift) { await w.pg.keyboard.up('Shift'); key = ''; } await w.pg.waitForTimeout(200); });
  return steps;
}
/** `count` slices, one per wheel notch; `gaps` frames of waiting after each notch. */
function wheel(k, count, dir, gaps = [0, 1]) {
  const w = win[k]; const steps = [];
  for (let i = 0; i < count; i++) { steps.push(async () => { await w.pg.mouse.wheel(0, dir * 100); await w.pg.waitForTimeout(90); }); steps.push(...rest(gaps[i % gaps.length])); }
  return steps;
}
const one = (...parts) => play({ A: parts.flat() });

const P = (b, u, v) => { const s = Math.min(b.width, b.height); return [b.x + b.width / 2 + u * s, b.y + b.height / 2 + v * s]; };
const st = (pg) => pg.evaluate(() => { const s = window.__w.store.getState(); return { slice: s.slices.axial.index, toasts: s.toasts.map(t => t.kind + ':' + t.message), segs: s.segments.map(x => x.index + ':' + x.name), active: s.activeSegment, tool: s.tool, dirty: s.dirty, room: s.room && s.room.status, peers: (s.peers || []).length }; });
const ses = (pg, fn, ...a) => pg.evaluate(([fn, a]) => window.__w.session[fn](...a), [fn, a]);
const hoverSeg = async (pg, x, y) => { await pg.mouse.move(x, y); await pg.waitForTimeout(45); return pg.evaluate(() => { const h = window.__w.store.getState().hover; return h ? h.segment : -1; }); };
/** Going outward from u0 in direction dir along row v: the first point where the mask stops being `seg`. */
async function edge(pg, b, v, u0, dir, seg) { let inside = false; for (let u = u0; Math.abs(u) <= 0.48; u += dir * 0.006) { const s = await hoverSeg(pg, ...P(b, u, v)); if (s === seg) inside = true; else if (inside) return u; } throw new Error(`no edge of segment ${seg} on row ${v}`); }
const edges = async (pg, b, vs, u0, dir, seg) => { const out = []; for (const v of vs) out.push(await edge(pg, b, v, u0, dir, seg)); return out; };
/** A drag that is not recorded. */
async function offCamera(pg, pts, shift = false) { if (shift) await pg.keyboard.down('Shift'); await pg.mouse.move(...pts[0]); await pg.mouse.down(); for (const q of pts.slice(1)) { await pg.mouse.move(...q, { steps: 5 }); await pg.waitForTimeout(40); } await pg.mouse.up(); if (shift) await pg.keyboard.up('Shift'); await pg.waitForTimeout(300); }
const idle = (p) => p.waitForFunction(() => window.__w.store.getState().busy === null, null, { timeout: 240000 });
const loaded = (p) => p.waitForFunction(() => { const s = window.__w.store.getState(); return s.image !== null && s.maskName !== null && s.busy === null; }, null, { timeout: 300000 });
// A fresh profile per window: dark theme, the welcome tour already seen, the lines that mark the other planes shown
// with the crosshair tool only, so that nothing but the mask changes while the pointer crosses a view, and no
// recovery copy, so that the status reads "Unsaved changes" and then "Saved" with nothing after it.
const profile = () => { try { localStorage.setItem('w-annotator:theme', 'dark'); const k = 'w-annotator:settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.tourSeen = true; s.referenceLines = 'crosshair'; s.autosave = false; s.displayName = 'Mina'; localStorage.setItem(k, JSON.stringify(s)); } catch { /* storage is off */ } };
async function newPage(br, dsf) {
  const ctx = await br.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dsf, acceptDownloads: true, colorScheme: 'dark' }); await ctx.addInitScript(profile);
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERR', e.message)); await p.goto(APP); await p.waitForFunction(() => '__w' in window);
  await p.addStyleTag({ content: '[data-tip]::after { display: none !important; }' }); // no tooltips: the recording waits on buttons far longer than a person does
  return p;
}
// The files reach the app through its own drop handler: a drag is entered and dropped on the window with the two
// files in it. The operating system's drag cannot be photographed, so the composition draws the two files itself.
const dragFiles = (pg, type) => pg.evaluate(async ([type, names]) => {
  const dt = new DataTransfer();
  for (const name of names) dt.items.add(new File([await (await fetch('/__data/' + name)).arrayBuffer()], name));
  window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [type, ['chest_ct.mha', 'lungs.nii.gz']]);
const log = (...a) => console.log(`[${man.frames.length}]`, ...a);
const done = (name) => { if (UNTIL === name) throw new Error('STOP'); };

const mid = (b) => [b.x + b.width / 2, b.y + b.height / 2];
/** The value of a list of [row, value] pairs at row v, straight lines between and beyond them. */
function at(rows, vals, v) { let i = 0; while (i < rows.length - 2 && v > rows[i + 1]) i++; return vals[i] + (vals[i + 1] - vals[i]) * (v - rows[i]) / (rows[i + 1] - rows[i]); }

(async () => {
  const br = await chromium.launch({ args });
  const A = win.A.pg = await newPage(br, DSF);
  await A.route('**/__data/*', (route) => route.fulfill({ path: DATA + '/' + route.request().url().split('/').pop() }));
  let B = null;
  // Cameras: [zoom, centre x, centre y] in app pixels.
  const FULL = [1, W / 2, H / 2];
  const ZONE = [1.45, 640, 380];     // the drop zone of the empty window
  const AXIAL = [2.36, 271, 258.5];  // the tool rail and the axial view, and nothing else
  const FILL = [1.6, 448, 294];      // the options of the brush, the axial view and most of the sagittal view beside it
  const SAVE = [1.65, 892, 558];     // the message and the status at the bottom right
  try {
    // ── 1. two files are dropped on the empty window ──
    scene = 'open'; win.A.cam = ZONE.slice();
    await one(shot(), rest(9));
    const TRAVEL = 28;
    for (let i = 1; i <= TRAVEL; i++) {
      drop = i / TRAVEL;
      await one(i === 17 ? shot(() => dragFiles(A, 'dragenter')) : rest(1));
    }
    await one(rest(2));
    await dragFiles(A, 'drop'); await loaded(A);
    await A.locator('[data-view="axial"] canvas').first().waitFor();
    await A.evaluate(() => { const s = window.__w.session; s.patchSegment(3, { name: 'Left lung' }); s.patchSegment(4, { name: 'Right lung' }); s.patchSegment(5, { name: 'Airways' }); s.setVoi(-1350, 150); window.__w.store.setState({ filesOpen: false }); });
    await A.waitForTimeout(3500);

    // off camera: go to the slice the story starts on and make the two defects of the next scenes
    const ax = await A.locator('[data-view="axial"]').boundingBox(); const axc = mid(ax);
    const s0 = (await st(A)).slice;
    await A.mouse.move(...axc); await A.mouse.wheel(0, 100); await A.waitForTimeout(200); const up = (await st(A)).slice > s0 ? 1 : -1;
    const scrollTo = async (pg, want) => { await pg.mouse.move(...axc); for (let n = 0; n < 150; n++) { const cur = (await st(pg)).slice; if (cur === want) return; await pg.mouse.wheel(0, (cur < want ? up : -up) * 100); await pg.waitForTimeout(100); } throw new Error('could not reach slice ' + want); };
    const S1 = 70, S2 = 80, S3 = 90; // the three slices the new segment is painted on
    const HEART = { [S1]: [0.06, -0.1, 0.03], [S2]: [0.065, -0.09, 0.045], [S3]: [0.03, -0.12, 0.035] }; // centre of each blob and radius of the circle the brush is drawn round (less than the brush's own, so no hole is left)
    await scrollTo(A, S1);
    // move the sagittal and coronal views to the heart, so that they cut through what is painted later
    await A.evaluate(([x, y]) => { const e = window.__w.engine; e.jumpTo(e.canvasToWorld('axial', x, y), 'axial'); }, [P(ax, ...HEART[S2])[0] - ax.x, P(ax, ...HEART[S2])[1] - ax.y]); await A.waitForTimeout(400);
    await ses(A, 'setTool', 'brush'); await ses(A, 'selectSegment', 4);
    const MM = 1 / (await A.evaluate(() => window.__w.engine.getMmPerPixel('axial'))) / Math.min(ax.width, ax.height); // one millimetre in units of P()
    const BRUSH = 36, R = (BRUSH / 2) * MM;
    const biteRows = [0.0, 0.035, 0.07, 0.105], strayRows = [-0.17, -0.14, -0.11, -0.08];
    const biteEdge = await edges(A, ax, biteRows, -0.2, -1, 4), strayEdge = await edges(A, ax, strayRows, -0.2, -1, 4);
    log('edges', JSON.stringify(biteEdge), JSON.stringify(strayEdge), 'mm', MM);
    await ses(A, 'setTool', 'eraser'); await ses(A, 'setBrushSize', 42);
    await offCamera(A, biteRows.slice(1, 3).map((v, i) => P(ax, biteEdge[i + 1] + 0.022, v)));
    // a stray piece of the right lung's label beside the lung, with clear space between the two
    await ses(A, 'setTool', 'brush'); await ses(A, 'setBrushSize', 20);
    await offCamera(A, [-0.15, -0.125, -0.1].map((v, i) => P(ax, at(strayRows, strayEdge, v) - 0.078 - (i === 1 ? 0.012 : 0), v)));
    await ses(A, 'setBrushSize', BRUSH); await ses(A, 'setToolOption', { scissorsShape: 'freehand' }); await ses(A, 'setTool', 'pan');
    win.A.x = 640; win.A.y = 400; await A.mouse.move(win.A.x, win.A.y);
    await A.evaluate(() => window.__w.store.setState({ toasts: [] }));
    drop = 1; win.A.cam = FULL.slice();
    for (let i = 1; i <= 10; i++) { drop = 1 + i / 10; await one(i === 1 ? shot() : rest(1)); }
    drop = -1;
    await one(rest(34));
    log('open', JSON.stringify(await st(A))); done('open');

    // ── 2. brush in the bite ──
    scene = 'paint';
    await one(cam('A', AXIAL), mv('A', ...mid(await A.locator('[data-tool="brush"]').boundingBox()), 18), click('A'), rest(6));
    const fix = biteRows.map((v, i) => P(ax, biteEdge[i] + R + 0.004, v));
    await one(mv('A', ...fix[0], 16), rest(3), stroke('A', fix, 28), rest(14));
    log('paint', JSON.stringify(await st(A))); done('paint');

    // ── 3. the scissors: a freehand loop round the stray piece ──
    scene = 'cut';
    await one(mv('A', ...mid(await A.locator('[data-tool="scissors"]').boundingBox()), 16), click('A'), rest(5));
    const loopRows = [-0.2, -0.17, -0.14, -0.11, -0.08, -0.05];
    const loop = [...loopRows.map((v) => [at(strayRows, strayEdge, v) - 0.03, v]), ...loopRows.slice().reverse().map((v, i) => [at(strayRows, strayEdge, v) - 0.132 - (i % 2 ? 0.006 : 0), v])];
    loop.push(loop[0]);
    const loopPts = loop.map(([u, v]) => P(ax, u, v));
    await one(mv('A', ...loopPts[0], 16), rest(3), stroke('A', loopPts, 34), rest(16));
    log('cut', JSON.stringify(await st(A))); done('cut');

    // ── 4. a new segment on three slices, a preview of the fill between them, Apply ──
    scene = 'fill';
    await ses(A, 'setTool', 'brush'); await ses(A, 'addSegment'); const NEW = (await st(A)).active;
    await ses(A, 'patchSegment', NEW, { name: 'Heart', color: '#0072B2' }); await ses(A, 'setBrushSize', 40); await ses(A, 'setPaintOver', 'empty');
    const blob = (s) => { const [u, v, r] = HEART[s]; return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => P(ax, u + r * Math.cos(i * 0.85), v + r * Math.sin(i * 0.85))); };
    await one(shot(), rest(3), mv('A', ...blob(S1)[0], 12), stroke('A', blob(S1), 16), rest(2), wheel('A', S2 - S1, up),
      mv('A', ...blob(S2)[0], 4), stroke('A', blob(S2), 16), rest(2), wheel('A', S3 - S2, up), mv('A', ...blob(S3)[0], 4), stroke('A', blob(S3), 16), rest(5));
    await one(cam('A', FILL), mv('A', ...mid(await A.getByRole('button', { name: 'Fill between slices' }).boundingBox()), 18), rest(3),
      click('A', async () => { await A.mouse.click(win.A.x, win.A.y); await A.getByRole('button', { name: 'Apply', exact: true }).waitFor(); await A.waitForTimeout(900); }), rest(24));
    const applyBox = await A.getByRole('button', { name: 'Apply', exact: true }).boundingBox(); log('apply at', JSON.stringify(applyBox));
    await one(mv('A', ...mid(applyBox), 12), rest(2), click('A', async () => { await A.mouse.click(win.A.x, win.A.y); await idle(A); await A.waitForTimeout(900); }), rest(24));
    log('fill', JSON.stringify(await st(A))); done('fill');

    // ── 5. the window: two presets from the read-out in the status bar ──
    // off camera: the middle slice, and the axial view enlarged and placed so that the slice and the menu fill the frame
    await A.evaluate(() => window.__w.store.setState({ toasts: [] })); await ses(A, 'setTool', 'pan');
    await scrollTo(A, S2);
    await A.evaluate(() => window.__w.store.setState({ panelOpen: false, maximized: 'axial' })); await A.waitForTimeout(1500);
    const readout = A.locator('button', { hasText: /^W\s*\d/ }).first(); const item = (name) => A.locator('[role=menuitem],[role=menuitemradio]').filter({ hasText: name }).first();
    // The menu opens above the read-out, its right edge at the button's. At this zoom its names are 24 px tall in the
    // video. One camera holds the slice and the menu; the other has the slice in the middle, for when the menu is shut.
    const WZ = 1.76, vw = W / WZ, vh = H / WZ, rb = await readout.boundingBox();
    const menuCam = [WZ, rb.x + rb.width + 9 - vw / 2, H - vh / 2], left = menuCam[1] - vw / 2;
    const spot = [left + (vw - 233) / 2, 550]; // the middle of the room left of the menu
    const imageCam = [WZ, spot[0], 772 - vh / 2]; // the slice alone: the status bar is below the frame
    const big = await A.locator('[data-view="axial"]').boundingBox(); const SHRINK = 0.88, SHIFT = [spot[0] - (big.x + big.width / 2), spot[1] - (big.y + big.height / 2)];
    await A.evaluate(([k, dx, dy]) => { const e = window.__w.engine; e.zoomBy('axial', k); e.panBy('axial', dx, dy); }, [SHRINK, ...SHIFT]); await A.waitForTimeout(800);
    log('window cams', JSON.stringify(menuCam), JSON.stringify(imageCam), JSON.stringify(rb));
    win.A.x = spot[0] + 150; win.A.y = spot[1] + 120; await A.mouse.move(win.A.x, win.A.y);
    scene = 'window'; cutNext = true; win.A.cam = imageCam.slice();
    await one(shot(), rest(5));
    for (const [n, name] of ['Abdomen', 'Bone'].entries()) {
      if (!(await item(name).isVisible())) await one(cam('A', menuCam), mv('A', ...mid(await readout.boundingBox()), n ? 12 : 16), click('A'), rest(n ? 8 : 12));
      if (n === 0) log('menu', JSON.stringify(await A.locator('[role=menu]').first().boundingBox().catch(() => null)));
      await one(mv('A', ...mid(await item(name).boundingBox()), 11), rest(2), click('A', async () => { await A.mouse.click(win.A.x, win.A.y); await A.waitForTimeout(700); }), cam('A', imageCam),
        mv('A', spot[0] + 190, spot[1] + 110, 12), rest(n ? 20 : 10));
    }
    log('window', JSON.stringify(await st(A)), await readout.textContent()); done('window');

    // ── 6. Share: the two kinds of room ──
    // off camera: the views as they were, the lung window again, and the two gaps of the last scene
    await A.evaluate(([k, dx, dy]) => { const e = window.__w.engine; e.panBy('axial', -dx, -dy); e.zoomBy('axial', 1 / k); }, [SHRINK, ...SHIFT]);
    await A.evaluate(() => { window.__w.store.setState({ maximized: null, panelOpen: true }); window.__w.session.setVoi(-1350, 150); }); await A.waitForTimeout(2000);
    await ses(A, 'setTool', 'brush'); await ses(A, 'setPaintOver', 'all'); await ses(A, 'selectSegment', 4);
    const gapRows = [0.0, 0.035, 0.07, 0.105];
    const samEdge = await edges(A, ax, gapRows, -0.2, -1, 4); await ses(A, 'selectSegment', 3); const minaEdge = await edges(A, ax, gapRows, 0.25, 1, 3);
    log('room edges', JSON.stringify(samEdge), JSON.stringify(minaEdge), await readout.textContent());
    await ses(A, 'setTool', 'eraser'); await ses(A, 'setBrushSize', 42);
    await offCamera(A, gapRows.slice(1, 3).map((v, i) => P(ax, samEdge[i + 1] + 0.022, v)));
    await offCamera(A, gapRows.slice(1, 3).map((v, i) => P(ax, minaEdge[i + 1] - 0.022, v)));
    await ses(A, 'setTool', 'brush'); await ses(A, 'setBrushSize', BRUSH);
    await A.evaluate(() => window.__w.store.setState({ toasts: [] }));
    win.A.x = 900; win.A.y = 300; await A.mouse.move(win.A.x, win.A.y);
    scene = 'kinds'; cutNext = true; win.A.cam = FULL.slice();
    // The camera goes to the two kinds, large enough to read (their text is 27 px tall in the video), with Start below;
    // then to the dialog that says what an invite link is, which is shown only briefly. A camera is told where to go
    // some frames after the click, because it sets off early and must not move before the dialog is there.
    const KZ = 2.1, kh = H / KZ; let next = FULL;
    await one(shot(), rest(5), mv('A', ...mid(await A.getByRole('button', { name: 'Share' }).boundingBox()), 16),
      click('A', async () => {
        await A.mouse.click(win.A.x, win.A.y); await A.getByRole('radio', { name: 'Shared copy' }).waitFor(); await A.waitForTimeout(500);
        const start = await A.getByRole('button', { name: 'Start', exact: true }).boundingBox();
        next = [KZ, W / 2, start.y + start.height + 16 - kh / 2]; log('kinds cam', JSON.stringify(next));
      }), rest(18), set(() => { win.A.cam = next.slice(); }), rest(8));
    log('name', await A.getByPlaceholder('How others will see you').inputValue());
    await one(mv('A', ...mid(await A.getByRole('radio', { name: 'Shared copy' }).boundingBox()), 14), rest(30),
      mv('A', ...mid(await A.getByRole('button', { name: 'Start', exact: true }).boundingBox()), 14),
      click('A', async () => {
        await A.mouse.click(win.A.x, win.A.y); await A.getByTestId('room-link').waitFor({ timeout: 60000 }); await A.waitForTimeout(500);
        const d = await A.getByRole('dialog').boundingBox(); next = [2.3, d.x + d.width / 2, d.y + d.height / 2]; log('link cam', JSON.stringify(next), JSON.stringify(d));
      }), rest(6), set(() => { win.A.cam = next.slice(); }), rest(26));
    const link = (await A.getByTestId('room-link').textContent()).trim(); log('link', link.replace(/#.*/, '#…'));
    done('kinds');

    // ── 7. Sam joins, and each fills a gap in a different lung ──
    await A.keyboard.press('Escape'); await A.waitForTimeout(400);
    B = win.B.pg = await newPage(br, 1.5);
    const joined = await ses(B, 'joinRoom', 'Sam', link); if (joined !== true) throw new Error('join: ' + joined);
    await loaded(B); await B.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 60000 }); await B.waitForTimeout(2500);
    await scrollTo(B, S2);
    await B.evaluate(() => { const s = window.__w.session; s.setVoi(-1350, 150); s.selectSegment(4); s.setTool('brush'); s.setBrushSize(36); window.__w.store.setState({ filesOpen: false, toasts: [] }); });
    await A.evaluate(() => window.__w.store.setState({ toasts: [] }));
    const samFix = gapRows.map((v, i) => P(ax, samEdge[i] + R + 0.004, v)), minaFix = gapRows.map((v, i) => P(ax, minaEdge[i] - R - 0.004, v));
    win.A.x = axc[0] + 40; win.A.y = ax.y + ax.height * 0.84; await A.mouse.move(win.A.x, win.A.y);
    win.B.x = axc[0] - 30; win.B.y = ax.y + ax.height * 0.84; await B.mouse.move(win.B.x, win.B.y); await B.waitForTimeout(1200);
    log('joined', JSON.stringify(await st(A)), JSON.stringify(await st(B)));
    scene = 'room'; dual = true; win.A.cam = FULL.slice(); win.B.cam = FULL.slice();
    await play({ A: [...shot(), ...rest(22)] });
    await play({
      A: [...cam('A', AXIAL), ...rest(14), ...mv('A', ...minaFix[0], 16), ...rest(2), ...stroke('A', minaFix, 28), ...rest(4)],
      B: [...cam('B', AXIAL), ...rest(4), ...mv('B', ...samFix[0], 16), ...rest(2), ...stroke('B', samFix, 28)],
    });
    await play({ A: [...shot(async () => { await A.waitForTimeout(800); }), ...rest(24)] });
    log('room', JSON.stringify(await st(A)), JSON.stringify(await st(B))); done('room');

    // ── 8. save ──
    await ses(A, 'leaveRoom', true); await B.context().close(); B = null; await A.waitForTimeout(600);
    await A.evaluate(() => window.__w.store.setState({ toasts: [], panelOpen: false })); await A.waitForTimeout(2000); // the views take the whole width, so the picture of the save is the mask in 3D, the message and the status
    win.A.x = 860; win.A.y = 560; await A.mouse.move(win.A.x, win.A.y);
    dual = false; scene = 'save'; win.A.cam = SAVE.slice();
    log('before save', JSON.stringify(await st(A)));
    await one(shot(), rest(19));
    key = 'save'; await one(rest(9));
    const dl = A.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    await one(shot(async () => { await A.keyboard.press('Control+s'); const d = await dl; log('download', d && d.suggestedFilename()); await A.waitForTimeout(700); }), rest(7));
    key = ''; await one(rest(36));
    log('save', JSON.stringify(await st(A)));
  } catch (e) { if (e.message !== 'STOP') { console.error('FAILED at frame', man.frames.length, e); process.exitCode = 1; } }
  fs.writeFileSync(OUT + '/manifest.json', JSON.stringify(man));
  log('frames', man.frames.length, 'shots A', win.A.n, 'B', win.B.n);
  await br.close();
})();
