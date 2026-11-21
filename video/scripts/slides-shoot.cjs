// usage: APP=http://localhost:4173/ DATA=<folder> node video/scripts/slides-shoot.cjs   (needs a served build of the app and the relay running)
// Takes the screenshots for the README slideshow from the real app, on the same scan as the video.
// Output: PNG files in video/out/slides. scripts/slides-build.cjs lays them out and writes docs/assets/features.webp.
const { chromium } = require('playwright'); const fs = require('fs');
const APP = (process.env.APP || 'http://localhost:4173/').replace(/\/?$/, '/') + '?tour=0';
const DATA = process.env.DATA || __dirname + '/../out/data';
const OUT = process.env.OUT || __dirname + '/../out/slides';
// The image area of a slide is 960 x 540. A small window keeps the app's own text readable at that size.
const VW = 1152, VH = 648, DSF = 5 / 3;
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
fs.mkdirSync(OUT, { recursive: true });

const profile = (theme) => { try { localStorage.setItem('w-annotator:theme', theme); const k = 'w-annotator:settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.tourSeen = true; localStorage.setItem(k, JSON.stringify(s)); localStorage.setItem('w.refine', JSON.stringify({ grow: 3 })); } catch { /* storage is off */ } };
async function newPage(br, theme = 'dark') {
  const ctx = await br.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, colorScheme: theme });
  await ctx.addInitScript(profile, theme); const p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto(APP); await p.waitForFunction(() => '__w' in window); return p;
}
const idle = (p) => p.waitForFunction(() => window.__w.store.getState().busy === null, null, { timeout: 240000 });
const settle = async (p, ms = 700) => { await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await p.waitForTimeout(ms); };
const shot = async (p, name) => { await settle(p); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
const box = (p, v) => p.locator(`[data-view="${v}"]`).boundingBox();
const P = (b, u, v) => { const s = Math.min(b.width, b.height); return [b.x + b.width / 2 + u * s, b.y + b.height / 2 + v * s]; };
const hoverSeg = async (p, x, y) => { await p.mouse.move(x, y); await p.waitForTimeout(45); return p.evaluate(() => { const h = window.__w.store.getState().hover; return h ? h.segment : -1; }); };
const park = (p) => p.mouse.move(VW - 200, VH - 3); // on the status bar, where nothing reacts to the pointer
async function open(p) {
  const files = ['chest_ct.mha', 'lungs.nii.gz'];
  await p.route('**/__data/*', (route) => route.fulfill({ path: DATA + '/' + route.request().url().split('/').pop() }));
  await p.evaluate(async (names) => { const list = []; for (const name of names) list.push({ name, bytes: new Uint8Array(await (await fetch('/__data/' + name)).arrayBuffer()) }); await window.__w.session.openFiles(list); }, files);
  await p.unroute('**/__data/*'); await idle(p);
  await p.evaluate(() => { const s = window.__w.session; s.patchSegment(3, { name: 'Left lung' }); s.patchSegment(4, { name: 'Right lung' }); s.patchSegment(5, { name: 'Airways' }); s.setVoi(-1350, 150); });
  await p.locator('[data-view="axial"] canvas').first().waitFor(); await p.waitForTimeout(3500);
}
// Enlarges one view, as Maximise does, or with null goes back to all four.
async function enlarge(p, v) { await p.evaluate((m) => window.__w.store.setState({ maximized: m }), v); await p.waitForTimeout(1200); }
async function dab(p, pts) { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts.slice(1)) { await p.mouse.move(...q, { steps: 4 }); await p.waitForTimeout(30); } await p.mouse.up(); await p.waitForTimeout(250); }

(async () => {
  const br = await chromium.launch({ args });
  // ── any image, any mask: the four views, once in each theme ──
  for (const theme of ['light', 'dark']) {
    const p = await newPage(br, theme); await open(p); await park(p);
    await shot(p, 'views-' + theme);
    if (theme === 'light') { await p.context().close(); continue; }
    await p.evaluate(() => window.__w.store.setState({ filesOpen: false })); // the close-ups that follow are about the segments

    // ── the window: the same slice in two presets, chosen from the read-out in the status bar ──
    await p.evaluate(() => window.__w.session.setTool('pan')); await enlarge(p, 'axial'); await park(p); await shot(p, 'window-lung');
    await p.locator('button', { hasText: /^W\s*\d/ }).first().click();
    await p.locator('[role=menuitem],[role=menuitemradio]').filter({ hasText: 'Abdomen' }).first().click(); await park(p); await shot(p, 'window-abdomen');
    await p.evaluate(() => { window.__w.session.setVoi(-1350, 150); window.__w.session.setTool('crosshair'); }); await enlarge(p, null);

    // ── two people in one mask ──
    const A = p;
    await A.getByRole('button', { name: 'Share' }).click();
    await A.getByPlaceholder('How others will see you').fill('Mina');
    await A.getByRole('button', { name: 'Start', exact: true }).click();
    const link = (await A.getByTestId('room-link').textContent()).trim();
    await A.getByRole('button', { name: 'Done', exact: true }).click();
    const B = await newPage(br, 'dark');
    await B.getByRole('button', { name: 'Join a room', exact: true }).click();
    await B.getByPlaceholder('How others will see you').fill('Sam');
    await B.getByPlaceholder('Paste the invite link').fill(link);
    await B.getByRole('button', { name: 'Join', exact: true }).click();
    await B.waitForFunction(() => { const s = window.__w.store.getState(); return s.image !== null && s.busy === null && s.maskName !== null; }, null, { timeout: 300000 });
    await B.locator('[data-view="axial"] canvas').first().waitFor(); await B.waitForTimeout(2500);
    await B.evaluate(() => { const s = window.__w.session; s.setVoi(-1350, 150); s.selectSegment(4); s.setTool('brush'); s.setBrushSize(14); });
    await A.evaluate(() => { const s = window.__w.session; s.selectSegment(3); s.setTool('brush'); s.setBrushSize(14); });
    await enlarge(A, 'axial'); await enlarge(B, 'axial'); await B.waitForTimeout(1500);
    // Mina has just corrected the edge of the left lung; Sam is half way along the edge of the right one.
    const edgeOut = async (pg, b, v, dir, seg) => { let inside = false; for (let u = dir * 0.16; Math.abs(u) <= 0.47; u += dir * 0.008) { const s = await hoverSeg(pg, ...P(b, u, v)); if (s === seg) inside = true; else if (inside) return u; } return null; };
    const ab = await box(A, 'axial'); const bb = await box(B, 'axial');
    const avs = [-0.14, -0.1, -0.06, -0.02, 0.02, 0.06]; const aes = []; for (const v of avs) aes.push(await edgeOut(A, ab, v, 1, 3));
    await dab(A, avs.map((v, i) => P(ab, aes[i] + 0.012, v))); await park(A);
    const bvs = [0.12, 0.08, 0.04, 0, -0.04, -0.08]; const bes = []; for (const v of bvs) bes.push(await edgeOut(B, bb, v, -1, 4));
    console.log('edges', JSON.stringify(aes), JSON.stringify(bes));
    const bp = bvs.map((v, i) => P(bb, bes[i] - 0.012, v));
    await B.mouse.move(...bp[0]); await B.mouse.down(); for (const q of bp.slice(1)) { await B.mouse.move(...q, { steps: 5 }); await B.waitForTimeout(60); }
    await B.waitForTimeout(900);
    await shot(A, 'room');
    // the people list, for checking how the popover sits over the panel
    await enlarge(A, null);
    const chip = A.locator('.topbar [aria-haspopup]').last(); if (await chip.count()) { await chip.click().catch(() => {}); await shot(A, 'check-room-popover'); await A.keyboard.press('Escape'); }
    await B.mouse.up(); await B.context().close();
    await A.evaluate(() => { window.__w.session.leaveRoom(true); }); await A.waitForTimeout(500);

    // ── refine: the amount form under the last row, with every volume in view ──
    const row = (name) => A.locator('.segrow', { hasText: name });
    await A.evaluate(() => window.__w.session.setTool('crosshair'));
    await row('Airways').hover(); await row('Airways').getByLabel(/^More for/).click();
    await A.getByRole('menuitem', { name: /^Smooth/ }).click(); await A.mouse.move(VW - 60, VH / 2); await shot(A, 'refine-form');
    await A.keyboard.press('Escape');
    await row('Left lung').hover(); await row('Left lung').getByLabel(/^More for/).click(); await shot(A, 'check-menu-first-row');
    await A.getByRole('menuitem', { name: /^Grow/ }).click(); await shot(A, 'check-grow-form'); await A.keyboard.press('Escape');
    await A.evaluate(() => window.__w.session.openMeasurements()); await park(A); await shot(A, 'check-measurements');
    await A.evaluate(() => window.__w.store.setState({ measurementsOpen: false })); await A.waitForTimeout(300);

    // ── paint three slices, fill the rest ──
    const ax = await box(A, 'axial'); const axc = [ax.x + ax.width / 2, ax.y + ax.height / 2];
    const s0 = await A.evaluate(() => window.__w.store.getState().slices.axial.index);
    await A.mouse.move(...axc); await A.mouse.wheel(0, 100); await A.waitForTimeout(200);
    const up = (await A.evaluate(() => window.__w.store.getState().slices.axial.index)) > s0 ? 1 : -1; await A.mouse.wheel(0, -100); await A.waitForTimeout(200);
    const STEP = 9; const scrollBy = async (n) => { await A.mouse.move(...axc); for (let i = 0; i < Math.abs(n); i++) { await A.mouse.wheel(0, Math.sign(n) * up * 100); await A.waitForTimeout(120); } };
    const cands = [[0.04, -0.07], [0.0, -0.04], [0.02, -0.10], [0.0, -0.13], [-0.02, -0.08], [0.03, -0.14]]; const ok = cands.map(() => true);
    const probe = async () => { for (let i = 0; i < cands.length; i++) for (const [du, dv] of [[0, 0], [0.06, 0], [-0.06, 0], [0, 0.06], [0, -0.06]]) if ((await hoverSeg(A, ...P(ax, cands[i][0] + du, cands[i][1] + dv))) !== 0) ok[i] = false; };
    await scrollBy(-STEP); await probe(); await scrollBy(STEP); await probe(); await scrollBy(STEP); await probe(); await scrollBy(-STEP);
    const ci = ok.indexOf(true); console.log('fill spot', JSON.stringify(ok)); if (ci < 0) throw new Error('no free spot');
    const [fu, fv] = cands[ci]; const ring = (r) => [0, 1, 2, 3, 4, 5, 6].map(i => P(ax, fu + r * Math.cos(i * 1.05), fv + r * Math.sin(i * 1.05)));
    // put the crosshair on the spot so that the other two views cut through it
    await A.evaluate(() => window.__w.session.setTool('crosshair')); await A.mouse.click(...P(ax, fu, fv)); await A.waitForTimeout(400);
    await A.evaluate(() => { const s = window.__w.session; s.addSegment(); s.setTool('brush'); s.setBrushSize(30); s.setPaintOver('empty'); });
    const NEW = await A.evaluate(() => window.__w.store.getState().activeSegment);
    await A.evaluate((i) => window.__w.session.patchSegment(i, { name: 'Mediastinum' }), NEW);
    await scrollBy(-STEP); await dab(A, ring(0.02)); await scrollBy(STEP); await dab(A, ring(0.045)); await scrollBy(STEP); await dab(A, ring(0.028)); await scrollBy(-STEP);
    await park(A); await A.waitForTimeout(1500);
    const rects = {}; for (const v of [null, 'sagittal', 'coronal']) { await enlarge(A, v); await A.waitForTimeout(400); if (v) rects[v] = await box(A, v); await shot(A, 'fill-before-' + (v || 'all')); }
    fs.writeFileSync(OUT + '/rects.json', JSON.stringify({ vw: VW, vh: VH, ...rects }));
    await enlarge(A, null);
    await A.evaluate(() => window.__w.store.setState({ activeView: 'axial' })); // the fill joins slices of the view that was used last
    await A.getByRole('button', { name: /Fill (between slices|gaps)/ }).first().click(); await A.getByText(/^Preview:/).waitFor(); await A.keyboard.press('Enter'); await idle(A); await A.waitForTimeout(600);
    console.log('fill', await A.evaluate(() => window.__w.store.getState().toasts.map(t => t.message).join(' | ')));
    await A.locator('.toast button[aria-label]').last().click().catch(() => {}); // dismiss the toast so it is not in the picture
    await park(A); await A.waitForTimeout(1500);
    for (const v of [null, 'sagittal', 'coronal']) { await enlarge(A, v); await A.waitForTimeout(400); await shot(A, 'fill-after-' + (v || 'all')); }
    // checks: does the new segment reach the 3D view?
    await enlarge(A, null); await A.evaluate((i) => { window.__w.session.showOnly(i); window.__w.store.setState({ maximized: 'volume3d' }); }, NEW); await A.waitForTimeout(2500); await shot(A, 'check-3d-new-segment-only');
    await A.evaluate(() => window.__w.store.setState({ maximized: null })); await A.waitForTimeout(600);

    await A.context().close();
  }
  await br.close();
})().catch((e) => { console.error(e); process.exit(1); });
