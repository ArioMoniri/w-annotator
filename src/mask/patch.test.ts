import { describe, expect, it } from 'vitest';
import { applyPatch, applyPatchWhereUnchanged, decodePatch, diffMask, encodePatch, patchSlices, patchVoxelCount } from './patch';

const SLICE = 16; // 4 x 4

function mask(slices = 3) {
  return new Uint8Array(SLICE * slices);
}

describe('diffMask', () => {
  it('returns null when nothing changed', () => {
    expect(diffMask(mask(), mask(), SLICE)).toBeNull();
  });

  it('records changed runs with before and after values', () => {
    const prev = mask();
    const cur = mask();
    cur.set([1, 1, 2], 5);
    cur[40] = 3;
    const p = diffMask(prev, cur, SLICE)!;
    expect(Array.from(p.starts)).toEqual([5, 40]);
    expect(Array.from(p.lengths)).toEqual([3, 1]);
    expect(Array.from(p.after)).toEqual([1, 1, 2, 3]);
    expect(Array.from(p.before)).toEqual([0, 0, 0, 0]);
    expect(patchVoxelCount(p)).toBe(4);
  });

  it('only looks at the slices it is given', () => {
    const prev = mask();
    const cur = mask();
    cur[2] = 1; // slice 0
    cur[SLICE * 2 + 1] = 1; // slice 2
    const p = diffMask(prev, cur, SLICE, [2])!;
    expect(Array.from(p.starts)).toEqual([SLICE * 2 + 1]);
  });

  it('ignores slice numbers outside the volume', () => {
    const cur = mask();
    cur[0] = 1;
    expect(diffMask(mask(), cur, SLICE, [-1, 99])).toBeNull();
  });

  it('does not join runs across a slice boundary scan twice', () => {
    const prev = mask();
    const cur = mask();
    cur[SLICE - 1] = 1;
    cur[SLICE] = 1;
    const p = diffMask(prev, cur, SLICE, [1, 0, 1])!;
    expect(patchVoxelCount(p)).toBe(2);
  });
});

describe('applyPatch', () => {
  it('redo then undo restores the buffer', () => {
    const prev = mask();
    prev[7] = 9;
    const cur = prev.slice();
    cur.set([4, 4, 4], 6);
    const p = diffMask(prev, cur, SLICE)!;
    const buf = prev.slice();
    applyPatch(buf, p, 'after');
    expect(buf).toEqual(cur);
    applyPatch(buf, p, 'before');
    expect(buf).toEqual(prev);
  });

  it('lists the slices a patch touches', () => {
    const cur = mask();
    cur[SLICE - 1] = 1;
    cur[SLICE] = 1;
    cur[SLICE * 2 + 3] = 1;
    const p = diffMask(mask(), cur, SLICE)!;
    expect(patchSlices(p, SLICE)).toEqual([0, 1, 2]);
  });
});

describe('encodePatch / decodePatch', () => {
  it('round-trips the after values', () => {
    const cur = mask();
    cur.set([1, 2, 3], 10);
    cur[30] = 7;
    const p = diffMask(mask(), cur, SLICE)!;
    const back = decodePatch(encodePatch(p));
    const buf = mask();
    applyPatch(buf, back, 'after');
    expect(buf).toEqual(cur);
  });

  it('rejects truncated data', () => {
    const cur = mask();
    cur[1] = 1;
    const bytes = encodePatch(diffMask(mask(), cur, SLICE)!);
    expect(() => decodePatch(bytes.subarray(0, bytes.length - 1))).toThrow();
  });

  it('refuses to write outside the buffer', () => {
    const big = new Uint8Array(100);
    big[99] = 1;
    const p = diffMask(new Uint8Array(100), big, 10)!;
    expect(() => applyPatch(new Uint8Array(50), p, 'after')).toThrow();
  });
});

describe('applyPatchWhereUnchanged', () => {
  it('undoes my stroke but keeps voxels someone else changed since', () => {
    const start = mask();
    const mine = start.slice();
    mine.set([1, 1, 1, 1], 4);
    const p = diffMask(start, mine, SLICE)!;
    const shared = mine.slice();
    shared[5] = 2; // a collaborator painted over one of my voxels
    shared[6] = 0; // and erased another
    const written = applyPatchWhereUnchanged(shared, p, 'before')!;
    expect(Array.from(shared.subarray(4, 8))).toEqual([0, 2, 0, 0]);
    expect(Array.from(written.starts)).toEqual([4, 7]);
    expect(Array.from(written.after)).toEqual([0, 0]);
    expect(Array.from(written.before)).toEqual([1, 1]);
  });

  it('redo only fills voxels that are still as undo left them', () => {
    const start = mask();
    const mine = start.slice();
    mine.set([1, 1], 0);
    const p = diffMask(start, mine, SLICE)!;
    const shared = start.slice();
    shared[1] = 3;
    applyPatchWhereUnchanged(shared, p, 'after');
    expect(Array.from(shared.subarray(0, 2))).toEqual([1, 3]);
  });

  it('returns null when everything was changed by others', () => {
    const start = mask();
    const mine = start.slice();
    mine[3] = 1;
    const p = diffMask(start, mine, SLICE)!;
    const shared = start.slice();
    shared[3] = 2;
    expect(applyPatchWhereUnchanged(shared, p, 'before')).toBeNull();
    expect(shared[3]).toBe(2);
  });
});
