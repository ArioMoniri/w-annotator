import { describe, expect, it } from 'vitest';
import { interpolateSlices, signedDistance, sliceAxisFor } from './interpolate';

const dims: [number, number, number] = [21, 21, 9];
const at = (x: number, y: number, z: number) => x + y * dims[0] + z * dims[0] * dims[1];

function disc(mask: Uint8Array, z: number, r: number, label = 1, cx = 10, cy = 10) {
  for (let y = 0; y < dims[1]; y++)
    for (let x = 0; x < dims[0]; x++) if (Math.hypot(x - cx, y - cy) <= r) mask[at(x, y, z)] = label;
}

function area(mask: Uint8Array, z: number, label = 1) {
  let n = 0;
  for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) if (mask[at(x, y, z)] === label) n++;
  return n;
}

describe('signedDistance', () => {
  it('is positive inside, negative outside and grows away from the edge', () => {
    const w = 7;
    const inside = new Uint8Array(w * w);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) inside[x + y * w] = 1;
    const d = signedDistance(inside, w, w);
    expect(d[3 + 3 * w]).toBeGreaterThan(d[2 + 2 * w]);
    expect(d[2 + 2 * w]).toBeGreaterThan(0);
    expect(d[1 + 3 * w]).toBeLessThan(0);
    expect(d[0 + 3 * w]).toBeLessThan(d[1 + 3 * w]);
  });
});

describe('interpolateSlices', () => {
  it('fills the slices between two painted ones with shapes in between', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    disc(mask, 1, 3);
    disc(mask, 7, 8);
    const small = area(mask, 1);
    const large = area(mask, 7);
    const changed = interpolateSlices(mask, dims, 1, 2);
    expect(changed).toBeGreaterThan(0);
    let previous = small;
    for (let z = 2; z <= 6; z++) {
      const a = area(mask, z);
      expect(a).toBeGreaterThanOrEqual(previous);
      expect(a).toBeLessThanOrEqual(large);
      previous = a;
    }
    expect(area(mask, 4)).toBeGreaterThan(small);
    expect(area(mask, 4)).toBeLessThan(large);
  });

  it('leaves painted slices and slices outside the range alone', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    disc(mask, 2, 4);
    disc(mask, 5, 4);
    const before = mask.slice();
    interpolateSlices(mask, dims, 1, 2);
    for (const z of [0, 1, 2, 5, 6, 7, 8]) {
      expect(area(mask, z)).toBe(area(before, z));
    }
    expect(area(mask, 3)).toBe(area(before, 2));
  });

  it('never overwrites another segment', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    disc(mask, 1, 6);
    disc(mask, 5, 6);
    disc(mask, 3, 2, 2);
    const other = area(mask, 3, 2);
    interpolateSlices(mask, dims, 1, 2);
    expect(area(mask, 3, 2)).toBe(other);
    expect(area(mask, 3, 1)).toBeGreaterThan(0);
  });

  it('follows a shape that moves between slices', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    disc(mask, 0, 3, 1, 6, 10);
    disc(mask, 4, 3, 1, 12, 10);
    interpolateSlices(mask, dims, 1, 2);
    expect(mask[at(9, 10, 2)]).toBe(1);
    expect(mask[at(3, 10, 2)]).toBe(0);
    expect(mask[at(15, 10, 2)]).toBe(0);
  });

  it('works along the other axes', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (const x of [4, 10])
      for (let z = 2; z <= 6; z++) for (let y = 6; y <= 14; y++) mask[at(x, y, z)] = 1;
    const changed = interpolateSlices(mask, dims, 1, 0);
    expect(changed).toBe(5 * 5 * 9);
    expect(mask[at(7, 10, 4)]).toBe(1);
  });

  it('does nothing with fewer than two painted slices or no gaps', () => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    disc(mask, 3, 4);
    expect(interpolateSlices(mask, dims, 1, 2)).toBe(0);
    disc(mask, 4, 4);
    expect(interpolateSlices(mask, dims, 1, 2)).toBe(0);
  });
});

describe('sliceAxisFor', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  it('maps the standard views to voxel axes', () => {
    expect(sliceAxisFor(identity, 'axial')).toBe(2);
    expect(sliceAxisFor(identity, 'sagittal')).toBe(0);
    expect(sliceAxisFor(identity, 'coronal')).toBe(1);
  });
  it('handles volumes stored in another orientation', () => {
    // i runs along world z, j along x, k along y
    const rotated = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    expect(sliceAxisFor(rotated, 'axial')).toBe(0);
    expect(sliceAxisFor(rotated, 'sagittal')).toBe(1);
    expect(sliceAxisFor(rotated, 'coronal')).toBe(2);
  });
});
