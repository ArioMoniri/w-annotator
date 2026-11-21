/**
 * Checks the app in WebKitGTK, the engine of the Linux desktop build and the closest
 * thing to the macOS app's WKWebView that runs on Linux. See docs/process/TESTING-WEBKIT.md.
 *
 *   xvfb-run -a node e2e-webkit/check.mjs            # the dev server at W_URL (default http://localhost:1420)
 *   W_APP=target/debug/w-annotator xvfb-run -a node e2e-webkit/check.mjs   # the built desktop app
 *
 * W_SHOTS=<folder> also writes a screenshot of each state it visits.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIND, assemble, joinRoom } from '../e2e-desktop/roombot.mjs';
import { click, clickOn, drag, hover, idle, maskVoxels, open, rect, sleep, state, until } from './wd.mjs';

const APP = process.env.W_APP ? resolve(process.env.W_APP) : undefined;
const URL = process.env.W_URL ?? 'http://localhost:1420/';
const SHOTS = process.env.W_SHOTS ? resolve(process.env.W_SHOTS) : null;
/** A room server for the web build, e.g. ws://localhost:8787. The desktop app hosts rooms itself. */
const RELAY = process.env.W_RELAY;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
let b;

async function shot(name) {
  if (SHOTS) await b.screenshot(join(SHOTS, `${name}.png`));
}

async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n')[0]}`);
    await shot(`FAIL ${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
  }
}

function expect(ok, message) {
  if (!ok) throw new Error(message);
}

const setState = (patch) => b.exec((patch) => window.__w.store.setState(patch), patch);
const tool = (id) => clickOn(b, `[data-tool="${id}"]`);
const overlaps = (a, c) => a.x < c.x + c.width - 0.5 && c.x < a.x + a.width - 0.5 && a.y < c.y + c.height - 0.5 && c.y < a.y + a.height - 0.5;

b = await open({ url: APP ? undefined : URL, app: APP });
try {
  await until(() => b.exec(() => '__w' in window), Boolean, { timeout: 60_000, what: 'the app to load' });
  console.log(`WebKit: ${await b.exec(() => navigator.userAgent)}`);
  console.log(APP ? `App: ${APP}` : `Page: ${URL}`);

  /* ── first launch: the tour and its sample ── */
  await b.exec(() => localStorage.clear());
  await b.exec(() => location.reload());
  await sleep(1500);
  await until(() => rect(b, '[data-testid="tour-card"]'), Boolean, { what: 'the welcome tour' });
  await b.exec(() => {
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    const error = console.error;
    console.error = (...args) => (window.__errors.push(args.map(String).join(' ')), error.apply(console, args));
  });
  await shot('01 tour offer');

  await check('the tour opens the sample and runs to its end', async () => {
    await clickOn(b, '[data-testid="tour-card"] button.primary');
    await idle(b);
    await sleep(1000);
    let steps = 0;
    for (; steps < 20; steps++) {
      const phase = await b.exec(() => document.querySelector('[data-testid="tour"]')?.dataset.phase ?? 'off');
      if (phase !== 'steps') break;
      const hole = await rect(b, '[data-testid="tour-hole"]');
      expect(hole && hole.width > 20 && hole.height > 20, `step ${steps + 1} points at nothing`);
      await shot(`02 tour step ${String(steps + 1).padStart(2, '0')}`);
      await clickOn(b, '[data-testid="tour-card"] button[data-primary]');
    }
    expect(steps >= 5, `only ${steps} tour steps were shown`);
    await clickOn(b, '[data-testid="tour-card"] button[data-primary]');
    await sleep(400);
    expect(!(await rect(b, '[data-testid="tour"]')), 'the tour layer is still there');
    expect((await state(b, (s) => s.segments.length)) >= 1, 'the sample mask has no segments');
  });

  /* ── every edit tool changes the mask ── */
  for (const [id, act] of [
    ['brush', () => drag(b, 'axial', [-60, -60], [60, -30])],
    ['eraser', () => drag(b, 'axial', [-60, 0], [60, 0])],
    ['threshold', () => drag(b, 'coronal', [-50, 40], [50, 40])],
    // The scissors erase the active segment only, so the rectangle goes over the brush stroke made above.
    ['scissors', () => drag(b, 'axial', [-30, -75], [30, -25])],
    ['fill', () => click(b, 'sagittal', [10, 10])],
  ]) {
    await check(`${id} changes the mask`, async () => {
      await tool(id);
      expect((await state(b, (s) => s.tool)) === id, `the rail did not select ${id}`);
      const before = await b.exec(() => Array.from(window.__w.session.getMask().data).reduce((a, v, i) => (a + v * ((i % 1021) + 1)) % 1e9, 0));
      await act();
      await sleep(300);
      const after = await b.exec(() => Array.from(window.__w.session.getMask().data).reduce((a, v, i) => (a + v * ((i % 1021) + 1)) % 1e9, 0));
      expect(before !== after, 'no voxel changed');
      await shot(`03 tool ${id}`);
    });
  }

  await check('undo and redo follow the rail buttons', async () => {
    const now = await maskVoxels(b);
    await clickOn(b, 'button[aria-label="Undo"]');
    const undone = await maskVoxels(b);
    await clickOn(b, 'button[aria-label="Redo"]');
    expect((await maskVoxels(b)) === now, 'redo did not bring the edit back');
    expect(undone !== now || (await state(b, (s) => s.canUndo)), 'undo did nothing');
  });

  /* ── outline scissors, picking, islands, the fill preview and smooth pixels ── */
  /** Presses at the first point, drags through the rest and releases; offsets from the view's centre. */
  const trace = async (view, points) => {
    const r = await rect(b, `[data-view="${view}"]`);
    const at = (p) => ({ x: r.x + r.width / 2 + p[0], y: r.y + r.height / 2 + p[1] });
    const actions = [{ type: 'move', ...at(points[0]) }, { type: 'down' }, { type: 'pause', duration: 50 }];
    for (const p of points.slice(1)) actions.push({ type: 'move', ...at(p), duration: 40 });
    actions.push({ type: 'pause', duration: 50 }, { type: 'up' });
    await b.pointer(actions);
    await sleep(500);
  };
  const ALT = '';
  const ENTER = '';
  const ESC = '\uE00C';
  const voxelsOf = (label) => maskVoxels(b, label);

  await check('a freehand loop erases what it goes around, and undo brings it back', async () => {
    await tool('brush');
    await drag(b, 'axial', [-20, 100], [20, 100]);
    const active = await state(b, (s) => s.activeSegment);
    const painted = await voxelsOf(active);
    await tool('scissors');
    await b.exec(() => window.__w.session.setToolOption({ scissorsShape: 'freehand', scissorsAction: 'erase', scissorsDepth: 'slice' }));
    await trace('axial', [[-50, 78], [0, 72], [50, 78], [54, 100], [50, 124], [0, 128], [-50, 124], [-54, 100]]);
    expect(!(await rect(b, '.outline-draw')), 'the outline is still drawn after the release');
    const cut = await voxelsOf(active);
    expect(cut < painted, `the loop erased nothing (${painted} voxels before and after)`);
    await shot('03b freehand scissors');
    await clickOn(b, 'button[aria-label="Undo"]');
    expect((await voxelsOf(active)) === painted, 'undo did not bring the voxels back');
    await b.exec(() => window.__w.session.setToolOption({ scissorsShape: 'rectangle' }));
  });

  await check('Alt-click selects the segment under the cursor and paints nothing', async () => {
    const first = await state(b, (s) => s.activeSegment);
    await b.exec(() => window.__w.session.addSegment());
    const added = await state(b, (s) => s.activeSegment);
    expect(added !== first, 'no segment was added');
    const before = await maskVoxels(b);
    const r = await rect(b, '[data-view="axial"]');
    await b.call('POST', '/actions', {
      actions: [
        { type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value: ALT }, { type: 'pause' }, { type: 'pause' }, { type: 'pause' }, { type: 'keyUp', value: ALT }] },
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pause' },
            { type: 'pointerMove', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2 + 100), origin: 'viewport', duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
            { type: 'pause' },
          ],
        },
      ],
    });
    await sleep(400);
    expect((await state(b, (s) => s.activeSegment)) === first, 'the segment under the cursor was not selected');
    expect((await maskVoxels(b)) === before, 'the click changed the mask');
    await b.exec((added) => window.__w.session.selectSegment(added), added);
  });

  await check('the Fill tool removes the island that is clicked', async () => {
    const seg = await state(b, (s) => s.activeSegment);
    await tool('brush');
    await drag(b, 'axial', [-110, -100], [-90, -100]);
    const one = await voxelsOf(seg);
    await drag(b, 'axial', [90, -100], [110, -100]);
    const two = await voxelsOf(seg);
    expect(one > 0 && two > one, `two strokes did not paint two pieces (${one}, ${two})`);
    await tool('fill');
    await b.exec(() => window.__w.session.setToolOption({ fillAction: 'remove' }));
    await click(b, 'axial', [100, -100]);
    expect((await voxelsOf(seg)) === one, `the clicked piece is still there (${await voxelsOf(seg)} voxels, expected ${one})`);
    await b.exec(() => window.__w.session.setToolOption({ fillAction: 'fill' }));
  });

  await check('fill between slices shows a preview and writes on Enter', async () => {
    const seg = await state(b, (s) => s.activeSegment);
    await tool('brush');
    await b.exec(() => window.__w.engine.scrollSlices('axial', 4));
    await sleep(300);
    await drag(b, 'axial', [-110, -100], [-90, -100]);
    const painted = await voxelsOf(seg);
    await clickOn(b, '[data-tour="interpolate"]');
    await until(() => state(b, (s) => !!s.preview), Boolean, { what: 'the fill preview' });
    await sleep(400);
    await shot('03c fill preview');
    expect((await voxelsOf(seg)) === painted, 'the preview changed the mask');
    expect(await rect(b, '.strip .btn.primary'), 'the strip has no Apply button');
    await b.keys(ENTER);
    await sleep(400);
    expect(!(await state(b, (s) => !!s.preview)), 'the preview is still there after Enter');
    expect((await voxelsOf(seg)) > painted, 'Enter did not fill the gap');
    await b.exec((seg) => window.__w.session.deleteSegment(seg), seg);
  });

  await check('Smooth pixels can be switched from a view menu', async () => {
    expect((await b.exec(() => window.__w.engine.getSmoothPixels('axial'))) === true, 'pixels are not smooth to begin with');
    await clickOn(b, '[data-view="axial"] .viewlabel > button');
    await clickOn(b, '[data-view="axial"] [role="menuitemcheckbox"]');
    await sleep(300);
    expect((await b.exec(() => window.__w.engine.getSmoothPixels('coronal'))) === false, 'the slice views are still smoothed');
    await shot('03d flat pixels');
    await b.exec(() => window.__w.settings.setSetting('smoothPixels', true));
    await sleep(200);
    expect((await b.exec(() => window.__w.engine.getSmoothPixels('axial'))) === true, 'smoothing did not come back');
  });

  await check('the window read-out opens its menu above the status bar and a preset changes the window', async () => {
    const before = await state(b, (s) => s.voi);
    await clickOn(b, '[data-testid="status-window"]');
    await sleep(300);
    const menu = await rect(b, '.statuspop');
    const bar = await rect(b, '.status');
    expect(menu, 'no menu opened');
    expect(menu.y >= 0 && menu.y + menu.height <= bar.y + 1, `the menu spans ${menu.y} to ${menu.y + menu.height}; the bar starts at ${bar.y}`);
    expect(menu.x >= 0 && menu.x + menu.width <= bar.x + bar.width + 1, 'the menu runs off the side of the window');
    await shot('03e window menu');
    // The last preset is Full range in the CT list and a worked-out window in the MR list; neither is what a file opens on.
    await b.exec(() => [...document.querySelectorAll('.statuspop [role="menuitemradio"]')].find((el) => el.getAttribute('aria-checked') !== 'true' && el.dataset.preset !== 'Auto').click());
    await sleep(300);
    const after = await state(b, (s) => s.voi);
    expect(after.lower !== before.lower || after.upper !== before.upper, 'choosing a preset did not change the window');
    expect(!(await rect(b, '.statuspop')), 'the menu stayed open after a choice');
    await b.exec((v) => window.__w.session.setVoi(v.lower, v.upper), before);
  });

  await check('the zoom read-out opens its menu and Zoom in enlarges the active view', async () => {
    await b.exec(() => window.__w.store.setState({ activeView: 'axial' }));
    const before = await b.exec(() => window.__w.engine.getZoom('axial'));
    await clickOn(b, '[data-testid="status-zoom"]');
    await sleep(300);
    expect(await rect(b, '.statuspop'), 'no menu opened');
    await clickOn(b, '.statuspop [role="menuitem"]');
    await sleep(300);
    const after = await b.exec(() => window.__w.engine.getZoom('axial'));
    expect(Math.abs(after / before - 1.25) < 0.01, `zoom went from ${before} to ${after}`);
    await b.keys(ESC);
    await sleep(200);
    expect(!(await rect(b, '.statuspop')), 'Esc did not close the menu');
    await b.exec(() => window.__w.engine.fitAll());
  });

  /* ── the navigation tools ── */
  for (const id of ['crosshair', 'pan', 'zoom', 'window', 'measure']) {
    await check(`${id} can be picked and used without an error`, async () => {
      await tool(id);
      expect((await state(b, (s) => s.tool)) === id, `the rail did not select ${id}`);
      const before = await state(b, (s) => ({ zoom: s.zoom, voi: s.voi }));
      await drag(b, 'coronal', [-30, -30], [30, 40]);
      const after = await state(b, (s) => ({ zoom: s.zoom, voi: s.voi }));
      if (id === 'zoom') expect(before.zoom !== after.zoom, 'dragging did not zoom');
      if (id === 'window') expect(before.voi.lower !== after.voi.lower || before.voi.upper !== after.voi.upper, 'dragging did not change the window');
      await shot(`04 tool ${id}`);
    });
  }
  await b.exec(() => window.__w.engine.fitAll());

  /* ── enlarging a view: the WebKit bug behind "can't edit the masks" ── */
  const grid = await rect(b, '.views');
  for (const view of ['axial', 'sagittal', 'coronal', 'volume3d']) {
    await check(`${view} enlarged fills the view area`, async () => {
      await setState({ maximized: view });
      await sleep(400);
      const r = await rect(b, `[data-view="${view}"]`);
      expect(Math.abs(r.width - grid.width) <= 1 && Math.abs(r.height - grid.height) <= 1, `it is ${r.width} × ${r.height}, the area is ${grid.width} × ${grid.height}`);
      await shot(`05 enlarged ${view}`);
    });
  }
  await check('painting works on an enlarged view and after going back', async () => {
    await setState({ maximized: null });
    await sleep(300);
    await tool('crosshair');
    // Double-click, as the tour suggests.
    const c = await rect(b, '[data-view="axial"]');
    const at = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
    await b.pointer([{ type: 'move', ...at }, { type: 'down' }, { type: 'up' }, { type: 'pause', duration: 60 }, { type: 'down' }, { type: 'up' }]);
    await sleep(700);
    expect((await state(b, (s) => s.maximized)) === 'axial', 'a double-click did not enlarge the view');
    await tool('brush');
    await b.exec(() => window.__w.session.addSegment());
    const active = await state(b, (s) => s.activeSegment);
    let before = await maskVoxels(b, active);
    await drag(b, 'axial', [-150, 120], [150, 120]);
    expect((await maskVoxels(b, active)) > before, 'the brush painted nothing on the enlarged view');
    await hover(b, '[data-view="axial"]');
    await clickOn(b, '[data-view="axial"] button[aria-label="Restore"]');
    await sleep(500);
    expect((await state(b, (s) => s.maximized)) === null, 'the Restore button did not bring the four views back');
    before = await maskVoxels(b, active);
    await drag(b, 'coronal', [-60, 60], [60, 60]);
    expect((await maskVoxels(b, active)) > before, 'the brush painted nothing after going back to four views');
  });

  await check('a click on the 3D view with an edit tool says where to paint', async () => {
    await click(b, 'volume3d', [0, 0]);
    await sleep(600);
    const toasts = await state(b, (s) => s.toasts.map((t) => t.text));
    expect(toasts.some((t) => t.startsWith('Paint on the axial')), `toasts: ${JSON.stringify(toasts)}`);
  });

  await check('a key whose release never arrived does not stop the brush', async () => {
    const active = await state(b, (s) => s.activeSegment);
    await drag(b, 'axial', [-40, -100], [-20, -100]);
    await b.call('POST', '/actions', { actions: [{ type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value: 'q' }] }] });
    const before = await maskVoxels(b, active);
    await drag(b, 'axial', [-40, 100], [40, 100]);
    const after = await maskVoxels(b, active);
    await b.call('POST', '/actions', { actions: [{ type: 'key', id: 'kbd', actions: [{ type: 'keyUp', value: 'q' }] }] });
    expect(after > before, 'the brush painted nothing while a key was held');
  });

  /* ── the smallest brush ── */
  await check('the smallest brush paints a few voxels with one click', async () => {
    const min = await state(b, (s) => s.brushMin);
    await b.exec((min) => window.__w.session.setBrushSize(min / 4), min);
    expect((await state(b, (s) => s.brushSize)) === min, 'the size went below the minimum');
    const shown = await b.exec(() => document.querySelector('input[aria-label="Brush size in millimetres"]').value);
    expect(Number(shown) === min, `the size field shows ${shown}, the minimum is ${min}`);
    // A segment of its own, so every painted voxel counts.
    await b.exec(() => window.__w.session.addSegment());
    const active = await state(b, (s) => s.activeSegment);
    for (const at of [
      [10, 10],
      [17, 29],
      [39, 13],
    ]) {
      const before = await maskVoxels(b, active);
      await click(b, 'axial', at);
      await sleep(400);
      const changed = (await maskVoxels(b, active)) - before;
      expect(changed >= 1 && changed <= 6, `a click at ${at} changed ${changed} voxels`);
    }
    await shot('06 smallest brush');
    await b.exec(() => window.__w.session.setBrushSize(8));
  });

  /* ── tooltips over a view ── */
  await check('tooltips of the buttons over a view are below them and plain', async () => {
    await hover(b, '[data-view="volume3d"]');
    await hover(b, '[data-view="volume3d"] button[aria-label="Maximise"]');
    await sleep(800);
    await shot('07 tooltip maximise');
    const tip = await b.exec(() => {
      const el = document.querySelector('[data-view="volume3d"] button[aria-label="Maximise"]');
      const other = document.querySelector('[data-view="volume3d"] button[aria-label="Show image in 3D"]').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const s = getComputedStyle(el, '::after');
      const width = parseFloat(s.width);
      const right = box.right - parseFloat(s.right);
      return {
        box: { x: right - width, y: box.top + parseFloat(s.top), width, height: parseFloat(s.height) },
        other: { x: other.x, y: other.y, width: other.width, height: other.height },
        opacity: s.opacity,
        stroke: s.webkitTextStrokeWidth,
        shadow: s.textShadow,
        transform: s.transform,
      };
    });
    expect(tip.opacity === '1', `the tooltip is not fully shown (opacity ${tip.opacity})`);
    expect(!overlaps(tip.box, tip.other), 'the tooltip covers the button beside it');
    expect(tip.stroke === '0px' && tip.shadow === 'none', `the tooltip text is outlined (${tip.stroke}, ${tip.shadow})`);
    expect(tip.transform === 'none', `the tooltip is transformed (${tip.transform})`);
  });

  /* ── dialogs ── */
  const closeClear = () =>
    b.exec(() => {
      const root = document.querySelector('[role="dialog"]');
      const close = root?.querySelector('button.close');
      if (!root || !close) return ['no dialog or no close button'];
      const c = close.getBoundingClientRect();
      const hits = [];
      for (const el of root.querySelectorAll('button, input, select, [role="tab"], h2, h3')) {
        if (el === close) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        const boxes = el.matches('h2, h3') ? Array.from(range.getClientRects()) : [el.getBoundingClientRect()];
        if (boxes.some((r) => r.width > 0 && r.left < c.right - 0.5 && c.left < r.right - 0.5 && r.top < c.bottom - 0.5 && c.top < r.bottom - 0.5)) {
          hits.push(`${el.tagName} ${(el.textContent ?? '').trim().slice(0, 24)}`);
        }
      }
      return hits;
    });
  for (const [name, on, off] of [
    ['room dialog', { roomModal: 'start' }, { roomModal: null }],
    ['room dialog, join', { roomModal: 'join' }, { roomModal: null }],
    ['settings, profile', { settings: 'profile' }, { settings: null }],
    ['settings, appearance', { settings: 'appearance' }, { settings: null }],
    ['settings, shortcuts', { settings: 'shortcuts' }, { settings: null }],
    ['settings, files', { settings: 'files' }, { settings: null }],
    ['settings, help', { settings: 'help' }, { settings: null }],
    ['report dialog', { report: 'bug' }, { report: null }],
    ['measurements', { measurementsOpen: true }, { measurementsOpen: false }],
  ]) {
    await check(`${name}: the close button is clear of everything else`, async () => {
      await setState(on);
      await sleep(350);
      await shot(`08 ${name}`);
      const hits = await closeClear();
      await setState(off);
      await sleep(200);
      expect(hits.length === 0, `it covers ${hits.join(', ')}`);
    });
  }

  /* ── Tab in dialogs ── */
  // The app moves focus itself, so plain Tab reaches every control whatever the webview does with it.
  for (const [name, on, off] of [
    ['room dialog', { roomModal: 'start' }, { roomModal: null }],
    ['settings, appearance', { settings: 'appearance' }, { settings: null }],
    ['settings, help', { settings: 'help' }, { settings: null }],
    ['report dialog', { report: 'bug' }, { report: null }],
  ]) {
    await check(`${name}: Tab stops at every control, in order, and stays inside`, async () => {
      await setState(on);
      await sleep(350);
      const count = await b.exec(() => {
        const root = document.querySelector('[role="dialog"]');
        window.__stops = [...root.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')].filter(
          // In view: a control inside a closed disclosure is not, though it may still have a box.
          (el) => !el.disabled && !(el.getAttribute('tabindex') ?? '').startsWith('-') && el.getClientRects().length > 0 && el.checkVisibility({ visibilityProperty: true }),
        );
        return window.__stops.length;
      });
      const at = () => b.exec(() => window.__stops.indexOf(document.activeElement));
      const start = await at();
      const seen = [];
      for (let i = 0; i < count; i++) {
        await b.keys('');
        seen.push(await at());
      }
      await setState(off);
      await sleep(200);
      expect(start >= 0, 'focus did not start on a control of the dialog');
      expect(
        seen.every((v, i) => v === (start + i + 1) % count),
        `from ${start}, Tab went to ${seen.join(', ')} of ${count}`,
      );
    });
  }

  /* ── segment menu and its popovers ── */
  await check('the segment menu is as wide as the row and every item is in reach', async () => {
    await hover(b, '.segrow');
    await clickOn(b, '.segrow button[aria-haspopup="menu"]');
    await sleep(300);
    await shot('09 segment menu');
    const m = await rect(b, '.segrow .menu');
    const row = await rect(b, '.segrow');
    const status = await rect(b, '.status');
    expect(m, 'the menu did not open');
    expect(Math.abs(m.width - row.width) <= 1 && Math.abs(m.x - row.x) <= 1, `menu ${m.x}+${m.width}, row ${row.x}+${row.width}`);
    expect(m.y + m.height <= status.y, 'the menu runs under the status bar');
    await b.exec(() => [...document.querySelectorAll('.segrow .menu [role="menuitem"]')].find((x) => x.textContent.includes('Grow')).click());
    await sleep(300);
    await shot('10 grow form');
    const form = await rect(b, '.segrow .menu.ask');
    expect(form && Math.abs(form.width - row.width) <= 1, 'the amount form is not as wide as the row');
    await b.exec(() => document.querySelector('.menu.ask button.secondary').click());
    await clickOn(b, '.segrow .swatchbtn');
    await sleep(300);
    await shot('11 colour palette');
    const palette = await rect(b, '.segrow .menu.palette');
    expect(palette && Math.abs(palette.width - row.width) <= 1, 'the palette is not as wide as the row');
    await b.keys('');
  });

  /* ── theme ── */
  await check('the theme switches both ways', async () => {
    const surface = () => b.exec(() => getComputedStyle(document.querySelector('header.topbar')).backgroundColor);
    await setState({ settings: 'appearance' });
    await sleep(300);
    await b.exec(() => [...document.querySelectorAll('[role="dialog"] button')].find((x) => /^Light/.test(x.textContent.trim()) || /Light/.test(x.getAttribute('aria-label') ?? '')).click());
    await sleep(300);
    const light = await surface();
    await shot('12 light theme settings');
    await b.exec(() => [...document.querySelectorAll('[role="dialog"] button')].find((x) => /^Dark/.test(x.textContent.trim()) || /Dark/.test(x.getAttribute('aria-label') ?? '')).click());
    await sleep(300);
    const dark = await surface();
    await setState({ settings: null });
    expect(light !== dark, `the top bar is ${light} in both`);
    expect((await b.exec(() => document.documentElement.dataset.theme)) === 'dark', 'the page did not end in the dark theme');
  });
  await b.exec(() => document.documentElement.setAttribute('data-theme', 'light'));
  await sleep(200);
  await shot('13 light theme');
  await b.exec(() => document.documentElement.setAttribute('data-theme', 'dark'));

  /* ── saving (the web build downloads a file; the desktop build needs a real dialog) ── */
  if (!APP) {
    await check('saving writes the mask and clears the unsaved state', async () => {
      expect(await state(b, (s) => s.dirty), 'there is nothing unsaved to save');
      await b.exec(() => {
        // The file picker cannot be driven; a download is what the page falls back to.
        delete window.showSaveFilePicker;
        window.__w.session.saveMask();
      });
      await until(() => state(b, (s) => !s.dirty), Boolean, { timeout: 15_000, what: 'the mask to be saved' });
    });
  }

  /* ── rooms: keys, signatures and encryption have to work in this engine too ── */
  // The desktop app hosts the room itself. The web build needs a room server: W_RELAY=ws://localhost:8787.
  if (APP || RELAY) {
    await check('a room starts, a second person joins with the link and is sent the mask', async () => {
      if (RELAY) await b.exec((server) => window.__w.settings.setSetting('server', server), RELAY);
      await b.exec(() => {
        window.__room = null;
        window.__w.session.startRoom('Mina', 'shared').then((r) => (window.__room = r));
      });
      const started = await until(() => b.exec(() => window.__room), Boolean, { what: 'the room to start' });
      expect(typeof started !== 'string', `the room did not start: ${started}`);
      expect(/^http:\/\/[^/]+\/j\/[A-Z0-9]{12}#[A-Za-z0-9_-]{22}$/.test(started.link), `unexpected invite link ${started.link}`);
      expect((await state(b, (s) => s.room?.status)) === 'online', 'the room is not online');
      await shot('15 room');

      // The second person is a client of its own, run from Node (e2e-desktop/roombot.mjs).
      const bot = await joinRoom(started.link, 'Bot');
      try {
        expect(bot.welcome.roster.length === 2, `expected two members, found ${bot.welcome.roster.length}`);
        const hostId = bot.welcome.roster.find((m) => m.role === 'host').id;
        await until(() => state(b, (s) => s.peers.map((p) => p.name).join()), (names) => names === 'Bot', { what: 'the guest to show up by name' });
        bot.send(KIND.syncRequest, { rid: 1, image: false, fp: null }, undefined, { to: hostId });
        await until(() => bot.frames.some((f) => f.kind === KIND.syncSlab && f.meta.t === 'end'), Boolean, { what: 'the mask to arrive' });
        const mask = assemble(bot.frames, KIND.syncSlab, 1);
        const painted = mask.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
        const here = await maskVoxels(b);
        expect(painted === here, `the guest was sent ${painted} voxels, the app has ${here}`);
      } finally {
        bot.close();
      }
      await until(() => state(b, (s) => s.peers.length), (n) => n === 0, { what: 'the guest to leave' });
      await b.exec(() => window.__w.session.leaveRoom(true));
      expect((await state(b, (s) => s.room)) === null, 'the room is still open');
    });
  }

  await check('nothing logged an error', async () => {
    const errors = await b.exec(() => window.__errors ?? ['errors were not being collected']);
    expect(errors.length === 0, errors.join(' | '));
  });
  await shot('14 end');
} finally {
  await b.quit();
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
