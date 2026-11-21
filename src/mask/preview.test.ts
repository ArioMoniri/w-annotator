import { describe, expect, it } from 'vitest';
import { interpolateSlices, interpolatedVoxels } from './interpolate';
import { FillPreview, PREVIEW_DARK, PREVIEW_LIGHT, previewLabels } from './preview';

type Dims = [number, number, number];

/** Segment 1 painted as a 4 × 4 square on slices 1 and 5 of an 8 × 8 × 7 volume. */
function painted() {
  const dims: Dims = [8, 8, 7];
  const mask = new Uint8Array(8 * 8 * 7);
  const at = (x: number, y: number, z: number) => x + y * 8 + z * 64;
  for (const z of [1, 5]) for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[at(x, y, z)] = 1;
  return { dims, mask, at };
}

describe('the voxels fill between slices would add', () => {
  it('lists them without changing the mask', () => {
    const { dims, mask, at } = painted();
    const before = mask.slice();
    const voxels = interpolatedVoxels(mask, dims, 1, 2);
    expect(mask).toEqual(before);
    expect(voxels.length).toBe(3 * 16);
    expect([...voxels]).toContain(at(3, 3, 3));
    expect([...voxels].every((o) => mask[o] === 0)).toBe(true);
  });

  it('are the ones fill between slices sets', () => {
    const { dims, mask } = painted();
    const voxels = interpolatedVoxels(mask, dims, 1, 2);
    const filled = mask.slice();
    expect(interpolateSlices(filled, dims, 1, 2)).toBe(voxels.length);
    const expected = mask.slice();
    for (const o of voxels) expected[o] = 1;
    expect(filled).toEqual(expected);
  });

  it('leave other segments alone by default', () => {
    const { dims, mask, at } = painted();
    mask[at(3, 3, 3)] = 2;
    const voxels = interpolatedVoxels(mask, dims, 1, 2);
    expect(voxels.length).toBe(3 * 16 - 1);
    expect([...voxels]).not.toContain(at(3, 3, 3));
  });

  it('can be limited to the inside of another segment', () => {
    const { dims, mask, at } = painted();
    mask[at(3, 3, 3)] = 2;
    mask[at(4, 3, 3)] = 2;
    const writable = new Uint8Array(256);
    writable[2] = 1;
    expect([...interpolatedVoxels(mask, dims, 1, 2, writable)].sort()).toEqual([at(3, 3, 3), at(4, 3, 3)]);
  });
});

describe('a fill preview', () => {
  const ANY_EMPTY = Uint8Array.from({ length: 256 }, (_, v) => (v === 0 ? 1 : 0));

  it('shows the proposal and leaves the mask as it was', () => {
    const { dims, mask, at } = painted();
    const before = mask.slice();
    const preview = new FillPreview();
    const shown = new Uint8Array(mask.length);
    expect(preview.start(mask, dims, { label: 1, axis: 2, writable: ANY_EMPTY }, shown)).toBe(48);
    expect(mask).toEqual(before);
    expect(preview.active).toBe(true);
    expect(preview.count).toBe(48);
    expect(shown[at(3, 3, 3)]).not.toBe(0);
    expect(shown[at(3, 3, 1)]).toBe(0);
    expect(shown.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(48);
  });

  it('is not started when there is nothing to fill', () => {
    const dims: Dims = [4, 4, 4];
    const mask = new Uint8Array(64);
    const preview = new FillPreview();
    expect(preview.start(mask, dims, { label: 1, axis: 2, writable: ANY_EMPTY }, new Uint8Array(64))).toBe(0);
    expect(preview.active).toBe(false);
  });

  it('writes the mask only when applied, and then ends', () => {
    const { dims, mask } = painted();
    const preview = new FillPreview();
    const shown = new Uint8Array(mask.length);
    preview.start(mask, dims, { label: 1, axis: 2, writable: ANY_EMPTY }, shown);
    const filled = mask.slice();
    expect(preview.apply(filled, dims, shown)).toBe(48);
    expect(filled.reduce((n, v) => n + v, 0)).toBe(32 + 48);
    expect(preview.active).toBe(false);
    expect(shown.every((v) => v === 0)).toBe(true);
  });

  it('works from the mask as it is when applied, not as it was when shown', () => {
    const { dims, mask, at } = painted();
    const preview = new FillPreview();
    const shown = new Uint8Array(mask.length);
    preview.start(mask, dims, { label: 1, axis: 2, writable: ANY_EMPTY }, shown);
    // Someone else painted one of the proposed voxels in the meantime.
    mask[at(3, 3, 3)] = 2;
    expect(preview.apply(mask, dims, shown)).toBe(47);
    expect(mask[at(3, 3, 3)]).toBe(2);
  });

  it('leaves nothing behind when cancelled', () => {
    const { dims, mask } = painted();
    const before = mask.slice();
    const preview = new FillPreview();
    const shown = new Uint8Array(mask.length);
    preview.start(mask, dims, { label: 1, axis: 2, writable: ANY_EMPTY }, shown);
    expect(preview.cancel(shown)).toBe(true);
    expect(mask).toEqual(before);
    expect(shown.every((v) => v === 0)).toBe(true);
    expect(preview.active).toBe(false);
    expect(preview.cancel(shown)).toBe(false);
    expect(preview.apply(mask, dims, shown)).toBe(0);
    expect(mask).toEqual(before);
  });
});

describe('preview stripes', () => {
  it('alternate in two-voxel diagonal bands across the slice', () => {
    const dims: Dims = [8, 8, 2];
    const shown = new Uint8Array(128);
    const voxels = Uint32Array.from({ length: 64 }, (_, n) => n);
    previewLabels(shown, dims, voxels, 2);
    expect(shown[0]).toBe(PREVIEW_DARK);
    expect(shown[1]).toBe(PREVIEW_DARK);
    expect(shown[2]).toBe(PREVIEW_LIGHT);
    expect(shown[8]).toBe(PREVIEW_DARK);
    expect(shown[9]).toBe(PREVIEW_LIGHT);
    expect(shown[64]).toBe(0);
  });
});
