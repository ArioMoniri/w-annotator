// Turns a recording made by scripts/record.cjs (JPEG frames + manifest.json) into what the composition reads:
// public/footage-a.mp4, public/footage-b.mp4 and src/track.json.
// usage: node scripts/build-footage.cjs <recording dir>
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const rec = path.resolve(process.argv[2] || 'out/rec'); const root = path.resolve(__dirname, '..');
const SPEED = +(process.env.SPEED || 1); // the session is recorded at the pace it is shown
const man = JSON.parse(fs.readFileSync(rec + '/manifest.json', 'utf8'));
const F = []; for (let t = 0; Math.round(t) < man.frames.length; t += SPEED) F.push(man.frames[Math.round(t)]);
const n = F.length;
const seq = (key, frames, out) => {
  const dir = path.join(rec, 'seq-' + key); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  frames.forEach((id, i) => fs.symlinkSync(path.join(rec, `${key.toUpperCase()}${String(Math.max(id, 0)).padStart(4, '0')}.jpg`), path.join(dir, String(i).padStart(5, '0') + '.jpg')));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', dir + '/%05d.jpg', '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.CRF || '20', '-g', '15', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', out], { stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
};
fs.mkdirSync(root + '/public', { recursive: true });
seq('a', F.map(f => f.a), root + '/public/footage-a.mp4');
const d0 = F.findIndex(f => f.d), d1 = d0 < 0 ? -1 : n - [...F].reverse().findIndex(f => f.d);
if (d0 >= 0) seq('b', F.slice(d0, d1).map(f => f.b), root + '/public/footage-b.mp4');
// scenes
const scenes = []; F.forEach((f, i) => { const last = scenes[scenes.length - 1]; if (last && last[0] === f.s) last[2] = i + 1; else scenes.push([f.s, i, i + 1]); });
// Camera: the recorder only states where the view should be. Move there a little early and ease in and out;
// two passes of an 11-frame average make a move of about 0.4 s. A change of window layout is a cut, not a move.
const LEAD = 7, WIN = 5;
const cut = (i, j) => F[i].d !== F[j].d;
const smooth = (key) => { let t = F.map((f, i) => { const j = Math.min(n - 1, i + LEAD); return (cut(i, j) ? f : F[j])[key]; });
  for (let pass = 0; pass < 2; pass++) t = t.map((_, i) => [0, 1, 2].map(c => { let s = 0, m = 0; for (let j = -WIN; j <= WIN; j++) { const q = i + j; if (q < 0 || q >= n || cut(i, q)) continue; s += t[q][c]; m++; } return s / m; }));
  return t.map(v => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 10) / 10, Math.round(v[2] * 10) / 10]); };
const track = { w: man.w, h: man.h, n, scenes, dual: d0 >= 0 ? [d0, d1] : null, a: F.map(f => f.ac), b: F.map(f => f.bc), az: smooth('az'), bz: smooth('bz'),
  slice: F.map(f => f.sl), key: F.map(f => f.k), drop: F.map(f => f.dp) };
fs.writeFileSync(root + '/src/track.json', JSON.stringify(track));
console.log('frames', n, 'scenes', JSON.stringify(scenes), 'dual', d0, d1);
for (const f of ['footage-a.mp4', 'footage-b.mp4']) if (fs.existsSync(root + '/public/' + f)) console.log(f, fs.statSync(root + '/public/' + f).size);
