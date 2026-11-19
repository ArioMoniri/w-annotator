/**
 * Builds the sample the welcome tour opens: one public chest CT with its lung
 * mask, cropped and downsampled so it is small enough to ship.
 *
 *   node scripts/make-sample.mjs [folder with the LUNA16 download]   (default /tmp/realdata/luna16)
 *
 * Source: LUNA16, https://luna16.grand-challenge.org/Data/ (CC BY 4.0), a subset
 * of LIDC-IDRI, https://www.cancerimagingarchive.net/collection/lidc-idri/ (CC BY 3.0).
 *
 *   Image: https://zenodo.org/api/records/3723295/files/subset0.zip/content
 *            subset0/<SERIES>.mhd and .raw
 *   Mask:  https://zenodo.org/api/records/3723295/files/seg-lungs-LUNA16.zip/content
 *            seg-lungs-LUNA16/<SERIES>.mhd and .zraw
 *
 * One case can be read out of those zips without downloading them whole:
 *
 *   pip install remotezip
 *   python -c "from remotezip import RemoteZip as Z; \
 *     Z('<zip url>').extractall('<folder>', ['subset0/<SERIES>.mhd', 'subset0/<SERIES>.raw'])"
 *
 * What is done to the data, and nothing else:
 *   1. crop in-plane to the body (the largest connected piece above -500 HU, so the
 *      scanner table is left out) plus a margin; all slices are kept;
 *   2. halve the in-plane resolution: the image by the mean of each 2 x 2 block,
 *      the mask by the most common label in it; slice spacing is unchanged;
 *   3. renumber the mask labels 3, 4, 5 to 1, 2, 3 and name them.
 *
 * Files are read and written with the app's own code in src/io, so segment
 * names are stored the way the app reads them back. The output carries no
 * series identifier: not in a file name and not in a header.
 */
import { gzipSync } from 'fflate';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const SERIES = '1.3.6.1.4.1.14519.5.2.1.6279.6001.105756658031515062000744821260';
const BODY_HU = -500;
const MARGIN = 2; // source voxels around the body
const SOURCE_LABELS = { 3: 'Left lung', 4: 'Right lung', 5: 'Airways' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? '/tmp/realdata/luna16');
const out = join(root, 'public', 'sample');

// The app's readers and writers are TypeScript; Vite loads them for Node.
const vite = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const io = await vite.ssrLoadModule('/src/io/index.ts');

function read(folder, ext) {
  const dir = join(source, folder);
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(SERIES))
    .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) }));
  if (!files.some((f) => f.name.endsWith(ext))) throw new Error(`${dir} has no ${SERIES}${ext}`);
  return io.readVolume(files);
}

const image = read('subset0', '.raw');
const lungs = read('seg-lungs-LUNA16', '.zraw');
if (!io.sameGrid(image, lungs)) throw new Error('The image and the mask are not on the same grid.');
if (!(image.data instanceof Int16Array)) throw new Error('Expected an int16 image.');
const [nx, ny, nz] = image.dims;
const d = image.direction;
if (d.some((v, i) => v !== (i % 4 === 0 ? 1 : 0))) throw new Error('Expected an axis-aligned LPS volume.');

// 1. The body is the largest connected piece above the threshold, which leaves out the
// scanner table. Its in-plane bounding box is widened by the margin and to an even size.
const piece = new Int32Array(nx * ny * nz); // 0 = not visited or not body
const queue = new Int32Array(nx * ny * nz);
let body = 0;
let bodySize = 0;
for (let start = 0, id = 0; start < piece.length; start++) {
  if (piece[start] !== 0 || image.data[start] <= BODY_HU) continue;
  id++;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  piece[start] = id;
  while (head < tail) {
    const at = queue[head++];
    const x = at % nx;
    const y = Math.floor(at / nx) % ny;
    const z = Math.floor(at / (nx * ny));
    const visit = (ok, next) => {
      if (!ok || piece[next] !== 0 || image.data[next] <= BODY_HU) return;
      piece[next] = id;
      queue[tail++] = next;
    };
    visit(x > 0, at - 1);
    visit(x < nx - 1, at + 1);
    visit(y > 0, at - nx);
    visit(y < ny - 1, at + nx);
    visit(z > 0, at - nx * ny);
    visit(z < nz - 1, at + nx * ny);
  }
  if (tail > bodySize) {
    bodySize = tail;
    body = id;
  }
}
let x0 = nx, x1 = -1, y0 = ny, y1 = -1;
for (let z = 0; z < nz; z++)
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      if (piece[(z * ny + y) * nx + x] === body) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
const even = (lo, hi, n) => {
  lo = Math.max(0, lo - MARGIN);
  hi = Math.min(n - 1, hi + MARGIN);
  if ((hi - lo + 1) % 2) hi < n - 1 ? hi++ : lo--;
  return [lo, hi];
};
[x0, x1] = even(x0, x1, nx);
[y0, y1] = even(y0, y1, ny);

// 2. Halve in-plane.
const dims = [(x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2, nz];
const count = dims[0] * dims[1] * dims[2];
const ct = new Int16Array(count);
const mask = new Uint8Array(count);
const renumber = Object.fromEntries(Object.keys(SOURCE_LABELS).map((v, i) => [v, i + 1]));
const votes = new Uint8Array(4);
for (let z = 0; z < nz; z++)
  for (let y = 0; y < dims[1]; y++)
    for (let x = 0; x < dims[0]; x++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const at = (z * ny + y0 + 2 * y + (k >> 1)) * nx + x0 + 2 * x + (k & 1);
        sum += image.data[at];
        const value = lungs.data[at];
        if (value !== 0 && !(value in renumber)) throw new Error(`Unexpected mask label ${value}.`);
        votes[k] = renumber[value] ?? 0;
      }
      // The most common label of the four; on a tie, the first of the tied ones in the block.
      let best = votes[0];
      let bestCount = 0;
      for (let k = 0; k < 4; k++) {
        let c = 0;
        for (let m = 0; m < 4; m++) if (votes[m] === votes[k]) c++;
        if (c > bestCount) {
          bestCount = c;
          best = votes[k];
        }
      }
      const to = (z * dims[1] + y) * dims[0] + x;
      ct[to] = Math.round(sum / 4);
      mask[to] = best;
    }

// The centre of the first 2 x 2 block is half a source voxel in from the crop corner.
const spacing = [image.spacing[0] * 2, image.spacing[1] * 2, image.spacing[2]];
const origin = [image.origin[0] + (x0 + 0.5) * image.spacing[0], image.origin[1] + (y0 + 0.5) * image.spacing[1], image.origin[2]];
const grid = { dims, spacing, origin, direction: d };

// 3. Names. Check laterality rather than trust the numbers: in LPS, x grows towards the patient's left.
const labels = Object.fromEntries(Object.entries(SOURCE_LABELS).map(([v, name]) => [renumber[v], name]));
const meanX = (label) => {
  let sum = 0, n = 0;
  for (let i = 0; i < count; i++) if (mask[i] === label) (sum += i % dims[0]), n++;
  return sum / n;
};
if (!(meanX(1) > meanX(2))) throw new Error('The label named "Left lung" is not on the patient\'s left.');

const plain = {
  'chest_ct.nii.gz': io.writeVolume({ ...grid, name: 'chest_ct', data: ct }, 'nii'),
  'lungs.nii.gz': io.writeVolume({ ...grid, name: 'lungs', data: mask, labels }, 'nii'),
};
mkdirSync(out, { recursive: true });
let total = 0;
for (const [name, nii] of Object.entries(plain)) {
  // The header must not say which scan this is.
  const header = new TextDecoder('latin1').decode(nii.subarray(0, nii.length - count * (name === 'lungs.nii.gz' ? 1 : 2)));
  if (/\d+\.\d+\.\d+\.\d+/.test(header) || header.includes(SERIES)) throw new Error(`${name} carries an identifier.`);
  const bytes = gzipSync(nii, { level: 9, mtime: 0 });
  writeFileSync(join(out, name), bytes);
  total += bytes.length;
  console.log(`${name}  ${bytes.length} bytes`);
}
console.log(`crop x ${x0}..${x1}, y ${y0}..${y1} of ${nx} x ${ny}`);
console.log(`dims ${dims.join(' x ')}, spacing ${spacing.map((s) => s.toFixed(4)).join(' x ')} mm, total ${total} bytes`);
await vite.close();
