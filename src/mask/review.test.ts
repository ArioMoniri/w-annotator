import { describe, expect, it } from 'vitest';
import { conflictPatch, type Conflicts } from './merge';
import { applyPatch } from './patch';
import {
  REVIEW_KEEP_MS,
  addConflicts,
  conflictSlices,
  decodeConflicts,
  encodeConflicts,
  mineOutline,
  reviewExpired,
  settledConflicts,
  sliceFocus,
  splitSlice,
  stepSlice,
} from './review';

// Slices of four voxels.
const SLICE = 4;
const u8 = (...v: number[]) => Uint8Array.from(v);
const conflicts = (pairs: [number, number][]): Conflicts => ({ index: Uint32Array.from(pairs.map((p) => p[0])), mine: Uint8Array.from(pairs.map((p) => p[1])) });
const pairs = (c: Conflicts | null) => (c ? Array.from(c.index, (i, n) => [i, c.mine[n]]) : null);

describe('slices to review', () => {
  const c = conflicts([
    [1, 2],
    [2, 2],
    [9, 1],
    [12, 0],
    [13, 3],
    [15, 3],
  ]);

  it('lists each slice that differs with how many voxels', () => {
    expect(conflictSlices(c, SLICE)).toEqual([
      { z: 0, voxels: 2 },
      { z: 2, voxels: 1 },
      { z: 3, voxels: 3 },
    ]);
    expect(conflictSlices(null, SLICE)).toEqual([]);
  });

  it('takes one slice out and leaves the rest as they were', () => {
    const { slice, rest } = splitSlice(c, 2, SLICE);
    expect(pairs(slice)).toEqual([[9, 1]]);
    expect(pairs(rest)).toEqual([
      [1, 2],
      [2, 2],
      [12, 0],
      [13, 3],
      [15, 3],
    ]);
    // A slice with nothing to decide gives nothing and takes nothing.
    const none = splitSlice(c, 1, SLICE);
    expect(none.slice).toBeNull();
    expect(pairs(none.rest)).toEqual(pairs(c));
    // The last one leaves nothing.
    const one = conflicts([[5, 1]]);
    expect(splitSlice(one, 1, SLICE).rest).toBeNull();
  });

  it('one slice of mine becomes an ordinary edit of that slice only', () => {
    const current = new Uint8Array(16).fill(7);
    const { slice } = splitSlice(c, 3, SLICE);
    const patch = conflictPatch(slice!, current);
    applyPatch(current, patch, 'after');
    expect(Array.from(current)).toEqual([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 0, 3, 7, 3]);
    applyPatch(current, patch, 'before');
    expect(Array.from(current)).toEqual(new Array(16).fill(7));
  });

  it('steps to the next and the previous slice, and round again at the ends', () => {
    const slices = [0, 2, 3];
    expect(stepSlice(slices, 0, 1)).toBe(2);
    expect(stepSlice(slices, 2, 1)).toBe(3);
    expect(stepSlice(slices, 3, 1)).toBe(0);
    expect(stepSlice(slices, 0, -1)).toBe(3);
    expect(stepSlice(slices, 3, -1)).toBe(2);
    // From a slice that is not one of them: the nearest one in that direction.
    expect(stepSlice(slices, 1, 1)).toBe(2);
    expect(stepSlice(slices, 1, -1)).toBe(0);
    expect(stepSlice(slices, 9, 1)).toBe(0);
    expect(stepSlice([], 1, 1)).toBeNull();
    expect(stepSlice([4], 4, 1)).toBe(4);
  });

  it('finds a voxel in the middle of what differs on a slice, to bring it into view', () => {
    expect(sliceFocus(c, 3, SLICE)).toBe(13);
    expect(sliceFocus(c, 0, SLICE)).toBe(2);
    expect(sliceFocus(c, 1, SLICE)).toBeNull();
  });
});

describe('what is kept aside over several merges', () => {
  it('adds new differences to those still waiting, the newer value winning', () => {
    const old = conflicts([
      [1, 2],
      [9, 1],
    ]);
    const next = conflicts([
      [0, 4],
      [9, 3],
      [20, 5],
    ]);
    expect(pairs(addConflicts(old, next))).toEqual([
      [0, 4],
      [1, 2],
      [9, 3],
      [20, 5],
    ]);
    expect(pairs(addConflicts(null, next))).toEqual(pairs(next));
    expect(pairs(addConflicts(old, null))).toEqual(pairs(old));
    expect(addConflicts(null, null)).toBeNull();
  });

  it('lets go of a voxel where the mask already has my value', () => {
    const c = conflicts([
      [1, 2],
      [2, 2],
      [9, 1],
    ]);
    const current = new Uint8Array(16);
    current[1] = 2;
    current[9] = 1;
    expect(pairs(settledConflicts(c, current))).toEqual([[2, 2]]);
    current[2] = 2;
    expect(settledConflicts(c, current)).toBeNull();
  });

  it('is kept for 7 days', () => {
    expect(REVIEW_KEEP_MS).toBe(7 * 24 * 3600 * 1000);
    expect(reviewExpired(1000, 1000 + REVIEW_KEEP_MS - 1)).toBe(false);
    expect(reviewExpired(1000, 1000 + REVIEW_KEEP_MS)).toBe(true);
  });

  it('round-trips through bytes, and refuses bytes that are not it', () => {
    const c = conflicts([
      [1, 2],
      [70_000, 255],
      [4_000_000_000, 0],
    ]);
    const bytes = encodeConflicts(c);
    expect(bytes.length).toBe(4 + 3 * 5);
    expect(pairs(decodeConflicts(bytes, 4_294_967_295))).toEqual(pairs(c));
    // A position outside the mask, positions out of order, or a wrong length: not taken.
    expect(decodeConflicts(bytes, 1000)).toBeNull();
    expect(decodeConflicts(bytes.subarray(0, bytes.length - 1), 4_294_967_295)).toBeNull();
    const unordered = encodeConflicts(conflicts([[9, 1]]));
    const two = new Uint8Array(4 + 10);
    new DataView(two.buffer).setUint32(0, 2, true);
    new DataView(two.buffer).setUint32(4, 9, true);
    new DataView(two.buffer).setUint32(8, 9, true);
    expect(decodeConflicts(two, 100)).toBeNull();
    expect(pairs(decodeConflicts(unordered, 100))).toEqual([[9, 1]]);
    expect(decodeConflicts(new Uint8Array(2), 100)).toBeNull();
  });
});

describe('my version as an outline', () => {
  it('is the mask with my values put back, on the slices still to decide and nowhere else', () => {
    //                 slice 0      slice 1      slice 2
    const current = u8(1, 1, 0, 0, 5, 5, 5, 5, 0, 0, 2, 2);
    const c = conflicts([
      [0, 0],
      [2, 1],
      [9, 2],
    ]);
    const out = new Uint8Array(12).fill(9);
    expect(mineOutline(c, current, SLICE, out)).toEqual([0, 2]);
    expect(Array.from(out)).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 2, 2, 2]);
    // With nothing left, nothing is drawn.
    expect(mineOutline(null, current, SLICE, out)).toEqual([]);
    expect(Array.from(out)).toEqual(new Array(12).fill(0));
  });
});
