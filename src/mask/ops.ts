/**
 * Whole-segment operations on a labelmap: grow, shrink, smooth, islands,
 * holes, combining two segments, and measurements. Plain geometry, no models.
 *
 * Every function edits one label in place and returns how many voxels it
 * changed. Work is limited to the label's bounding box plus the margin the
 * operation needs, so a small segment in a large scan stays fast.
 */
import { INF, edt1d } from './interpolate';

type Dims = [number, number, number];
type Spacing = ArrayLike<number>;

/** Inclusive voxel bounds. */
interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

function validLabel(label: number): boolean {
  return Number.isInteger(label) && label >= 1 && label <= 255;
}

function boundsOf(mask: Uint8Array, dims: Dims, label: number): Box | null {
  const [nx, ny, nz] = dims;
  let x0 = nx;
  let x1 = -1;
  let y0 = ny;
  let y1 = -1;
  let z0 = nz;
  let z1 = -1;
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      let hit = false;
      for (let x = 0; x < nx; x++, i++) {
        if (mask[i] !== label) continue;
        hit = true;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
      if (!hit) continue;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      z1 = z;
    }
  }
  return x1 < 0 ? null : { x0, y0, z0, x1, y1, z1 };
}

function pad(b: Box, dims: Dims, mx: number, my: number, mz: number): Box {
  return {
    x0: Math.max(0, b.x0 - mx),
    y0: Math.max(0, b.y0 - my),
    z0: Math.max(0, b.z0 - mz),
    x1: Math.min(dims[0] - 1, b.x1 + mx),
    y1: Math.min(dims[1] - 1, b.y1 + my),
    z1: Math.min(dims[2] - 1, b.z1 + mz),
  };
}

/** A box-shaped piece of the volume, as 1 where the label is and 0 elsewhere. */
interface Sub {
  box: Box;
  nx: number;
  ny: number;
  nz: number;
  bin: Uint8Array;
}

/** The box may reach past the volume; that part is read as empty and never written. */
function extract(mask: Uint8Array, dims: Dims, box: Box, label: number): Sub {
  const nx = box.x1 - box.x0 + 1;
  const ny = box.y1 - box.y0 + 1;
  const nz = box.z1 - box.z0 + 1;
  const bin = new Uint8Array(nx * ny * nz);
  eachRow(dims, box, (o, i, len) => {
    for (let x = 0; x < len; x++) if (mask[o + x] === label) bin[i + x] = 1;
  });
  return { box, nx, ny, nz, bin };
}

/** Calls `fn(maskOffset, boxOffset, length)` for the part of each x-row of the box that lies inside the volume. */
function eachRow(dims: Dims, box: Box, fn: (o: number, i: number, len: number) => void): void {
  const nx = box.x1 - box.x0 + 1;
  const ny = box.y1 - box.y0 + 1;
  const xa = Math.max(0, box.x0);
  const len = Math.min(dims[0] - 1, box.x1) - xa + 1;
  for (let z = Math.max(0, box.z0); z <= Math.min(dims[2] - 1, box.z1); z++) {
    for (let y = Math.max(0, box.y0); y <= Math.min(dims[1] - 1, box.y1); y++) {
      fn(xa + (y + z * dims[1]) * dims[0], xa - box.x0 + (y - box.y0 + (z - box.z0) * ny) * nx, len);
    }
  }
}

/**
 * Squared distance in mm² from every voxel to the nearest voxel whose value in
 * `bin` is `want`: three separable passes, one per axis, each scaled by that
 * axis's spacing. Only values up to `cap` are exact; anything further is left
 * larger than `cap`. Lines that cannot change (nothing within reach, or all
 * zero already) are skipped, so the cost follows the surface, not the volume.
 */
function distanceSq(sub: Sub, spacing: Spacing, want: number, cap: number, out: Float32Array): Float32Array {
  const { nx, ny, nz, bin } = sub;
  const sx = spacing[0];
  const sxy = nx * ny;
  const sliceSeeds = new Int32Array(nz);

  // Along x the source is binary, so two sweeps per row are enough.
  for (let row = 0, base = 0; row < ny * nz; row++, base += nx) {
    let last = -1;
    let seeds = 0;
    for (let x = 0; x < nx; x++) {
      const i = base + x;
      if (bin[i] === want) {
        last = x;
        seeds++;
        out[i] = 0;
      } else if (last < 0) {
        out[i] = INF;
      } else {
        const d = (x - last) * sx;
        out[i] = d * d;
      }
    }
    if (seeds === 0 || seeds === nx) {
      if (seeds) sliceSeeds[(row / ny) | 0] += nx;
      continue;
    }
    sliceSeeds[(row / ny) | 0] += seeds;
    let next = -1;
    for (let x = nx - 1; x >= 0; x--) {
      const i = base + x;
      if (bin[i] === want) next = x;
      else if (next >= 0) {
        const d = (next - x) * sx;
        if (d * d < out[i]) out[i] = d * d;
      }
    }
  }

  const n = Math.max(ny, nz);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const zb = new Float64Array(n + 1);

  if (ny > 1) {
    const sy = spacing[1];
    for (let z = 0; z < nz; z++) {
      // Nothing to spread from, or nothing left to reach.
      if (sliceSeeds[z] === 0 || sliceSeeds[z] === sxy) continue;
      for (let x = 0; x < nx; x++) {
        const start = x + z * sxy;
        let near = false;
        let far = false;
        for (let q = 0, i = start; q < ny; q++, i += nx) {
          const value = out[i];
          if (value <= cap) {
            f[q] = value;
            near = true;
            if (value !== 0) far = true;
          } else {
            f[q] = INF;
            far = true;
          }
        }
        if (!near || !far) continue;
        edt1d(f, ny, d, v, zb, sy);
        for (let q = 0, i = start; q < ny; q++, i += nx) out[i] = d[q];
      }
    }
  }

  if (nz > 1) {
    // One x–z sheet at a time, copied out so the walk along z stays in cache.
    const sz = spacing[2];
    const sheet = new Float32Array(nx * nz);
    const near = new Uint8Array(nx);
    const far = new Uint8Array(nx);
    for (let y = 0; y < ny; y++) {
      near.fill(0);
      far.fill(0);
      for (let z = 0; z < nz; z++) {
        const o = y * nx + z * sxy;
        const b = z * nx;
        for (let x = 0; x < nx; x++) {
          const value = out[o + x];
          sheet[b + x] = value;
          if (value <= cap) near[x] = 1;
          if (value !== 0) far[x] = 1;
        }
      }
      let touched = false;
      for (let x = 0; x < nx; x++) {
        if (!near[x] || !far[x]) continue;
        touched = true;
        for (let q = 0, i = x; q < nz; q++, i += nx) {
          const value = sheet[i];
          f[q] = value <= cap ? value : INF;
        }
        edt1d(f, nz, d, v, zb, sz);
        for (let q = 0, i = x; q < nz; q++, i += nx) sheet[i] = d[q];
      }
      if (!touched) continue;
      for (let z = 0; z < nz; z++) out.set(sheet.subarray(z * nx, (z + 1) * nx), y * nx + z * sxy);
    }
  }
  return out;
}

/** Float32 rounding must not push a voxel at exactly `mm` out of reach. */
function reach(mm: number): number {
  return mm * mm * (1 + 1e-5);
}

function margin(mm: number, spacing: Spacing, extra = 0): [number, number, number] {
  return [Math.ceil(mm / spacing[0]) + extra, Math.ceil(mm / spacing[1]) + extra, Math.ceil(mm / spacing[2]) + extra];
}

/** Sets every voxel within `cap` of a set voxel. */
function dilate(sub: Sub, spacing: Spacing, cap: number, scratch: Float32Array): void {
  const d = distanceSq(sub, spacing, 1, cap, scratch);
  const bin = sub.bin;
  for (let i = 0; i < bin.length; i++) if (d[i] <= cap) bin[i] = 1;
}

/** Clears every set voxel within `cap` of an unset one. Beyond the box counts as set. */
function erode(sub: Sub, spacing: Spacing, cap: number, scratch: Float32Array): void {
  const d = distanceSq(sub, spacing, 0, cap, scratch);
  const bin = sub.bin;
  for (let i = 0; i < bin.length; i++) if (d[i] <= cap) bin[i] = 0;
}

/**
 * Writes a worked-on piece back: new voxels only go into empty space and
 * removed ones only leave the label, so other segments are never touched.
 */
function writeBack(mask: Uint8Array, dims: Dims, sub: Sub, label: number): number {
  const bin = sub.bin;
  let changed = 0;
  eachRow(dims, sub.box, (o, i, len) => {
    for (let x = 0; x < len; x++) {
      const cur = mask[o + x];
      if (bin[i + x]) {
        if (cur === 0) {
          mask[o + x] = label;
          changed++;
        }
      } else if (cur === label) {
        mask[o + x] = 0;
        changed++;
      }
    }
  });
  return changed;
}

/**
 * Grows the segment by `mm` in every direction, measured in millimetres so it
 * is even on anisotropic voxels. Only empty voxels are taken.
 */
export function grow(mask: Uint8Array, dims: Dims, spacing: Spacing, label: number, mm: number): number {
  if (!validLabel(label) || !(mm > 0)) return 0;
  const bounds = boundsOf(mask, dims, label);
  if (!bounds) return 0;
  const sub = extract(mask, dims, pad(bounds, dims, ...margin(mm, spacing)), label);
  dilate(sub, spacing, reach(mm), new Float32Array(sub.bin.length));
  return writeBack(mask, dims, sub, label);
}

/**
 * Shrinks the segment by `mm`. Anything that is not the segment counts as
 * outside, except the edge of the volume, which is never shrunk from.
 */
export function shrink(mask: Uint8Array, dims: Dims, spacing: Spacing, label: number, mm: number): number {
  if (!validLabel(label) || !(mm > 0)) return 0;
  const bounds = boundsOf(mask, dims, label);
  if (!bounds) return 0;
  const sub = extract(mask, dims, pad(bounds, dims, 1, 1, 1), label);
  erode(sub, spacing, reach(mm), new Float32Array(sub.bin.length));
  return writeBack(mask, dims, sub, label);
}

/**
 * Smooths the outline: closes gaps and pits narrower than `mm` (grow, then
 * shrink), then removes spikes and specks narrower than `mm` (shrink, then
 * grow). Other segments are never changed.
 */
export function smooth(mask: Uint8Array, dims: Dims, spacing: Spacing, label: number, mm: number): number {
  if (!validLabel(label) || !(mm > 0)) return 0;
  const bounds = boundsOf(mask, dims, label);
  if (!bounds) return 0;
  // The box may reach past the volume. Closing treats that space as empty, so
  // nothing is drawn towards the edge; opening treats it as more of the
  // segment, so a segment cut off by the edge of the scan is not worn away there.
  const [mx, my, mz] = margin(mm, spacing, 1);
  const sub = extract(
    mask,
    dims,
    { x0: bounds.x0 - mx, y0: bounds.y0 - my, z0: bounds.z0 - mz, x1: bounds.x1 + mx, y1: bounds.y1 + my, z1: bounds.z1 + mz },
    label,
  );
  const scratch = new Float32Array(sub.bin.length);
  const cap = reach(mm);
  dilate(sub, spacing, cap, scratch);
  erode(sub, spacing, cap, scratch);
  setBeyond(sub, dims, 1);
  erode(sub, spacing, cap, scratch);
  setBeyond(sub, dims, 0);
  dilate(sub, spacing, cap, scratch);
  return writeBack(mask, dims, sub, label);
}

/** Sets the part of the box that lies outside the volume. */
function setBeyond(sub: Sub, dims: Dims, value: number): void {
  const { box, nx, ny, nz, bin } = sub;
  const before = Math.min(nx, Math.max(0, -box.x0));
  const after = Math.max(0, Math.min(nx, dims[0] - box.x0));
  for (let z = 0; z < nz; z++) {
    const zOut = z + box.z0 < 0 || z + box.z0 >= dims[2];
    for (let y = 0; y < ny; y++) {
      const row = (y + z * ny) * nx;
      if (zOut || y + box.y0 < 0 || y + box.y0 >= dims[1]) bin.fill(value, row, row + nx);
      else {
        bin.fill(value, row, row + before);
        bin.fill(value, row + after, row + nx);
      }
    }
  }
}

/* ───────────────────────── islands and holes ───────────────────────── */

/**
 * Face-connected (6-neighbour) components inside a box, found on runs of
 * voxels along x joined with union-find, so memory follows the number of
 * runs, not voxels.
 */
interface Runs {
  count: number;
  /** Run extents along x, relative to the box; `end` is exclusive. */
  start: Int32Array;
  end: Int32Array;
  /** Component of each run, as the index of its representative run. */
  root: Int32Array;
  /** Index of the first run of each row (y + z · ny), with one extra entry at the end. */
  rowFirst: Int32Array;
}

function find(parent: Int32Array, i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

/** Runs where `(mask === label) === inside`. */
function findRuns(mask: Uint8Array, dims: Dims, box: Box, label: number, inside: boolean): Runs {
  const nx = box.x1 - box.x0 + 1;
  const ny = box.y1 - box.y0 + 1;
  const nz = box.z1 - box.z0 + 1;
  let capacity = Math.max(64, ny * nz * 2);
  let start = new Int32Array(capacity);
  let end = new Int32Array(capacity);
  let parent = new Int32Array(capacity);
  const rowFirst = new Int32Array(ny * nz + 1);
  let count = 0;

  const join = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    let a = aFrom;
    let b = bFrom;
    while (a < aTo && b < bTo) {
      if (start[a] < end[b] && start[b] < end[a]) {
        const ra = find(parent, a);
        const rb = find(parent, b);
        if (ra < rb) parent[rb] = ra;
        else if (rb < ra) parent[ra] = rb;
      }
      if (end[a] < end[b]) a++;
      else b++;
    }
  };

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = y + z * ny;
      rowFirst[row] = count;
      const base = box.x0 + (y + box.y0 + (z + box.z0) * dims[1]) * dims[0];
      let x = 0;
      while (x < nx) {
        if ((mask[base + x] === label) !== inside) {
          x++;
          continue;
        }
        const from = x;
        while (x < nx && (mask[base + x] === label) === inside) x++;
        if (count === capacity) {
          capacity *= 2;
          const grown = (old: Int32Array) => {
            const next = new Int32Array(capacity);
            next.set(old);
            return next;
          };
          start = grown(start);
          end = grown(end);
          parent = grown(parent);
        }
        start[count] = from;
        end[count] = x;
        parent[count] = count;
        count++;
      }
      if (y > 0) join(rowFirst[row - 1], rowFirst[row], rowFirst[row], count);
      if (z > 0) join(rowFirst[row - ny], rowFirst[row - ny + 1], rowFirst[row], count);
    }
  }
  rowFirst[ny * nz] = count;
  for (let i = 0; i < count; i++) parent[i] = find(parent, i);
  return { count, start, end, root: parent, rowFirst };
}

function islandSizes(runs: Runs): Float64Array {
  const sizes = new Float64Array(runs.count);
  for (let i = 0; i < runs.count; i++) sizes[runs.root[i]] += runs.end[i] - runs.start[i];
  return sizes;
}

/** Writes `value` over the runs that `pick` selects, where the voxel holds `from`. */
function paintRuns(mask: Uint8Array, dims: Dims, box: Box, runs: Runs, pick: (root: number) => boolean, from: number, value: number): number {
  const ny = box.y1 - box.y0 + 1;
  const rows = runs.rowFirst.length - 1;
  let changed = 0;
  for (let row = 0; row < rows; row++) {
    const y = row % ny;
    const z = (row - y) / ny;
    const base = box.x0 + (y + box.y0 + (z + box.z0) * dims[1]) * dims[0];
    for (let r = runs.rowFirst[row]; r < runs.rowFirst[row + 1]; r++) {
      if (!pick(runs.root[r])) continue;
      for (let o = base + runs.start[r]; o < base + runs.end[r]; o++) {
        if (mask[o] === from) {
          mask[o] = value;
          changed++;
        }
      }
    }
  }
  return changed;
}

/** Removes every island of the segment except the largest. Islands joined only at an edge or corner are separate. */
export function keepLargestIsland(mask: Uint8Array, dims: Dims, label: number): number {
  if (!validLabel(label)) return 0;
  const box = boundsOf(mask, dims, label);
  if (!box) return 0;
  const runs = findRuns(mask, dims, box, label, true);
  const sizes = islandSizes(runs);
  let best = 0;
  for (let i = 1; i < runs.count; i++) if (sizes[i] > sizes[best]) best = i;
  return paintRuns(mask, dims, box, runs, (root) => root !== best, label, 0);
}

/** Removes islands of the segment whose volume is under `minMm3` cubic millimetres. */
export function removeSmallIslands(mask: Uint8Array, dims: Dims, spacing: Spacing, label: number, minMm3: number): number {
  if (!validLabel(label) || !(minMm3 > 0)) return 0;
  const box = boundsOf(mask, dims, label);
  if (!box) return 0;
  const runs = findRuns(mask, dims, box, label, true);
  const sizes = islandSizes(runs);
  const voxel = spacing[0] * spacing[1] * spacing[2];
  return paintRuns(mask, dims, box, runs, (root) => sizes[root] * voxel < minMm3, label, 0);
}

/** How many islands the segment is made of. Islands joined only at an edge or corner are separate. */
export function countIslands(mask: Uint8Array, dims: Dims, label: number): number {
  if (!validLabel(label)) return 0;
  const box = boundsOf(mask, dims, label);
  if (!box) return 0;
  const runs = findRuns(mask, dims, box, label, true);
  let n = 0;
  for (let i = 0; i < runs.count; i++) if (runs.root[i] === i) n++;
  return n;
}

/**
 * Acts on the island of the segment that holds voxel `seed`: `remove` takes that
 * island away, `keep` takes away every other island of the segment. Nothing
 * happens when the voxel is not part of the segment.
 */
export function islandAt(mask: Uint8Array, dims: Dims, label: number, seed: ArrayLike<number>, action: 'remove' | 'keep'): number {
  if (!validLabel(label)) return 0;
  const [x, y, z] = [seed[0], seed[1], seed[2]];
  if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return 0;
  if (mask[x + (y + z * dims[1]) * dims[0]] !== label) return 0;
  const box = boundsOf(mask, dims, label);
  if (!box) return 0;
  const runs = findRuns(mask, dims, box, label, true);
  const row = y - box.y0 + (z - box.z0) * (box.y1 - box.y0 + 1);
  let clicked = -1;
  for (let r = runs.rowFirst[row]; r < runs.rowFirst[row + 1]; r++) {
    if (x - box.x0 >= runs.start[r] && x - box.x0 < runs.end[r]) clicked = runs.root[r];
  }
  if (clicked < 0) return 0;
  return paintRuns(mask, dims, box, runs, (root) => (root === clicked) === (action === 'remove'), label, 0);
}

/**
 * Gives each island of the segment except the largest a label of its own, taken
 * in order from `labels`, largest island first. Islands left over when the
 * labels run out stay in the segment; `left` says how many.
 */
export function splitIslands(mask: Uint8Array, dims: Dims, label: number, labels: number[]): { changed: number; labels: number[]; left: number } {
  const none = { changed: 0, labels: [], left: 0 };
  if (!validLabel(label)) return none;
  const box = boundsOf(mask, dims, label);
  if (!box) return none;
  const runs = findRuns(mask, dims, box, label, true);
  const sizes = islandSizes(runs);
  const roots: number[] = [];
  for (let i = 0; i < runs.count; i++) if (runs.root[i] === i) roots.push(i);
  // Largest first; islands of the same size keep the order they are met in.
  roots.sort((a, b) => sizes[b] - sizes[a] || a - b);
  const rest = roots.slice(1);
  const used = labels.filter((v) => validLabel(v) && v !== label).slice(0, rest.length);
  const to = new Map<number, number>();
  used.forEach((value, n) => to.set(rest[n], value));
  let changed = 0;
  for (const [root, value] of to) changed += paintRuns(mask, dims, box, runs, (r) => r === root, label, value);
  return { changed, labels: used, left: rest.length - used.length };
}

/**
 * Fills cavities: space that is fully enclosed by the segment in 3D and has
 * no path to the edge of the volume. Another segment inside a cavity is kept.
 */
export function fillHoles(mask: Uint8Array, dims: Dims, label: number): number {
  if (!validLabel(label)) return 0;
  const bounds = boundsOf(mask, dims, label);
  if (!bounds) return 0;
  // One voxel of margin is all outside, or the edge of the volume, which counts as outside too.
  const box = pad(bounds, dims, 1, 1, 1);
  const nx = box.x1 - box.x0 + 1;
  const ny = box.y1 - box.y0 + 1;
  const nz = box.z1 - box.z0 + 1;
  const runs = findRuns(mask, dims, box, label, false);
  const open = new Uint8Array(runs.count);
  for (let row = 0; row < ny * nz; row++) {
    const y = row % ny;
    const z = (row - y) / ny;
    const edgeRow = y === 0 || y === ny - 1 || z === 0 || z === nz - 1;
    for (let r = runs.rowFirst[row]; r < runs.rowFirst[row + 1]; r++) {
      if (edgeRow || runs.start[r] === 0 || runs.end[r] === nx) open[runs.root[r]] = 1;
    }
  }
  return paintRuns(mask, dims, box, runs, (root) => open[root] === 0, 0, label);
}

/** Fills holes on each slice along `axis` on its own: areas the segment encloses within that slice. */
export function fillHolesPerSlice(mask: Uint8Array, dims: Dims, label: number, axis: 0 | 1 | 2): number {
  if (!validLabel(label)) return 0;
  const bounds = boundsOf(mask, dims, label);
  if (!bounds) return 0;
  const box = pad(bounds, dims, 1, 1, 1);
  const lo = [box.x0, box.y0, box.z0];
  const hi = [box.x1, box.y1, box.z1];
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const stride = [1, dims[0], dims[0] * dims[1]];
  const w = hi[u] - lo[u] + 1;
  const h = hi[v] - lo[v] + 1;
  // 0 not the segment, 1 the segment, 2 reached from the edge of the slice.
  const plane = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let changed = 0;
  // The margin slices cannot hold the label, so only the label's own slices are looked at.
  const bLo = [bounds.x0, bounds.y0, bounds.z0][axis];
  const bHi = [bounds.x1, bounds.y1, bounds.z1][axis];
  for (let s = bLo; s <= bHi; s++) {
    const origin = lo[u] * stride[u] + lo[v] * stride[v] + s * stride[axis];
    let any = false;
    for (let b = 0; b < h; b++) {
      for (let a = 0, o = origin + b * stride[v]; a < w; a++, o += stride[u]) {
        const on = mask[o] === label ? 1 : 0;
        plane[a + b * w] = on;
        if (on) any = true;
      }
    }
    if (!any) continue;
    let top = 0;
    const seed = (p: number) => {
      if (plane[p] === 0) {
        plane[p] = 2;
        stack[top++] = p;
      }
    };
    for (let a = 0; a < w; a++) {
      seed(a);
      seed(a + (h - 1) * w);
    }
    for (let b = 0; b < h; b++) {
      seed(b * w);
      seed(w - 1 + b * w);
    }
    while (top > 0) {
      const p = stack[--top];
      const a = p % w;
      if (a > 0) seed(p - 1);
      if (a < w - 1) seed(p + 1);
      if (p >= w) seed(p - w);
      if (p < w * (h - 1)) seed(p + w);
    }
    for (let b = 0; b < h; b++) {
      for (let a = 0, o = origin + b * stride[v]; a < w; a++, o += stride[u]) {
        if (plane[a + b * w] === 0 && mask[o] === 0) {
          mask[o] = label;
          changed++;
        }
      }
    }
  }
  return changed;
}

/* ───────────────────────── combining ───────────────────────── */

export type CombineOp = 'union' | 'subtract' | 'intersect';

/**
 * Combines segment `other` into `target`. A labelmap holds one segment per
 * voxel, so two segments never overlap: `union` moves the other segment's
 * voxels into the target, `subtract` has nothing to remove, and `intersect`
 * leaves the target empty.
 */
export function combine(mask: Uint8Array, target: number, other: number, op: CombineOp): number {
  if (!validLabel(target) || !validLabel(other) || target === other || op === 'subtract') return 0;
  const from = op === 'union' ? other : target;
  const to = op === 'union' ? target : 0;
  let changed = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === from) {
      mask[i] = to;
      changed++;
    }
  }
  return changed;
}

/* ───────────────────────── measurements ───────────────────────── */

export interface SegmentStats {
  label: number;
  voxels: number;
  volumeMl: number;
  /** Image values inside the segment. NaN when there is no image. */
  mean: number;
  sd: number;
  min: number;
  max: number;
  /** Centre of the bounding box, as a voxel index. */
  centre: [number, number, number];
}

/** Measures every segment in one pass over the mask. */
export function segmentStats(mask: Uint8Array, image: ArrayLike<number> | null, dims: Dims, spacing: Spacing): SegmentStats[] {
  const [nx, ny, nz] = dims;
  const count = new Float64Array(256);
  const sum = new Float64Array(256);
  const sumSq = new Float64Array(256);
  const min = new Float64Array(256).fill(Infinity);
  const max = new Float64Array(256).fill(-Infinity);
  const lo = [new Int32Array(256).fill(nx), new Int32Array(256).fill(ny), new Int32Array(256).fill(nz)];
  const hi = [new Int32Array(256).fill(-1), new Int32Array(256).fill(-1), new Int32Array(256).fill(-1)];
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const l = mask[i];
        if (l === 0) continue;
        count[l]++;
        if (x < lo[0][l]) lo[0][l] = x;
        if (x > hi[0][l]) hi[0][l] = x;
        if (y < lo[1][l]) lo[1][l] = y;
        if (y > hi[1][l]) hi[1][l] = y;
        if (z < lo[2][l]) lo[2][l] = z;
        hi[2][l] = z;
        if (image) {
          const value = image[i];
          sum[l] += value;
          sumSq[l] += value * value;
          if (value < min[l]) min[l] = value;
          if (value > max[l]) max[l] = value;
        }
      }
    }
  }
  const voxelMl = (spacing[0] * spacing[1] * spacing[2]) / 1000;
  const out: SegmentStats[] = [];
  for (let l = 1; l < 256; l++) {
    const n = count[l];
    if (n === 0) continue;
    const mean = image ? sum[l] / n : NaN;
    out.push({
      label: l,
      voxels: n,
      volumeMl: n * voxelMl,
      mean,
      sd: image ? Math.sqrt(Math.max(0, sumSq[l] / n - mean * mean)) : NaN,
      min: image ? min[l] : NaN,
      max: image ? max[l] : NaN,
      centre: [(lo[0][l] + hi[0][l]) / 2, (lo[1][l] + hi[1][l]) / 2, (lo[2][l] + hi[2][l]) / 2],
    });
  }
  return out;
}

/** "12.4 mL", or cubic millimetres for anything under half a millilitre. Empty for nothing. */
export function formatVolume(ml: number): string {
  if (!(ml > 0)) return '';
  if (ml < 0.5) return `${Math.max(1, Math.round(ml * 1000)).toLocaleString('en-US')} mm³`;
  if (ml >= 100) return `${Math.round(ml).toLocaleString('en-US')} mL`;
  return `${ml.toFixed(1)} mL`;
}

/** How much `voxels` voxels of the given size are, as `formatVolume` writes it. */
export function formatVoxels(voxels: number, spacing: ArrayLike<number>): string {
  return formatVolume((voxels * spacing[0] * spacing[1] * spacing[2]) / 1000);
}

/** A measured value with at most `digits` decimals and no trailing zeros. */
export function formatValue(value: number, digits = 2): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '';
}

export function statsCsv(stats: SegmentStats[], nameOf: (label: number) => string): string {
  const quote = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const rows = stats.map((s) =>
    [quote(nameOf(s.label)), s.label, formatValue(s.volumeMl, 3), s.voxels, formatValue(s.mean), formatValue(s.sd), formatValue(s.min), formatValue(s.max)].join(','),
  );
  return ['Segment,Label,Volume (mL),Voxels,Mean,SD,Min,Max', ...rows].join('\n');
}
