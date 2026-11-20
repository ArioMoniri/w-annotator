// usage: node video/scripts/slides-build.cjs   (after slides-shoot.cjs; needs ffmpeg)
// Lays out the README slideshow from the screenshots in video/out/slides and writes docs/assets/features.webp:
// 960 x 600, five slides of 2.8 s, a short fade through the background between them.
// Each slide is the picture (960 x 540) with a caption bar under it, so no text sits on the image.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..'); const SRC = process.env.SRC || root + '/out/slides'; const TMP = SRC + '/frames';
const OUT = process.env.OUT || path.resolve(root, '../docs/assets/features.webp');
const HOLD = 2800, STEP = 40, DARK = 80; // ms, multiples of 40
const FADE = [0.4, 0.75]; // how far the slide has faded on the two frames either side of the dark one
const font = 'file://' + root + '/node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2';
const img = (name) => 'file://' + SRC + '/' + name + '.png';

// kind: full = the whole window; crop = part of it, in CSS pixels of the 1152 x 648 window; split = two themes of one window;
// pair = the same close-up before and after.
const SLIDES = [
  { caption: 'Correct the same mask together, live', kind: 'full', a: 'room' },
  { caption: 'Paint three slices. Fill the rest.', kind: 'pair', a: 'fill-before-coronal', b: 'fill-after-coronal', labels: ['Painted on three slices', 'Filled between them'] },
  { caption: 'Grow, shrink, smooth, measure', kind: 'crop', a: 'refine-form', rect: [406, 0, 746, 419.6] },
  { caption: 'MHA, NIfTI, NRRD, DICOM — any image, any mask', kind: 'full', a: 'views-dark' },
  { caption: 'Light or dark', kind: 'split', a: 'views-dark', b: 'views-light' },
];

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url("${font}") format("woff2-variations"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 960px; height: 600px; background: #0E1014; overflow: hidden; font-family: Inter, sans-serif; font-optical-sizing: auto; -webkit-font-smoothing: antialiased; }
#pic { position: absolute; left: 0; top: 0; width: 960px; height: 540px; overflow: hidden; background: #000; }
#pic .layer { position: absolute; top: 0; height: 540px; overflow: hidden; }
#pic img { position: absolute; display: block; max-width: none; }
.tag { position: absolute; left: 14px; bottom: 14px; padding: 5px 10px 6px; border-radius: 6px; background: rgba(14,16,20,0.82); box-shadow: 0 0 0 1px rgba(255,255,255,0.10); color: #E5E7EB; font-weight: 500; font-size: 13px; line-height: 16px; letter-spacing: -0.003em; }
.rule { position: absolute; top: 0; width: 2px; height: 540px; background: #0E1014; }
#bar { position: absolute; left: 0; top: 540px; width: 960px; height: 60px; background: #14161B; box-shadow: inset 0 1px 0 rgba(255,255,255,0.07); }
#cap { position: absolute; left: 24px; top: 0; line-height: 60px; color: #F3F4F6; font-weight: 500; font-size: 19px; letter-spacing: -0.012em; white-space: nowrap; }
#veil { position: absolute; left: 0; top: 0; width: 960px; height: 600px; background: #0E1014; opacity: 0; }
#veil.bar { top: 0; }
#dots { position: absolute; right: 24px; top: 540px; height: 60px; display: flex; align-items: center; gap: 7px; }
#dots i { width: 6px; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.22); }
#dots i.on { width: 20px; background: #E69F00; }
</style><div id="pic"></div><div id="bar"><div id="cap"></div></div><div id="veil"></div><div id="dots"></div>
<script>
const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('missing ' + src)); i.src = src; });
// place the CSS-pixel rectangle r of a screenshot of a win-wide window into a box w wide at x
function place(pic, image, win, r, x, w) {
  const layer = document.createElement('div'); layer.className = 'layer'; layer.style.left = x + 'px'; layer.style.width = w + 'px';
  const k = w / r[2]; image.style.width = win * k + 'px'; image.style.left = -r[0] * k + 'px'; image.style.top = -r[1] * k + 'px';
  layer.appendChild(image); pic.appendChild(layer); return layer;
}
// the middle of what differs between two screenshots, in CSS pixels of the window
function changed(a, b, win) {
  const w = 576, h = Math.round(w * a.naturalHeight / a.naturalWidth); const px = [a, b].map((i) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(i, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; });
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 40; y < h - 20; y++) for (let x = 24; x < 440; x++) { const o = (y * w + x) * 4; if (Math.abs(px[0][o] - px[1][o]) + Math.abs(px[0][o + 2] - px[1][o + 2]) > 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  const k = win / w; return [((x0 + x1) / 2) * k, ((y0 + y1) / 2) * k];
}
window.show = async (s, index, count, files) => {
  const WIN = 1152; const pic = document.getElementById('pic'); pic.innerHTML = '';
  const a = await load(files.a); const b = files.b ? await load(files.b) : null;
  if (s.kind === 'full') place(pic, a, WIN, [0, 0, WIN, 648], 0, 960);
  if (s.kind === 'crop') place(pic, a, WIN, s.rect, 0, 960);
  if (s.kind === 'split') { place(pic, a, WIN, [0, 0, WIN / 2, 648], 0, 480); place(pic, b, WIN, [WIN / 2, 0, WIN / 2, 648], 480, 480); }
  if (s.kind === 'pair') {
    const [cx, cy] = changed(a, b, WIN); const w = 400, h = w * 540 / 479; const r = [cx - w / 2, cy - h / 2, w, h];
    [a, b].forEach((image, i) => { const layer = place(pic, image, WIN, r, i * 481, 479); const tag = document.createElement('div'); tag.className = 'tag'; tag.textContent = s.labels[i]; layer.appendChild(tag); });
    const rule = document.createElement('div'); rule.className = 'rule'; rule.style.left = '479px'; pic.appendChild(rule);
  }
  document.getElementById('cap').textContent = s.caption;
  document.getElementById('dots').innerHTML = Array.from({ length: count }, (_, i) => '<i' + (i === index ? ' class="on"' : '') + '></i>').join('');
  await document.fonts.load('500 19px Inter'); if (!document.fonts.check('500 19px Inter')) throw new Error('Inter did not load');
  await Promise.all([...document.images].map((i) => i.decode()));
};
window.veil = (o) => { document.getElementById('veil').style.opacity = o; };
</script>`;

(async () => {
  fs.mkdirSync(TMP, { recursive: true }); fs.writeFileSync(SRC + '/compose.html', html);
  const br = await chromium.launch({ args: ['--allow-file-access-from-files'] }); const pg = await br.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
  pg.on('pageerror', (e) => { console.error('PAGEERR', e.message); process.exitCode = 1; });
  await pg.goto('file://' + SRC + '/compose.html');
  const list = []; let n = 0;
  const snap = async (ms) => { const f = `${TMP}/f${String(n++).padStart(3, '0')}.png`; await pg.screenshot({ path: f }); list.push([f, ms]); };
  for (let i = 0; i < SLIDES.length; i++) {
    const s = SLIDES[i];
    await pg.evaluate(([s, i, c, files]) => window.show(s, i, c, files), [s, i, SLIDES.length, { a: img(s.a), b: s.b ? img(s.b) : null }]);
    for (const o of [...FADE].reverse()) { await pg.evaluate((o) => window.veil(o), o); await snap(STEP); } // in
    await pg.evaluate(() => window.veil(0)); await snap(HOLD); fs.copyFileSync(list[list.length - 1][0], `${SRC}/slide-${i + 1}.png`);
    for (const o of FADE) { await pg.evaluate((o) => window.veil(o), o); await snap(STEP); } // out
    await pg.evaluate(() => window.veil(1)); await snap(DARK);
  }
  await br.close();
  // start on the first slide at rest, so a viewer that shows only the first frame shows a whole slide
  const order = [...list.slice(FADE.length), ...list.slice(0, FADE.length)];
  // A constant 25 fps sequence with every frame repeated for as long as it shows; the encoder merges the repeats.
  const seq = TMP + '/seq'; fs.rmSync(seq, { recursive: true, force: true }); fs.mkdirSync(seq); let k = 0;
  for (const [f, ms] of order) for (let i = 0; i < Math.round(ms / 40); i++) fs.symlinkSync(f, `${seq}/${String(k++).padStart(4, '0')}.png`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '25', '-i', seq + '/%04d.png', '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', process.env.Q || '82', '-compression_level', '6', '-loop', '0', '-an', OUT], { stdio: 'inherit' });
  fs.rmSync(seq, { recursive: true, force: true });
  console.log(OUT, fs.statSync(OUT).size, 'bytes,', order.length, 'frames,', order.reduce((t, [, ms]) => t + ms, 0) / 1000, 's');
})().catch((e) => { console.error(e); process.exit(1); });
