/**
 * Going through what a merge put aside, slice by slice (`docs/design/ROOMS.md` C6, rule 3).
 *
 * After offline work the room's version stays on screen and my values for the voxels both
 * sides changed are kept aside (`Conflicts` in `merge.ts`). This file turns that into the
 * slices to look at, takes one slice out for "Use mine" or "Keep the room's", and makes the
 * volume my version is outlined from. A slice is a stored slice of the mask: its third axis,
 * which is the axial plane for a volume stored the usual way.
 */

import type { Conflicts } from './merge';

/** How long my version is kept aside when nobody decides (`ROOMS.md` C6, rule 5). */
export const REVIEW_KEEP_MS = 7 * 24 * 3600 * 1000;

export function reviewExpired(madeAt: number, now: number): boolean {
  return now - madeAt >= REVIEW_KEEP_MS;
}

export interface ReviewSlice {
  z: number;
  voxels: number;
}

/** The slices that still have something to decide, in order, with how many voxels differ on each. */
export function conflictSlices(c: Conflicts | null, sliceSize: number): ReviewSlice[] {
  const out: ReviewSlice[] = [];
  if (!c) return out;
  for (let n = 0; n < c.index.length; n++) {
    const z = Math.floor(c.index[n] / sliceSize);
    const last = out[out.length - 1];
    if (last && last.z === z) last.voxels++;
    else out.push({ z, voxels: 1 });
  }
  return out;
}

/** Where slice `z` starts and ends in the list, which is in voxel order. */
function sliceBounds(c: Conflicts, z: number, sliceSize: number): [number, number] {
  const from = z * sliceSize;
  const to = from + sliceSize;
  let a = 0;
  while (a < c.index.length && c.index[a] < from) a++;
  let b = a;
  while (b < c.index.length && c.index[b] < to) b++;
  return [a, b];
}

/** One slice's share, and everything else. Either is null when empty. */
export function splitSlice(c: Conflicts, z: number, sliceSize: number): { slice: Conflicts | null; rest: Conflicts | null } {
  const [a, b] = sliceBounds(c, z, sliceSize);
  if (a === b) return { slice: null, rest: c };
  const slice = { index: c.index.slice(a, b), mine: c.mine.slice(a, b) };
  const n = c.index.length - (b - a);
  if (n === 0) return { slice, rest: null };
  const index = new Uint32Array(n);
  const mine = new Uint8Array(n);
  index.set(c.index.subarray(0, a));
  index.set(c.index.subarray(b), a);
  mine.set(c.mine.subarray(0, a));
  mine.set(c.mine.subarray(b), a);
  return { slice, rest: { index, mine } };
}

/** The slice to go to from `from`: the next one in that direction, round again at the ends. */
export function stepSlice(slices: number[], from: number, dir: 1 | -1): number | null {
  if (slices.length === 0) return null;
  if (dir > 0) return slices.find((z) => z > from) ?? slices[0];
  for (let i = slices.length - 1; i >= 0; i--) if (slices[i] < from) return slices[i];
  return slices[slices.length - 1];
}

/** A voxel in the middle of what differs on slice `z`, to bring into view. */
export function sliceFocus(c: Conflicts, z: number, sliceSize: number): number | null {
  const [a, b] = sliceBounds(c, z, sliceSize);
  return a === b ? null : c.index[a + Math.floor((b - a) / 2)];
}

/** What was waiting plus what a later merge put aside. Where both name a voxel, the later value is mine now. */
export function addConflicts(old: Conflicts | null, next: Conflicts | null): Conflicts | null {
  if (!old) return next;
  if (!next) return old;
  const index: number[] = [];
  const mine: number[] = [];
  let a = 0;
  let b = 0;
  while (a < old.index.length || b < next.index.length) {
    const ia = a < old.index.length ? old.index[a] : Infinity;
    const ib = b < next.index.length ? next.index[b] : Infinity;
    if (ib <= ia) {
      index.push(ib);
      mine.push(next.mine[b++]);
      if (ia === ib) a++;
    } else {
      index.push(ia);
      mine.push(old.mine[a++]);
    }
  }
  return { index: Uint32Array.from(index), mine: Uint8Array.from(mine) };
}

/** Without the voxels where the mask already holds my value: there is nothing left to decide for those. */
export function settledConflicts(c: Conflicts, current: Uint8Array): Conflicts | null {
  let n = 0;
  for (let i = 0; i < c.index.length; i++) if (current[c.index[i]] !== c.mine[i]) n++;
  if (n === c.index.length) return c;
  if (n === 0) return null;
  const index = new Uint32Array(n);
  const mine = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < c.index.length; i++) {
    if (current[c.index[i]] === c.mine[i]) continue;
    index[o] = c.index[i];
    mine[o++] = c.mine[i];
  }
  return { index, mine };
}

/**
 * Writes my version into `out` for the outline: on each slice still to decide, the mask as
 * it is with my values put back; zero everywhere else. Returns those slices.
 */
export function mineOutline(c: Conflicts | null, current: Uint8Array, sliceSize: number, out: Uint8Array): number[] {
  out.fill(0);
  if (!c) return [];
  const slices = conflictSlices(c, sliceSize).map((s) => s.z);
  for (const z of slices) out.set(current.subarray(z * sliceSize, (z + 1) * sliceSize), z * sliceSize);
  for (let i = 0; i < c.index.length; i++) out[c.index[i]] = c.mine[i];
  return slices;
}

/** Count, then the positions as 32-bit numbers, then my values: 5 bytes a voxel. */
export function encodeConflicts(c: Conflicts): Uint8Array {
  const n = c.index.length;
  const out = new Uint8Array(4 + n * 5);
  const view = new DataView(out.buffer);
  view.setUint32(0, n, true);
  for (let i = 0; i < n; i++) view.setUint32(4 + i * 4, c.index[i], true);
  out.set(c.mine, 4 + n * 4);
  return out;
}

/** Null unless the bytes are exactly such a list, in voxel order, inside a mask of `voxels` voxels. */
export function decodeConflicts(bytes: Uint8Array, voxels: number): Conflicts | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  if (n === 0 || bytes.length !== 4 + n * 5) return null;
  const index = new Uint32Array(n);
  let last = -1;
  for (let i = 0; i < n; i++) {
    const at = view.getUint32(4 + i * 4, true);
    if (at <= last || at >= voxels) return null;
    index[i] = last = at;
  }
  return { index, mine: bytes.slice(4 + n * 4) };
}
