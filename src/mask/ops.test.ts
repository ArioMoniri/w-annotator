import { describe, expect, it } from 'vitest';
import {
  combine,
  fillHoles,
  fillHolesPerSlice,
  formatVolume,
  formatVoxels,
  grow,
  keepLargestIsland,
  removeSmallIslands,
  segmentStats,
  shrink,
  smooth,
  statsCsv,
} from './ops';

type Dims = [number, number, number];

function volume(dims: Dims) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const at = (x: number, y: number, z: number) => x + y * dims[0] + z * dims[0] * dims[1];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, label = 1) => {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[at(x, y, z)] = label;
  };
  const count = (label = 1) => mask.reduce((n, v) => n + (v === label ? 1 : 0), 0);
  return { mask, at, box, count };
}

const ISO: Dims = [1, 1, 1];

describe('grow', () => {
  it('grows one voxel into its six neighbours at 1 mm', () => {
    const dims: Dims = [5, 5, 5];
    const { mask, at, count } = volume(dims);
    mask[at(2, 2, 2)] = 1;
    expect(grow(mask, dims, ISO, 1, 1)).toBe(6);
    expect(count()).toBe(7);
    for (const [x, y, z] of [[1, 2, 2], [3, 2, 2], [2, 1, 2], [2, 3, 2], [2, 2, 1], [2, 2, 3]]) expect(mask[at(x, y, z)]).toBe(1);
    expect(mask[at(1, 1, 2)]).toBe(0);
  });

  it('measures in millimetres, so thick slices are not crossed', () => {
    const dims: Dims = [7, 7, 5];
    const { mask, at, count } = volume(dims);
    mask[at(3, 3, 2)] = 1;
    // 2 mm reaches 13 voxels in the plane and none of the slices 3 mm away.
    expect(grow(mask, dims, [1, 1, 3], 1, 2)).toBe(12);
    expect(count()).toBe(13);
    expect(mask[at(3, 3, 1)]).toBe(0);
    expect(mask[at(5, 3, 2)]).toBe(1);
    expect(mask[at(4, 4, 2)]).toBe(1);
    expect(mask[at(5, 4, 2)]).toBe(0);
  });

  it('reaches a neighbour exactly one voxel away on fractional spacing', () => {
    const dims: Dims = [5, 5, 5];
    const { mask, at } = volume(dims);
    mask[at(2, 2, 2)] = 1;
    expect(grow(mask, dims, [0.7, 0.7, 0.7], 1, 0.7)).toBe(6);
  });

  it('only grows into empty voxels', () => {
    const dims: Dims = [5, 1, 1];
    const { mask } = volume(dims);
    mask.set([0, 1, 2, 2, 0]);
    expect(grow(mask, dims, ISO, 1, 3)).toBe(2);
    expect(Array.from(mask)).toEqual([1, 1, 2, 2, 1]);
  });

  it('stops at the edge of the volume and does nothing without the label', () => {
    const dims: Dims = [3, 3, 1];
    const { mask, at, count } = volume(dims);
    mask[at(0, 0, 0)] = 1;
    expect(grow(mask, dims, ISO, 1, 1)).toBe(2);
    expect(count()).toBe(3);
    expect(grow(mask, dims, ISO, 4, 1)).toBe(0);
    expect(grow(mask, dims, ISO, 1, 0)).toBe(0);
  });
});

describe('shrink', () => {
  it('peels one layer off a cube at 1 mm', () => {
    const dims: Dims = [7, 7, 7];
    const { mask, at, box, count } = volume(dims);
    box(2, 2, 2, 4, 4, 4);
    expect(shrink(mask, dims, ISO, 1, 1)).toBe(26);
    expect(count()).toBe(1);
    expect(mask[at(3, 3, 3)]).toBe(1);
  });

  it('measures in millimetres on anisotropic voxels', () => {
    const dims: Dims = [9, 9, 5];
    const { mask, box, count } = volume(dims);
    box(2, 2, 1, 6, 6, 3);
    // 1 mm takes one voxel in the plane, but the next slice is 3 mm away.
    expect(shrink(mask, dims, [1, 1, 3], 1, 1)).toBe(75 - 27);
    expect(count()).toBe(27);
  });

  it('does not shrink from the edge of the volume', () => {
    const dims: Dims = [3, 3, 3];
    const { mask, box } = volume(dims);
    box(0, 0, 0, 2, 2, 2);
    expect(shrink(mask, dims, ISO, 1, 1)).toBe(0);
  });

  it('treats another segment as outside and leaves it alone', () => {
    const dims: Dims = [6, 1, 1];
    const { mask } = volume(dims);
    mask.set([1, 1, 1, 2, 2, 0]);
    expect(shrink(mask, dims, ISO, 1, 1)).toBe(1);
    expect(Array.from(mask)).toEqual([1, 1, 0, 2, 2, 0]);
  });
});

describe('grow and shrink against a brute-force search', () => {
  it('match on a seeded random shape with uneven spacing', () => {
    const dims: Dims = [12, 10, 7];
    const spacing = [0.8, 1.3, 2.5];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const source = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (let i = 0; i < source.length; i++) source[i] = random() < 0.08 ? 1 : random() < 0.05 ? 2 : 0;
    const nearest = (x: number, y: number, z: number, isTarget: (v: number) => boolean) => {
      let best = Infinity;
      for (let c = 0; c < dims[2]; c++)
        for (let b = 0; b < dims[1]; b++)
          for (let a = 0; a < dims[0]; a++)
            if (isTarget(source[a + b * dims[0] + c * dims[0] * dims[1]]))
              best = Math.min(best, Math.hypot((a - x) * spacing[0], (b - y) * spacing[1], (c - z) * spacing[2]));
      return best;
    };
    for (const mm of [1.3, 2.6]) {
      const grown = source.slice();
      const shrunk = source.slice();
      grow(grown, dims, spacing, 1, mm);
      shrink(shrunk, dims, spacing, 1, mm);
      for (let z = 0, i = 0; z < dims[2]; z++)
        for (let y = 0; y < dims[1]; y++)
          for (let x = 0; x < dims[0]; x++, i++) {
            const v = source[i];
            const wantGrown = v === 0 && nearest(x, y, z, (t) => t === 1) <= mm + 1e-6 ? 1 : v;
            const wantShrunk = v === 1 && nearest(x, y, z, (t) => t !== 1) <= mm + 1e-6 ? 0 : v;
            if (grown[i] !== wantGrown || shrunk[i] !== wantShrunk) throw new Error(`differs at ${x},${y},${z} for ${mm} mm`);
          }
    }
  });
});

describe('islands', () => {
  it('keeps the largest island and removes the rest', () => {
    const dims: Dims = [8, 8, 8];
    const { mask, at, box, count } = volume(dims);
    box(1, 1, 1, 2, 2, 2);
    mask[at(6, 6, 6)] = 1;
    mask[at(5, 1, 1)] = 1;
    mask[at(5, 2, 1)] = 1;
    mask[at(7, 7, 0)] = 2;
    expect(keepLargestIsland(mask, dims, 1)).toBe(3);
    expect(count()).toBe(8);
    expect(count(2)).toBe(1);
    expect(keepLargestIsland(mask, dims, 1)).toBe(0);
  });

  it('does not join voxels that only touch at a corner or an edge', () => {
    const dims: Dims = [4, 4, 4];
    const { mask, at, box } = volume(dims);
    box(0, 0, 0, 1, 1, 0);
    mask[at(2, 2, 0)] = 1;
    mask[at(2, 1, 1)] = 1;
    expect(keepLargestIsland(mask, dims, 1)).toBe(2);
  });

  it('joins a U shape whose arms meet late in the scan', () => {
    const dims: Dims = [5, 4, 1];
    const { mask } = volume(dims);
    // prettier-ignore
    mask.set([
      1, 0, 1, 0, 1,
      1, 0, 1, 0, 1,
      1, 1, 1, 0, 1,
      0, 0, 0, 0, 1,
    ]);
    expect(keepLargestIsland(mask, dims, 1)).toBe(4);
    expect(mask[4]).toBe(0);
    expect(mask[2]).toBe(1);
  });

  it('removes islands smaller than a volume in cubic millimetres', () => {
    const dims: Dims = [8, 3, 1];
    const { mask, count } = volume(dims);
    // One voxel is 2 mm³: islands of 2, 6 and 4 mm³.
    mask.set([1, 0, 1, 1, 1, 0, 1, 1]);
    expect(removeSmallIslands(mask, dims, [1, 1, 2], 1, 5)).toBe(3);
    expect(Array.from(mask.subarray(0, 8))).toEqual([0, 0, 1, 1, 1, 0, 0, 0]);
    expect(removeSmallIslands(mask, dims, [1, 1, 2], 1, 6)).toBe(0);
    expect(count()).toBe(3);
  });
});

describe('fillHoles', () => {
  it('fills a closed cavity', () => {
    const dims: Dims = [5, 5, 5];
    const { mask, at, box } = volume(dims);
    box(1, 1, 1, 3, 3, 3);
    mask[at(2, 2, 2)] = 0;
    expect(fillHoles(mask, dims, 1)).toBe(1);
    expect(mask[at(2, 2, 2)]).toBe(1);
  });

  it('leaves a cavity that opens to the outside', () => {
    const dims: Dims = [5, 5, 5];
    const { mask, at, box } = volume(dims);
    box(1, 1, 1, 3, 3, 3);
    mask[at(2, 2, 2)] = 0;
    mask[at(2, 2, 3)] = 0;
    expect(fillHoles(mask, dims, 1)).toBe(0);
  });

  it('leaves a cavity that is only closed by the edge of the volume', () => {
    const dims: Dims = [3, 3, 3];
    const { mask, at, box } = volume(dims);
    box(0, 0, 0, 2, 2, 2);
    mask[at(1, 1, 0)] = 0;
    expect(fillHoles(mask, dims, 1)).toBe(0);
  });

  it('fills around another segment inside the cavity without overwriting it', () => {
    const dims: Dims = [7, 7, 7];
    const { mask, at, box, count } = volume(dims);
    box(1, 1, 1, 5, 5, 5);
    box(2, 2, 2, 4, 4, 4, 0);
    mask[at(3, 3, 3)] = 2;
    expect(fillHoles(mask, dims, 1)).toBe(26);
    expect(count(2)).toBe(1);
    expect(count()).toBe(124);
  });

  it('fills a ring slice by slice along the chosen axis only', () => {
    const dims: Dims = [5, 5, 3];
    const ring = () => {
      const v = volume(dims);
      v.box(1, 1, 1, 3, 3, 1);
      v.mask[v.at(2, 2, 1)] = 0;
      return v;
    };
    const a = ring();
    expect(fillHoles(a.mask, dims, 1)).toBe(0);
    expect(fillHolesPerSlice(a.mask, dims, 1, 0)).toBe(0);
    expect(fillHolesPerSlice(a.mask, dims, 1, 1)).toBe(0);
    expect(fillHolesPerSlice(a.mask, dims, 1, 2)).toBe(1);
    expect(a.mask[a.at(2, 2, 1)]).toBe(1);
  });

  it('fills per slice across the first axis and keeps other segments', () => {
    const dims: Dims = [3, 6, 6];
    const { mask, at, box } = volume(dims);
    box(1, 1, 1, 1, 4, 4);
    mask[at(1, 2, 2)] = 0;
    mask[at(1, 3, 2)] = 2;
    expect(fillHolesPerSlice(mask, dims, 1, 0)).toBe(1);
    expect(mask[at(1, 2, 2)]).toBe(1);
    expect(mask[at(1, 3, 2)]).toBe(2);
  });
});

describe('smooth', () => {
  it('closes a cavity, drops a stray voxel and rounds the edges of a cube', () => {
    const dims: Dims = [11, 9, 9];
    const { mask, at, box, count } = volume(dims);
    box(1, 2, 2, 5, 6, 6);
    mask[at(3, 4, 4)] = 0;
    mask[at(9, 4, 4)] = 1;
    // In: 125 − 1 + 1. Out: the cube without its 44 edge voxels.
    expect(smooth(mask, dims, ISO, 1, 1)).toBe(46);
    expect(count()).toBe(81);
    expect(mask[at(3, 4, 4)]).toBe(1);
    expect(mask[at(9, 4, 4)]).toBe(0);
    expect(mask[at(1, 2, 2)]).toBe(0);
    expect(mask[at(1, 4, 4)]).toBe(1);
  });

  it('does not wear away a block that is cut off by the edge of the volume', () => {
    const dims: Dims = [6, 6, 6];
    const { mask, box, count } = volume(dims);
    box(0, 0, 0, 5, 5, 2);
    expect(smooth(mask, dims, ISO, 1, 1)).toBe(0);
    expect(count()).toBe(108);
  });

  it('never changes another segment', () => {
    const dims: Dims = [11, 9, 9];
    const { mask, at, box, count } = volume(dims);
    box(1, 2, 2, 5, 6, 6);
    box(6, 2, 2, 8, 6, 6, 2);
    mask[at(3, 4, 4)] = 2;
    smooth(mask, dims, ISO, 1, 1);
    expect(count(2)).toBe(76);
    expect(mask[at(3, 4, 4)]).toBe(2);
  });
});

describe('combine', () => {
  it('adds the other segment into the target', () => {
    const mask = Uint8Array.from([1, 2, 0, 2, 3]);
    expect(combine(mask, 1, 2, 'union')).toBe(2);
    expect(Array.from(mask)).toEqual([1, 1, 0, 1, 3]);
  });

  it('subtract changes nothing and intersect empties the target, because segments never overlap', () => {
    const mask = Uint8Array.from([1, 2, 0, 1, 3]);
    expect(combine(mask, 1, 2, 'subtract')).toBe(0);
    expect(Array.from(mask)).toEqual([1, 2, 0, 1, 3]);
    expect(combine(mask, 1, 2, 'intersect')).toBe(2);
    expect(Array.from(mask)).toEqual([0, 2, 0, 0, 3]);
  });

  it('ignores a segment combined with itself or with the background', () => {
    const mask = Uint8Array.from([1, 2, 0]);
    expect(combine(mask, 1, 1, 'intersect')).toBe(0);
    expect(combine(mask, 1, 0, 'union')).toBe(0);
    expect(Array.from(mask)).toEqual([1, 2, 0]);
  });
});

describe('segmentStats', () => {
  it('gives count, volume, intensity summary and centre per segment', () => {
    const dims: Dims = [4, 2, 2];
    const { mask, at } = volume(dims);
    const image = new Int16Array(16);
    for (const [x, y, z, v] of [[0, 0, 0, 10], [1, 0, 0, 20], [3, 1, 1, 30]]) {
      mask[at(x, y, z)] = 1;
      image[at(x, y, z)] = v;
    }
    mask[at(2, 1, 0)] = 5;
    image[at(2, 1, 0)] = -7;
    const stats = segmentStats(mask, image, dims, [1, 2, 5]);
    expect(stats.map((s) => s.label)).toEqual([1, 5]);
    const [one, five] = stats;
    expect(one.voxels).toBe(3);
    expect(one.volumeMl).toBeCloseTo(0.03, 10);
    expect(one.mean).toBeCloseTo(20, 10);
    expect(one.sd).toBeCloseTo(Math.sqrt(200 / 3), 10);
    expect([one.min, one.max]).toEqual([10, 30]);
    expect(one.centre).toEqual([1.5, 0.5, 0.5]);
    expect(five).toMatchObject({ voxels: 1, mean: -7, sd: 0, min: -7, max: -7, centre: [2, 1, 0] });
  });

  it('works without an image', () => {
    const stats = segmentStats(Uint8Array.from([0, 3]), null, [2, 1, 1], ISO);
    expect(stats).toHaveLength(1);
    expect(stats[0].voxels).toBe(1);
    expect(stats[0].mean).toBeNaN();
  });
});

describe('formatting', () => {
  it('shows millilitres, and cubic millimetres for small volumes', () => {
    expect(formatVolume(12.44)).toBe('12.4 mL');
    expect(formatVolume(0.8)).toBe('0.8 mL');
    expect(formatVolume(0.32)).toBe('320 mm³');
    expect(formatVolume(1234.5)).toBe('1,235 mL');
    expect(formatVolume(0)).toBe('');
  });

  it('says how much a number of voxels is, in the same units as a volume', () => {
    expect(formatVoxels(222, [1, 1, 1])).toBe('222 mm³');
    expect(formatVoxels(482_791, [1, 1, 1])).toBe('483 mL');
    expect(formatVoxels(1000, [0.5, 0.5, 2])).toBe('0.5 mL');
    expect(formatVoxels(1, [0.5, 0.5, 0.5])).toBe('1 mm³');
    expect(formatVoxels(0, [1, 1, 1])).toBe('');
  });

  it('writes the measurements as CSV with quoted names', () => {
    const stats = segmentStats(Uint8Array.from([1, 1, 2]), Float32Array.from([1, 3, 2.5]), [3, 1, 1], [10, 10, 10]);
    const csv = statsCsv(stats, (label) => (label === 1 ? 'Liver, left "lobe"' : 'Tumour'));
    expect(csv.split('\n')).toEqual([
      'Segment,Label,Volume (mL),Voxels,Mean,SD,Min,Max',
      '"Liver, left ""lobe""",1,2,2,2,1,1,3',
      'Tumour,2,1,1,2.5,0,2.5,2.5',
    ]);
  });
});
