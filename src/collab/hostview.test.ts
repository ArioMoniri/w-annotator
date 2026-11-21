import { describe, expect, it } from 'vitest';
import { decodeSlice, encodeSlice, indicesForPlane, planeLength, planeSlices, readPlane, windowTo8, writePlane } from './hostview';

const dims: [number, number, number] = [2, 3, 4];
/** Voxel value = 100·k + 10·j + i, so a plane can be read off by eye. */
const volume = () => {
  const d = new Int16Array(2 * 3 * 4);
  for (let k = 0; k < 4; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) d[k * 6 + j * 2 + i] = 100 * k + 10 * j + i;
  return d;
};

describe('planes', () => {
  it('reads a plane along each axis', () => {
    const v = volume();
    expect(Array.from(readPlane(v, dims, 2, 1))).toEqual([100, 101, 110, 111, 120, 121]);
    expect(Array.from(readPlane(v, dims, 1, 2))).toEqual([20, 21, 120, 121, 220, 221, 320, 321]);
    expect(Array.from(readPlane(v, dims, 0, 1))).toEqual([1, 11, 21, 101, 111, 121, 201, 211, 221, 301, 311, 321]);
    expect(planeLength(dims, 0)).toBe(12);
    expect(planeLength(dims, 1)).toBe(8);
    expect(planeLength(dims, 2)).toBe(6);
  });

  it('writes a plane back to the same voxels and nowhere else', () => {
    for (const axis of [0, 1, 2] as const) {
      const v = volume();
      const out = new Int16Array(v.length);
      writePlane(out, dims, axis, 1, readPlane(v, dims, axis, 1));
      for (let k = 0; k < 4; k++)
        for (let j = 0; j < 3; j++)
          for (let i = 0; i < 2; i++) {
            const on = [i, j, k][axis] === 1;
            expect(out[k * 6 + j * 2 + i]).toBe(on ? v[k * 6 + j * 2 + i] : 0);
          }
    }
  });

  it('knows which stored slices a plane touches', () => {
    expect(planeSlices(dims, 2, 3)).toEqual([3]);
    expect(planeSlices(dims, 0, 1)).toEqual([0, 1, 2, 3]);
  });
});

describe('windowTo8', () => {
  it('maps the window to 0 to 255 and clips outside it', () => {
    const out = windowTo8(Int16Array.from([-2000, -1000, 0, 1000, 3000]), -1000, 1000);
    expect(Array.from(out)).toEqual([0, 0, 128, 255, 255]);
  });
  it('keeps nothing of the values beyond eight bits', () => {
    const out = windowTo8(Float32Array.from([0.1, 0.2, 0.3]), 0, 1);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([26, 51, 77]);
  });
  it('copes with an empty window', () => {
    expect(Array.from(windowTo8(Int16Array.from([4, 5, 6]), 5, 5))).toEqual([0, 255, 255]);
  });
});

describe('slice messages', () => {
  it('carry the 8-bit picture and the labels of one plane', () => {
    const image = Uint8Array.from([0, 64, 128, 255, 1, 2]);
    const labels = Uint8Array.from([0, 0, 1, 1, 2, 0]);
    const back = decodeSlice(encodeSlice(image, labels), 6);
    expect(Array.from(back!.image)).toEqual(Array.from(image));
    expect(Array.from(back!.labels)).toEqual(Array.from(labels));
  });
  it('refuses a plane of the wrong size', () => {
    const bytes = encodeSlice(new Uint8Array(6), new Uint8Array(6));
    expect(decodeSlice(bytes, 8)).toBeNull();
    expect(decodeSlice(new Uint8Array([1, 2, 3]), 6)).toBeNull();
  });
});

describe('indicesForPlane', () => {
  const geom = { dims: [64, 64, 40] as [number, number, number], spacing: [1, 1, 2] as [number, number, number], origin: [10, 20, 30] as [number, number, number], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

  it('is one index when the view is aligned with the volume', () => {
    expect(indicesForPlane(geom, 2, [0, 0, 30 + 2 * 7], [0, 0, 1])).toEqual([7]);
    expect(indicesForPlane(geom, 0, [10 + 12, 0, 0], [1, 0, 0])).toEqual([12]);
    expect(indicesForPlane(geom, 1, [0, 20 + 33.4, 0], [0, -1, 0])).toEqual([33]);
  });

  it('follows a flipped axis', () => {
    const flipped = { ...geom, direction: [1, 0, 0, 0, 1, 0, 0, 0, -1] };
    expect(indicesForPlane(flipped, 2, [0, 0, 30 - 2 * 5], [0, 0, 1])).toEqual([5]);
  });

  it('is empty outside the volume', () => {
    expect(indicesForPlane(geom, 2, [0, 0, 30 + 2 * 60], [0, 0, 1])).toEqual([]);
    expect(indicesForPlane(geom, 2, [0, 0, 0], [0, 0, 1])).toEqual([]);
  });

  it('covers every index a tilted view cuts through, up to a limit', () => {
    // Tilted so that across 63 voxels in y the plane climbs about 3 slices.
    const n: [number, number, number] = [0, -0.1, 1];
    const got = indicesForPlane(geom, 2, [10, 20, 30 + 2 * 10], n);
    expect(got[0]).toBe(10);
    expect(got[got.length - 1]).toBe(13);
    const steep = indicesForPlane(geom, 2, [10, 20 + 32, 30 + 2 * 20], [0, -2, 1], 8);
    expect(steep.length).toBe(8);
    expect(steep).toContain(20);
  });
});
