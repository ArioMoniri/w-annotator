/**
 * "View through my computer" (`ROOMS.md` B, option ii).
 *
 * The host never sends the image. A guest asks for the planes they scroll to and gets
 * each one already windowed down to 8 bits, with that plane's labels. The stored values,
 * the file and its tags stay on the host's computer.
 */

import { gzipSync } from 'fflate';
import { gunzipExactly } from './transfer';

export type Axis = 0 | 1 | 2;
type Dims = [number, number, number];
type Numbers = ArrayLike<number> & { length: number };

/** Voxels in one plane across `axis`. */
export function planeLength(dims: Dims, axis: Axis): number {
  return (dims[0] * dims[1] * dims[2]) / dims[axis];
}

/** Position in the volume of each voxel of a plane, in the plane's own order. */
function eachOfPlane(dims: Dims, axis: Axis, index: number, visit: (volumeIndex: number, planeIndex: number) => void): void {
  const [nx, ny, nz] = dims;
  let p = 0;
  if (axis === 2) {
    const o = index * nx * ny;
    for (let i = 0; i < nx * ny; i++) visit(o + i, p++);
  } else if (axis === 1) {
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) visit((k * ny + index) * nx + i, p++);
  } else {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) visit((k * ny + j) * nx + index, p++);
  }
}

export function readPlane<T extends Numbers>(data: T, dims: Dims, axis: Axis, index: number): T {
  const Ctor = (data as unknown as { constructor: new (n: number) => T }).constructor;
  const out = new Ctor(planeLength(dims, axis)) as unknown as number[];
  eachOfPlane(dims, axis, index, (v, p) => (out[p] = data[v]));
  return out as unknown as T;
}

export function writePlane(data: { [i: number]: number }, dims: Dims, axis: Axis, index: number, plane: Numbers): void {
  eachOfPlane(dims, axis, index, (v, p) => (data[v] = plane[p]));
}

/** The stored (k) slices a plane writes to, for repainting. */
export function planeSlices(dims: Dims, axis: Axis, index: number): number[] {
  return axis === 2 ? [index] : Array.from({ length: dims[2] }, (_, k) => k);
}

/** Maps a window onto 0 to 255. What is outside the window is clipped, so it cannot be recovered. */
export function windowTo8(values: Numbers, lower: number, upper: number): Uint8Array {
  const out = new Uint8Array(values.length);
  const width = upper - lower;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = width > 0 ? Math.max(0, Math.min(255, Math.round(((v - lower) / width) * 255))) : v >= upper ? 255 : 0;
  }
  return out;
}

/**
 * One plane on the wire: the 8-bit picture, then its labels, compressed together.
 * Not handed to a worker: a plane must be read and sent, and later received and
 * written, in step with the edits around it, or a guest could end up with older labels.
 */
export function encodeSlice(image: Uint8Array, labels: Uint8Array): Uint8Array {
  const both = new Uint8Array(image.length + labels.length);
  both.set(image);
  both.set(labels, image.length);
  return gzipSync(both, { level: 1 });
}

/** Null unless the data unpacks to exactly one picture and one set of labels of `length` voxels each. */
export function decodeSlice(bytes: Uint8Array, length: number): { image: Uint8Array; labels: Uint8Array } | null {
  const both = gunzipExactly(bytes, length * 2);
  return both && { image: both.subarray(0, length), labels: both.subarray(length) };
}

export interface Grid {
  dims: Dims;
  spacing: [number, number, number];
  origin: [number, number, number];
  /** Three unit vectors, one after another: the directions of i, j and k. */
  direction: number[];
}

/**
 * The planes a guest asks for to draw `indices`: those, then the one on each side. A view is
 * drawn from a thin slab around its plane, so without its neighbours a plane comes out a
 * little darker than on the host; and the neighbours are where the next scroll step goes.
 */
export function withNeighbours(indices: number[], count: number): number[] {
  if (indices.length === 0) return [];
  const before = indices[0] - 1;
  const after = indices[indices.length - 1] + 1;
  return [...indices, ...(before >= 0 ? [before] : []), ...(after < count ? [after] : [])];
}

/**
 * Which planes across `axis` a view shows, given a point on the view's plane and its
 * normal. One index when the view lies on a plane of the volume, two when it lies
 * between two; a short run when it is tilted, at most `limit` around the point.
 */
export function indicesForPlane(grid: Grid, axis: Axis, point: number[], normal: number[], limit = 16): number[] {
  const col = (a: number) => grid.direction.slice(a * 3, a * 3 + 3);
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const rel = [0, 1, 2].map((r) => point[r] - grid.origin[r]);
  // The plane in voxel coordinates: c · (i, j, k) = rhs.
  const c = [0, 1, 2].map((a) => grid.spacing[a] * dot(normal, col(a)));
  if (Math.abs(c[axis]) < 1e-9) return [];
  const rhs = dot(normal, rel);
  const [b, d] = [0, 1, 2].filter((a) => a !== axis);
  const at = (vb: number, vd: number) => (rhs - c[b] * vb - c[d] * vd) / c[axis];
  const corners = [at(0, 0), at(grid.dims[b] - 1, 0), at(0, grid.dims[d] - 1), at(grid.dims[b] - 1, grid.dims[d] - 1)];
  // A view between two planes is drawn by blending them, so it needs the one on each side.
  const NEAR = 1e-4;
  let first = Math.max(0, Math.floor(Math.min(...corners) + NEAR));
  let last = Math.min(grid.dims[axis] - 1, Math.ceil(Math.max(...corners) - NEAR));
  if (first > last) return [];
  if (last - first + 1 > limit) {
    const here = Math.round(at(dot(rel, col(b)) / grid.spacing[b], dot(rel, col(d)) / grid.spacing[d]));
    first = Math.max(first, Math.min(here - Math.floor(limit / 2), last - limit + 1));
    last = first + limit - 1;
  }
  return Array.from({ length: last - first + 1 }, (_, n) => first + n);
}
