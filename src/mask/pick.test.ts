import { describe, expect, it } from 'vitest';
import { segmentAt } from './pick';

const seg = (index: number, visible = true) => ({ index, visible });

/** 4 × 4 × 3 voxels of 2 × 2 × 5 mm, starting at (10, 20, 30). Segment 1 at voxel (1, 2, 0), segment 2 at (3, 0, 2). */
function mask() {
  const data = new Uint8Array(4 * 4 * 3);
  data[1 + 2 * 4] = 1;
  data[3 + 0 * 4 + 2 * 16] = 2;
  return { dims: [4, 4, 3] as [number, number, number], spacing: [2, 2, 5] as [number, number, number], origin: [10, 20, 30] as [number, number, number], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data };
}

describe('the segment under a point', () => {
  const list = [seg(1), seg(2)];

  it('is the one whose voxel holds the point', () => {
    expect(segmentAt(mask(), [12, 24, 30], list, false)).toBe(1);
    expect(segmentAt(mask(), [16, 20, 40], list, false)).toBe(2);
    // Anywhere inside the voxel, not only at its centre.
    expect(segmentAt(mask(), [12.9, 23.1, 32.4], list, false)).toBe(1);
  });

  it('is none on background or outside the volume', () => {
    expect(segmentAt(mask(), [10, 20, 30], list, false)).toBe(0);
    expect(segmentAt(mask(), [-50, 24, 30], list, false)).toBe(0);
  });

  it('ignores a hidden segment and a hidden mask', () => {
    expect(segmentAt(mask(), [12, 24, 30], [seg(1, false), seg(2)], false)).toBe(0);
    expect(segmentAt(mask(), [12, 24, 30], list, true)).toBe(0);
  });

  it('ignores a value that has no segment', () => {
    expect(segmentAt(mask(), [12, 24, 30], [seg(2)], false)).toBe(0);
  });
});
