/**
 * Fill between slices: paint a segment on a few slices and the slices in
 * between get shapes that blend from one to the next (shape-based
 * interpolation on signed distance maps). Runs locally, no downloads.
 */

export const INF = 1e20;

/**
 * 1D squared distance transform (Felzenszwalb and Huttenlocher).
 * `scale` is the sample spacing, so distances come out in its unit squared.
 * Samples at INF are skipped; a line with none stays at INF.
 */
export function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array, scale = 1): void {
  const w = scale * scale;
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq >= INF) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    let s: number;
    for (;;) {
      const p = v[k];
      s = (fq + w * q * q - (f[p] + w * p * p)) / (2 * w * (q - p));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  if (k < 0) {
    for (let q = 0; q < n; q++) d[q] = INF;
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = w * (q - p) * (q - p) + f[p];
  }
}

/** Squared distance from every pixel to the nearest pixel where `on` is set. */
function squaredDistance(on: Uint8Array, w: number, h: number, want: number): Float64Array {
  const out = new Float64Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = on[x + y * w] === want ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[x + y * w] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[x + y * w];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[x + y * w] = d[x];
  }
  return out;
}

/** Positive inside the shape, negative outside, in pixels from the edge. */
export function signedDistance(inside: Uint8Array, w: number, h: number): Float32Array {
  const toOutside = squaredDistance(inside, w, h, 0);
  const toInside = squaredDistance(inside, w, h, 1);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = inside[i] ? Math.sqrt(toOutside[i]) - 0.5 : 0.5 - Math.sqrt(toInside[i]);
  }
  return out;
}

/**
 * The voxels fill between slices would give to `label`, along voxel axis `axis`,
 * as offsets into the mask. The mask is only read. Without `writable` only empty
 * voxels are listed, so other segments are never overwritten; with it, a voxel is
 * listed when `writable[its value]` is 1.
 */
export function interpolatedVoxels(
  mask: Uint8Array,
  dims: [number, number, number],
  label: number,
  axis: 0 | 1 | 2,
  writable?: Uint8Array,
): Uint32Array {
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const stride = [1, dims[0], dims[0] * dims[1]];
  const w = dims[u];
  const h = dims[v];
  const count = dims[axis];
  const offset = (a: number, b: number, s: number) => a * stride[u] + b * stride[v] + s * stride[axis];

  const read = (s: number): Uint8Array | null => {
    const plane = new Uint8Array(w * h);
    let any = false;
    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        if (mask[offset(a, b, s)] === label) {
          plane[a + b * w] = 1;
          any = true;
        }
      }
    }
    return any ? plane : null;
  };

  const painted: { s: number; plane: Uint8Array }[] = [];
  for (let s = 0; s < count; s++) {
    const plane = read(s);
    if (plane) painted.push({ s, plane });
  }

  const out: number[] = [];
  let previous: Float32Array | null = null;
  for (let i = 0; i + 1 < painted.length; i++) {
    const from = painted[i];
    const to = painted[i + 1];
    const gap = to.s - from.s;
    if (gap < 2) {
      previous = null;
      continue;
    }
    const d0: Float32Array = previous ?? signedDistance(from.plane, w, h);
    const d1 = signedDistance(to.plane, w, h);
    for (let s = from.s + 1; s < to.s; s++) {
      const t = (s - from.s) / gap;
      for (let b = 0; b < h; b++) {
        for (let a = 0; a < w; a++) {
          const p = a + b * w;
          if (d0[p] * (1 - t) + d1[p] * t > 0) {
            const o = offset(a, b, s);
            const value = mask[o];
            if (writable ? value !== label && writable[value] === 1 : value === 0) out.push(o);
          }
        }
      }
    }
    previous = d1;
  }
  return Uint32Array.from(out);
}

/**
 * Fills the gaps between slices that contain `label`, along voxel axis `axis`.
 * Only empty voxels are written unless `writable` says otherwise (see
 * `interpolatedVoxels`). Returns the number of voxels set.
 */
export function interpolateSlices(
  mask: Uint8Array,
  dims: [number, number, number],
  label: number,
  axis: 0 | 1 | 2,
  writable?: Uint8Array,
): number {
  const voxels = interpolatedVoxels(mask, dims, label, axis, writable);
  for (let n = 0; n < voxels.length; n++) mask[voxels[n]] = label;
  return voxels.length;
}

const VIEW_NORMALS: Record<string, [number, number, number]> = {
  axial: [0, 0, 1],
  sagittal: [1, 0, 0],
  coronal: [0, 1, 0],
};

/** The voxel axis that runs through the slices of a standard view. */
export function sliceAxisFor(direction: number[], view: string): 0 | 1 | 2 {
  const n = VIEW_NORMALS[view] ?? VIEW_NORMALS.axial;
  let best: 0 | 1 | 2 = 2;
  let bestDot = -1;
  for (const k of [0, 1, 2] as const) {
    const dot = Math.abs(direction[k * 3] * n[0] + direction[k * 3 + 1] * n[1] + direction[k * 3 + 2] * n[2]);
    if (dot > bestDot) {
      bestDot = dot;
      best = k;
    }
  }
  return best;
}
