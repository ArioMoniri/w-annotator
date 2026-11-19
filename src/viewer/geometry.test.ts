import { describe, expect, it } from 'vitest';
import { hexToRgb, indexToWorld, voxelAt, worldToIndex } from './geometry';

const flipped = {
  dims: [10, 20, 30] as [number, number, number],
  spacing: [0.5, 0.5, 2] as [number, number, number],
  origin: [100, 50, -20] as [number, number, number],
  direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
};

describe('index and world', () => {
  it('maps the first voxel to the origin', () => {
    expect(indexToWorld(flipped, [0, 0, 0])).toEqual([100, 50, -20]);
  });
  it('follows flipped axes and spacing', () => {
    expect(indexToWorld(flipped, [2, 4, 3])).toEqual([99, 48, -14]);
  });
  it('round-trips', () => {
    const ijk = worldToIndex(flipped, indexToWorld(flipped, [3, 7, 11]));
    expect(ijk[0]).toBeCloseTo(3);
    expect(ijk[1]).toBeCloseTo(7);
    expect(ijk[2]).toBeCloseTo(11);
  });
  it('handles an oblique direction', () => {
    const s = Math.SQRT1_2;
    const vol = { ...flipped, origin: [0, 0, 0] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], direction: [s, s, 0, -s, s, 0, 0, 0, 1] };
    const w = indexToWorld(vol, [1, 0, 0]);
    expect(w[0]).toBeCloseTo(s);
    expect(w[1]).toBeCloseTo(s);
    expect(worldToIndex(vol, w)[0]).toBeCloseTo(1);
  });
  it('returns null outside the volume', () => {
    expect(voxelAt(flipped, [101, 50, -20])).toBeNull();
    expect(voxelAt(flipped, [99, 48, -14])).toEqual([2, 4, 3]);
  });
});

describe('hexToRgb', () => {
  it('parses long and short hex', () => {
    expect(hexToRgb('#E69F00')).toEqual([230, 159, 0]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
  });
});
