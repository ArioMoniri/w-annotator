import { describe, expect, it } from 'vitest';
import { conflictPatch, mergeMasks, mergeSummary } from './merge';
import { applyPatch } from './patch';

// Two slices of four voxels.
const SLICE = 4;
const u8 = (...v: number[]) => Uint8Array.from(v);

describe('mergeMasks, three-way', () => {
  it('takes the room where only the room changed', () => {
    const base = u8(0, 0, 0, 0, 0, 0, 0, 0);
    const mine = base.slice();
    const theirs = u8(0, 2, 0, 0, 0, 0, 0, 0);
    const r = mergeMasks(base, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual(Array.from(theirs));
    expect(r.taken).toBe(1);
    expect(r.kept).toBe(0);
    expect(r.conflicts).toBeNull();
    expect(r.changedSlices).toEqual([0]);
  });

  it('keeps mine where only I changed, and counts it', () => {
    const base = u8(0, 0, 0, 0, 0, 0, 0, 0);
    const mine = u8(1, 0, 0, 0, 0, 1, 0, 0);
    const theirs = base.slice();
    const r = mergeMasks(base, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual([1, 0, 0, 0, 0, 1, 0, 0]);
    expect(r.kept).toBe(2);
    expect(r.keptSlices).toBe(2);
    expect(r.conflicts).toBeNull();
    expect(r.changedSlices).toEqual([]);
  });

  it('has nothing to do where both made the same change', () => {
    const base = u8(0, 0, 0, 0, 0, 0, 0, 0);
    const mine = u8(3, 0, 0, 0, 0, 0, 0, 0);
    const theirs = u8(3, 0, 0, 0, 0, 0, 0, 0);
    const r = mergeMasks(base, mine, theirs, SLICE);
    expect(r.taken + r.kept).toBe(0);
    expect(r.conflicts).toBeNull();
  });

  it('keeps changes to different voxels from both sides', () => {
    const base = u8(0, 0, 0, 0, 0, 0, 0, 0);
    const mine = u8(1, 0, 0, 0, 0, 0, 0, 0);
    const theirs = u8(0, 0, 0, 0, 0, 0, 0, 2);
    mergeMasks(base, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual([1, 0, 0, 0, 0, 0, 0, 2]);
  });

  it("leaves the room's value on a conflict and puts mine aside", () => {
    const base = u8(0, 5, 0, 0, 0, 0, 0, 0);
    const mine = u8(0, 1, 0, 0, 0, 0, 1, 1);
    const theirs = u8(0, 2, 0, 0, 0, 0, 2, 0);
    const r = mergeMasks(base, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual([0, 2, 0, 0, 0, 0, 2, 1]);
    expect(r.kept).toBe(1);
    expect(r.conflicts).not.toBeNull();
    expect(Array.from(r.conflicts!.index)).toEqual([1, 6]);
    expect(Array.from(r.conflicts!.mine)).toEqual([1, 1]);
    expect(r.conflictSlices).toBe(2);
  });

  it('counts an erased voxel as a change like any other', () => {
    const base = u8(4, 4, 0, 0, 0, 0, 0, 0);
    const mine = u8(0, 4, 0, 0, 0, 0, 0, 0);
    const theirs = u8(4, 0, 0, 0, 0, 0, 0, 0);
    mergeMasks(base, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('mergeMasks, two-way (no shared starting point)', () => {
  it('treats every difference as a conflict', () => {
    const mine = u8(1, 0, 0, 0, 0, 0, 0, 0);
    const theirs = u8(0, 0, 0, 0, 0, 0, 0, 2);
    const r = mergeMasks(null, mine, theirs, SLICE);
    expect(Array.from(mine)).toEqual(Array.from(theirs));
    expect(r.kept).toBe(0);
    expect(Array.from(r.conflicts!.index)).toEqual([0, 7]);
    expect(Array.from(r.conflicts!.mine)).toEqual([1, 0]);
  });
});

describe('conflictPatch', () => {
  it('turns what was put aside into an ordinary edit', () => {
    const base = u8(0, 5, 0, 0, 0, 0, 0, 0);
    const mine = u8(0, 1, 1, 0, 0, 0, 1, 0);
    const theirs = u8(0, 2, 2, 0, 0, 0, 2, 0);
    const r = mergeMasks(base, mine, theirs, SLICE);
    const patch = conflictPatch(r.conflicts!, mine);
    expect(Array.from(patch.starts)).toEqual([1, 6]);
    expect(Array.from(patch.lengths)).toEqual([2, 1]);
    expect(Array.from(patch.before)).toEqual([2, 2, 2]);
    applyPatch(mine, patch, 'after');
    expect(Array.from(mine)).toEqual([0, 1, 1, 0, 0, 0, 1, 0]);
  });
});

describe('mergeSummary', () => {
  const none = { taken: 0, kept: 0, keptSlices: 0, conflictSlices: 0, conflicts: null, changedSlices: [] };
  it('says when there was nothing to merge', () => {
    expect(mergeSummary(none)).toBe('Back online. Nothing needed merging.');
    expect(mergeSummary({ ...none, taken: 12 })).toBe("Back online. The mask now has the room's changes.");
  });
  it('counts what was added', () => {
    expect(mergeSummary({ ...none, kept: 1240, keptSlices: 6 })).toBe('Merged your offline work: 1,240 voxels on 6 slices added.');
    expect(mergeSummary({ ...none, kept: 1, keptSlices: 1 })).toBe('Merged your offline work: 1 voxel on 1 slice added.');
  });
  it('says how much needs review', () => {
    const conflicts = { index: new Uint32Array(3), mine: new Uint8Array(3) };
    expect(mergeSummary({ ...none, kept: 1240, keptSlices: 6, conflicts, conflictSlices: 3 })).toBe(
      'Merged your offline work: 1,240 voxels on 6 slices added. 3 slices need review.',
    );
    expect(mergeSummary({ ...none, conflicts, conflictSlices: 1 })).toBe('Back online. 1 slice needs review.');
  });
});
