import type { ScalarArray, VolumeData } from './types';
import { IoError } from './util';

/** World position (LPS, mm) of the voxel index (i, j, k). */
function world(v: VolumeData, i: number, j: number, k: number, out: number[]): void {
  const d = v.direction;
  const a = i * v.spacing[0];
  const b = j * v.spacing[1];
  const c = k * v.spacing[2];
  out[0] = v.origin[0] + a * d[0] + b * d[3] + c * d[6];
  out[1] = v.origin[1] + a * d[1] + b * d[4] + c * d[7];
  out[2] = v.origin[2] + a * d[2] + b * d[5] + c * d[8];
}

/**
 * True when both volumes have the same dims and their voxels sit at the same
 * world positions: no corner voxel is more than `tolMm` apart on any axis.
 */
export function sameGrid(a: VolumeData, b: VolumeData, tolMm = 0.01): boolean {
  for (let n = 0; n < 3; n++) if (a.dims[n] !== b.dims[n]) return false;
  // Step at least one voxel along each axis so that spacing is compared even for a single slice.
  const e = [Math.max(a.dims[0] - 1, 1), Math.max(a.dims[1] - 1, 1), Math.max(a.dims[2] - 1, 1)];
  const pa = [0, 0, 0];
  const pb = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    const i = c & 1 ? e[0] : 0;
    const j = c & 2 ? e[1] : 0;
    const k = c & 4 ? e[2] : 0;
    world(a, i, j, k, pa);
    world(b, i, j, k, pb);
    for (let n = 0; n < 3; n++) if (!(Math.abs(pa[n] - pb[n]) <= tolMm)) return false;
  }
  return true;
}

function emptyLike(data: ScalarArray, length: number): ScalarArray {
  return new (data.constructor as new (n: number) => ScalarArray)(length);
}

/** Nearest-neighbour resample of `source` onto the grid of `target`. Voxels outside `source` are 0. */
export function resampleNearest(source: VolumeData, target: VolumeData): VolumeData {
  const [tx, ty, tz] = target.dims;
  const [sx, sy, sz] = source.dims;
  const out = emptyLike(source.data, tx * ty * tz);
  const result: VolumeData = {
    name: source.name,
    dims: [tx, ty, tz],
    spacing: [target.spacing[0], target.spacing[1], target.spacing[2]],
    origin: [target.origin[0], target.origin[1], target.origin[2]],
    direction: target.direction.slice(),
    data: out,
  };
  if (source.labels) result.labels = { ...source.labels };

  // Source index -> world matrix S (columns are the voxel steps), inverted.
  const sd = source.direction;
  const ss = source.spacing;
  const a = sd[0] * ss[0], b = sd[3] * ss[1], c = sd[6] * ss[2];
  const d = sd[1] * ss[0], e = sd[4] * ss[1], f = sd[7] * ss[2];
  const g = sd[2] * ss[0], h = sd[5] * ss[1], i9 = sd[8] * ss[2];
  const det = a * (e * i9 - f * h) - b * (d * i9 - f * g) + c * (d * h - e * g);
  if (!(Math.abs(det) > 0)) throw new IoError('This image has an invalid orientation and cannot be resampled.');
  const inv = [
    (e * i9 - f * h) / det, (c * h - b * i9) / det, (b * f - c * e) / det,
    (f * g - d * i9) / det, (a * i9 - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  // m = inv(S) * T (target index -> source index), t = inv(S) * (targetOrigin - sourceOrigin).
  const td = target.direction;
  const ts = target.spacing;
  const m = new Float64Array(9);
  const t = new Float64Array(3);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      m[r * 3 + col] =
        (inv[r * 3] * td[col * 3] + inv[r * 3 + 1] * td[col * 3 + 1] + inv[r * 3 + 2] * td[col * 3 + 2]) * ts[col];
    }
    t[r] =
      inv[r * 3] * (target.origin[0] - source.origin[0]) +
      inv[r * 3 + 1] * (target.origin[1] - source.origin[1]) +
      inv[r * 3 + 2] * (target.origin[2] - source.origin[2]);
  }

  const src = source.data;
  const sxy = sx * sy;
  const m00 = m[0], m10 = m[3], m20 = m[6];
  let o = 0;
  for (let k = 0; k < tz; k++) {
    for (let j = 0; j < ty; j++) {
      // "+ 0.5" here so the inner loop only needs a floor to round to nearest.
      const bx = t[0] + j * m[1] + k * m[2] + 0.5;
      const by = t[1] + j * m[4] + k * m[5] + 0.5;
      const bz = t[2] + j * m[7] + k * m[8] + 0.5;
      for (let i = 0; i < tx; i++, o++) {
        const x = Math.floor(bx + i * m00);
        const y = Math.floor(by + i * m10);
        const z = Math.floor(bz + i * m20);
        if (x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz) out[o] = src[x + y * sx + z * sxy];
      }
    }
  }
  return result;
}

/** The volume as a Uint8 labelmap. Throws when a value cannot be a label (negative, above 255 or NaN). */
export function toLabelmap(vol: VolumeData): VolumeData {
  const src = vol.data;
  if (src instanceof Uint8Array) return { ...vol };
  const n = src.length;
  const out = new Uint8Array(n);
  const isFloat = src instanceof Float32Array || src instanceof Float64Array;
  for (let i = 0; i < n; i++) {
    const v = isFloat ? Math.round(src[i]) : src[i];
    if (!(v >= 0 && v <= 255)) {
      if (v > 255) {
        throw new IoError('This mask has label values above 255. Only labels from 0 to 255 are supported.');
      }
      if (v < 0) throw new IoError('This mask has negative label values. Only labels from 0 to 255 are supported.');
      throw new IoError('This file is not a mask: some of its values are not numbers.');
    }
    out[i] = v;
  }
  return { ...vol, data: out };
}

/**
 * The volume in a type the renderer accepts (Uint8, Int8, Uint16, Int16 or
 * Float32). Other types become Int16 when every value is an integer in the
 * int16 range, else Float32.
 */
export function toRenderable(vol: VolumeData): VolumeData {
  const src = vol.data;
  if (!(src instanceof Int32Array || src instanceof Uint32Array || src instanceof Float64Array)) return vol;
  const n = src.length;
  let fits = true;
  if (src instanceof Float64Array) {
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (!(v >= -32768 && v <= 32767) || v !== Math.floor(v)) {
        fits = false;
        break;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (v < -32768 || v > 32767) {
        fits = false;
        break;
      }
    }
  }
  return { ...vol, data: fits ? Int16Array.from(src) : Float32Array.from(src) };
}

/**
 * About this many voxels are sampled for the display range. A prime, so the
 * sampling step does not line up with the row or slice length.
 */
const WINDOW_SAMPLES = 200003;

/** A robust display range: roughly the 0.5th to 99.5th percentile of the finite values. */
export function autoWindow(vol: VolumeData): { lower: number; upper: number } {
  const src = vol.data;
  const n = src.length;
  const count = Math.min(n, WINDOW_SAMPLES);
  const step = n / Math.max(count, 1);
  const samples = new Float64Array(count);
  let m = 0;
  for (let s = 0; s < count; s++) {
    const v = src[Math.floor(s * step)];
    if (v - v === 0) samples[m++] = v; // skips NaN and infinities
  }
  if (m === 0) return { lower: 0, upper: 1 };
  const sorted = samples.subarray(0, m).sort();
  let lower = sorted[Math.floor(0.005 * (m - 1))];
  let upper = sorted[Math.floor(0.995 * (m - 1))];
  if (!(lower < upper)) {
    lower = sorted[0];
    upper = sorted[m - 1];
  }
  if (!(lower < upper)) upper = lower + 1;
  return { lower, upper };
}

/** The distinct non-zero values in the volume, ascending. */
export function labelValues(vol: VolumeData): number[] {
  const src = vol.data;
  const n = src.length;
  const out: number[] = [];
  if (src instanceof Uint8Array || src instanceof Uint16Array) {
    const seen = new Uint8Array(src instanceof Uint8Array ? 256 : 65536);
    for (let i = 0; i < n; i++) seen[src[i]] = 1;
    for (let v = 1; v < seen.length; v++) if (seen[v]) out.push(v);
    return out;
  }
  const seen = new Set<number>();
  let last = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (v !== last) {
      last = v;
      if (v !== 0) seen.add(v);
    }
  }
  seen.forEach((v) => out.push(v));
  return out.sort((p, q) => p - q);
}
