/**
 * Bringing offline work back into a room (`ROOMS.md` C6).
 *
 * `base` is the mask as the room had it when I went offline, `mine` is what I have
 * now, `theirs` is the room now. Per voxel: a change on one side is kept; the same
 * change on both sides needs nothing; different changes are a conflict, where the
 * room's value stays and mine is put aside for the person to decide. Nothing is dropped.
 */

import type { Patch } from './patch';

export interface Conflicts {
  /** Voxel positions, ascending. */
  index: Uint32Array;
  /** What I had at each of them. */
  mine: Uint8Array;
}

export interface MergeResult {
  /** Voxels that took the room's value. */
  taken: number;
  /** Voxels of mine that the room does not have yet. */
  kept: number;
  keptSlices: number;
  conflictSlices: number;
  conflicts: Conflicts | null;
  /** Slices of `mine` that were written to, for repainting. */
  changedSlices: number[];
}

/**
 * Merges into `mine` in place. With `base` null there is no shared starting point
 * (the room was made again), so every difference is a conflict.
 */
export function mergeMasks(base: Uint8Array | null, mine: Uint8Array, theirs: Uint8Array, sliceSize: number): MergeResult {
  if (mine.length !== theirs.length || (base && base.length !== mine.length)) throw new Error('Masks of different sizes cannot be merged');
  let taken = 0;
  let kept = 0;
  const keptSlices = new Set<number>();
  const conflictSlices = new Set<number>();
  const changed = new Set<number>();
  const index: number[] = [];
  const put: number[] = [];
  for (let i = 0; i < mine.length; i++) {
    const m = mine[i];
    const t = theirs[i];
    if (m === t) continue;
    const slice = Math.floor(i / sliceSize);
    if (base && base[i] === t) {
      kept++;
      keptSlices.add(slice);
      continue;
    }
    if (base && base[i] === m) taken++;
    else {
      index.push(i);
      put.push(m);
      conflictSlices.add(slice);
    }
    mine[i] = t;
    changed.add(slice);
  }
  return {
    taken,
    kept,
    keptSlices: keptSlices.size,
    conflictSlices: conflictSlices.size,
    conflicts: index.length ? { index: Uint32Array.from(index), mine: Uint8Array.from(put) } : null,
    changedSlices: [...changed].sort((a, b) => a - b),
  };
}

/** "Use mine": the voxels put aside, as an ordinary edit on top of the mask as it is now. */
export function conflictPatch(conflicts: Conflicts, current: Uint8Array): Patch {
  const starts: number[] = [];
  const lengths: number[] = [];
  const n = conflicts.index.length;
  const before = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const i = conflicts.index[c];
    before[c] = current[i];
    if (c > 0 && conflicts.index[c - 1] === i - 1) lengths[lengths.length - 1]++;
    else {
      starts.push(i);
      lengths.push(1);
    }
  }
  return { starts: Uint32Array.from(starts), lengths: Uint32Array.from(lengths), before, after: conflicts.mine.slice() };
}

const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** One line for the person coming back. */
export function mergeSummary(r: MergeResult): string {
  const review = r.conflicts ? `${count(r.conflictSlices, 'slice')} ${r.conflictSlices === 1 ? 'needs' : 'need'} review.` : '';
  if (r.kept > 0) return `Merged your offline work: ${count(r.kept, 'voxel')} on ${count(r.keptSlices, 'slice')} added.${review ? ` ${review}` : ''}`;
  if (review) return `Back online. ${review}`;
  return r.taken > 0 ? "Back online. The mask now has the room's changes." : 'Back online. Nothing needed merging.';
}
