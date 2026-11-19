import { describe, expect, it } from 'vitest';
import type { ScalarArray, VolumeData } from './types';
import { autoWindow, labelValues, resampleNearest, sameGrid, toLabelmap, toRenderable } from './ops';

function vol(dims: [number, number, number], data: ScalarArray, g: Partial<VolumeData> = {}): VolumeData {
  return {
    name: 'v',
    dims,
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    data,
    ...g,
  };
}

describe('sameGrid', () => {
  const a = vol([3, 2, 2], new Uint8Array(12), { origin: [5, 6, 7], spacing: [0.5, 0.5, 2] });
  it('accepts identical grids and differences below the tolerance', () => {
    expect(sameGrid(a, { ...a })).toBe(true);
    expect(sameGrid(a, { ...a, origin: [5.004, 6, 7] })).toBe(true);
  });
  it('rejects different dims', () => {
    expect(sameGrid(a, vol([2, 3, 2], new Uint8Array(12), { origin: [5, 6, 7], spacing: [0.5, 0.5, 2] }))).toBe(false);
  });
  it('rejects a shifted origin', () => {
    expect(sameGrid(a, { ...a, origin: [5.02, 6, 7] })).toBe(false);
  });
  it('rejects a left-right flip', () => {
    expect(sameGrid(a, { ...a, direction: [-1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBe(false);
  });
  it('rejects a spacing error that adds up across the volume', () => {
    const p = vol([101, 1, 1], new Uint8Array(101));
    expect(sameGrid(p, { ...p, spacing: [1.00005, 1, 1] })).toBe(true);
    expect(sameGrid(p, { ...p, spacing: [1.001, 1, 1] })).toBe(false);
  });
  it('compares the slice thickness of a single-slice volume', () => {
    const p = vol([2, 2, 1], new Uint8Array(4));
    expect(sameGrid(p, { ...p, spacing: [1, 1, 3] })).toBe(false);
  });
  it('honours a custom tolerance', () => {
    expect(sameGrid(a, { ...a, origin: [5.02, 6, 7] }, 0.1)).toBe(true);
  });
});

describe('resampleNearest', () => {
  const src = vol([3, 2, 1], new Int16Array([1, 2, 3, 4, 5, 6]), { name: 'mask', labels: { 1: 'a' } });
  it('returns the same voxels on an identical grid, in a new array', () => {
    const out = resampleNearest(src, vol([3, 2, 1], new Uint8Array(6)));
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.data).not.toBe(src.data);
  });
  it('keeps the source array type, name and labels and takes the target geometry', () => {
    const target = vol([3, 2, 1], new Uint8Array(6), { origin: [2, 0, 0], direction: [-1, 0, 0, 0, 1, 0, 0, 0, 1], name: 't' });
    const out = resampleNearest(src, target);
    expect(out.data).toBeInstanceOf(Int16Array);
    expect(out.name).toBe('mask');
    expect(out.labels).toEqual({ 1: 'a' });
    expect(out.dims).toEqual([3, 2, 1]);
    expect(out.origin).toEqual([2, 0, 0]);
    expect(out.direction).toEqual(target.direction);
  });
  it('mirrors the data when the target x axis is flipped', () => {
    const target = vol([3, 2, 1], new Uint8Array(6), { origin: [2, 0, 0], direction: [-1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(Array.from(resampleNearest(src, target).data)).toEqual([3, 2, 1, 6, 5, 4]);
  });
  it('handles a target with swapped and flipped axes', () => {
    // target i runs along world -y, target j along world +x
    const target = vol([2, 3, 1], new Uint8Array(6), { origin: [0, 1, 0], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] });
    expect(Array.from(resampleNearest(src, target).data)).toEqual([4, 1, 5, 2, 6, 3]);
  });
  it('fills voxels outside the source with zero', () => {
    const target = vol([3, 2, 1], new Uint8Array(6), { origin: [1, 0, 0] });
    expect(Array.from(resampleNearest(src, target).data)).toEqual([2, 3, 0, 5, 6, 0]);
    const below = vol([1, 1, 2], new Uint8Array(2), { origin: [0, 0, -1] });
    expect(Array.from(resampleNearest(src, below).data)).toEqual([0, 1]);
  });
  it('picks the nearest voxel on a finer grid', () => {
    const target = vol([6, 1, 1], new Uint8Array(6), { origin: [-0.25, 0, 0], spacing: [0.5, 1, 1] });
    expect(Array.from(resampleNearest(src, target).data)).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it('respects anisotropic source spacing', () => {
    const s = vol([2, 1, 2], new Uint8Array([1, 2, 3, 4]), { spacing: [2, 1, 5] });
    const target = vol([4, 1, 2], new Uint8Array(8), { spacing: [1, 1, 5] });
    expect(Array.from(resampleNearest(s, target).data)).toEqual([1, 2, 2, 0, 3, 4, 4, 0]);
  });
});

describe('toLabelmap', () => {
  it('reuses a Uint8Array as is', () => {
    const v = vol([2, 1, 1], new Uint8Array([0, 3]));
    expect(toLabelmap(v).data).toBe(v.data);
  });
  it('converts integer and float data to Uint8, rounding floats', () => {
    const out = toLabelmap(vol([4, 1, 1], new Float32Array([0, 0.9999, 2.0001, 255]), { labels: { 1: 'x' } }));
    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.data)).toEqual([0, 1, 2, 255]);
    expect(out.labels).toEqual({ 1: 'x' });
    expect(Array.from(toLabelmap(vol([2, 1, 1], new Int16Array([7, 0]))).data)).toEqual([7, 0]);
  });
  it('refuses labels above 255, negative labels and NaN', () => {
    expect(() => toLabelmap(vol([2, 1, 1], new Uint16Array([1, 256])))).toThrow(/above 255/);
    expect(() => toLabelmap(vol([2, 1, 1], new Int16Array([1, -1])))).toThrow(/negative/);
    expect(() => toLabelmap(vol([2, 1, 1], new Float32Array([1, NaN])))).toThrow(/not a mask/i);
  });
});

describe('toRenderable', () => {
  it('passes renderer-ready types through untouched', () => {
    for (const d of [new Uint8Array(2), new Int8Array(2), new Uint16Array(2), new Int16Array(2), new Float32Array(2)]) {
      const v = vol([2, 1, 1], d);
      expect(toRenderable(v)).toBe(v);
    }
  });
  it('narrows integer-valued Int32, Uint32 and Float64 data to Int16', () => {
    for (const d of [new Int32Array([-32768, 32767]), new Uint32Array([0, 32767]), new Float64Array([-5, 12])]) {
      const out = toRenderable(vol([2, 1, 1], d));
      expect(out.data).toBeInstanceOf(Int16Array);
      expect(Array.from(out.data)).toEqual(Array.from(d));
    }
  });
  it('falls back to Float32 for out-of-range or fractional data', () => {
    const a = toRenderable(vol([2, 1, 1], new Int32Array([0, 32768])));
    expect(a.data).toBeInstanceOf(Float32Array);
    expect(Array.from(a.data)).toEqual([0, 32768]);
    const b = toRenderable(vol([2, 1, 1], new Float64Array([0.5, 1])));
    expect(b.data).toBeInstanceOf(Float32Array);
    expect(Array.from(b.data)).toEqual([0.5, 1]);
    expect(toRenderable(vol([2, 1, 1], new Uint32Array([0, 40000]))).data).toBeInstanceOf(Float32Array);
  });
});

describe('autoWindow', () => {
  it('uses the 0.5 and 99.5 percentiles and ignores outliers and NaN', () => {
    const d = new Float32Array(1002);
    for (let i = 0; i < 1000; i++) d[i] = i;
    d[1000] = NaN;
    d[1001] = 1e9;
    const w = autoWindow(vol([1002, 1, 1], d));
    expect(w.lower).toBeGreaterThanOrEqual(0);
    expect(w.lower).toBeLessThan(10);
    expect(w.upper).toBeGreaterThan(990);
    expect(w.upper).toBeLessThan(1000);
  });
  it('always returns lower < upper, even for constant or empty data', () => {
    const c = autoWindow(vol([4, 1, 1], new Int16Array([7, 7, 7, 7])));
    expect(c.lower).toBe(7);
    expect(c.upper).toBeGreaterThan(7);
    const n = autoWindow(vol([2, 1, 1], new Float32Array([NaN, NaN])));
    expect(n.lower).toBeLessThan(n.upper);
  });
  it('falls back to min and max when the percentiles coincide', () => {
    const d = new Uint8Array(1000);
    d[999] = 1;
    expect(autoWindow(vol([1000, 1, 1], d))).toEqual({ lower: 0, upper: 1 });
  });
  it('samples large volumes instead of sorting every voxel', () => {
    const n = 100 * 100 * 100;
    const d = new Int16Array(n);
    for (let i = 0; i < n; i++) d[i] = i % 1000;
    const w = autoWindow(vol([100, 100, 100], d));
    expect(w.lower).toBeLessThan(20);
    expect(w.upper).toBeGreaterThan(980);
  });
});

describe('labelValues', () => {
  it('lists the distinct non-zero labels in ascending order', () => {
    expect(labelValues(vol([6, 1, 1], new Uint8Array([0, 3, 1, 3, 0, 200])))).toEqual([1, 3, 200]);
    expect(labelValues(vol([5, 1, 1], new Int16Array([0, 300, -2, 300, 5])))).toEqual([-2, 5, 300]);
    expect(labelValues(vol([3, 1, 1], new Float32Array([0, 2, 2])))).toEqual([2]);
    expect(labelValues(vol([2, 1, 1], new Uint16Array([0, 0])))).toEqual([]);
  });
});
