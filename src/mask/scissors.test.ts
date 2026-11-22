import { describe, expect, it } from 'vitest';
import {
  cut,
  cutsWithOutline,
  ellipseOutline,
  offScreen,
  rectangleOutline,
  sliceRange,
  thinOutline,
  viewMap,
  type CutAction,
  type PlaneMap,
  type Point,
  type ViewFrame,
} from './scissors';

type Dims = [number, number, number];

/** Voxel (i, j, k) sits at plane point (i, j), at depth k. */
const FLAT: PlaneMap = { x: [0, 1, 0, 0], y: [0, 0, 1, 0], depth: [0, 0, 0, 1] };
const SLICE_0: [number, number] = [-0.5, 0.5];
const ANY = new Uint8Array(256).fill(1);

function volume(dims: Dims, fill = 0) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]).fill(fill);
  const at = (x: number, y: number, z = 0) => x + y * dims[0] + z * dims[0] * dims[1];
  const count = (label = 1) => mask.reduce((n, v) => n + (v === label ? 1 : 0), 0);
  const set = (label = 1) => {
    const out: string[] = [];
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) if (mask[at(x, y, z)] === label) out.push(`${x},${y},${z}`);
    return out;
  };
  return { mask, at, count, set };
}

function run(mask: Uint8Array, dims: Dims, outline: Point[], action: CutAction, o: { map?: PlaneMap; depth?: [number, number] | null; label?: number; writable?: Uint8Array } = {}) {
  return cut(mask, dims, { map: o.map ?? FLAT, outline, depth: o.depth === undefined ? SLICE_0 : o.depth, action, label: o.label ?? 1, writable: o.writable ?? ANY });
}

/** Even-odd test of one point, the slow and obvious way. */
function inside(p: Point, outline: Point[]): boolean {
  let odd = false;
  for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
    const [ax, ay] = outline[a];
    const [bx, by] = outline[b];
    if (ay > p[1] !== by > p[1] && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) odd = !odd;
  }
  return odd;
}

/** A repeatable stream of numbers in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('filling inside an outline', () => {
  it('fills the voxels whose centres are inside, on one slice', () => {
    const dims: Dims = [8, 8, 3];
    const { mask, at, count } = volume(dims);
    expect(run(mask, dims, rectangleOutline([1.5, 1.5], [4.5, 4.5]), 'fill')).toBe(9);
    expect(count()).toBe(9);
    expect(mask[at(2, 2)]).toBe(1);
    expect(mask[at(4, 4)]).toBe(1);
    expect(mask[at(1, 2)]).toBe(0);
    expect(mask[at(5, 4)]).toBe(0);
    expect(mask[at(3, 3, 1)]).toBe(0);
  });

  it('gives a voxel centre on a shared edge to one side only', () => {
    const dims: Dims = [8, 8, 1];
    const { mask, count } = volume(dims);
    const left = run(mask, dims, rectangleOutline([0, 0], [3, 6]), 'fill');
    const right = run(mask, dims, rectangleOutline([3, 0], [6, 6]), 'fill', { label: 2 });
    expect(left).toBe(18);
    expect(right).toBe(18);
    expect(count(1)).toBe(18);
    expect(count(2)).toBe(18);
  });

  it('leaves the notch of a concave outline empty', () => {
    const dims: Dims = [10, 10, 1];
    const { mask, at } = volume(dims);
    // A "U": two arms and a base, open at the top.
    const u: Point[] = [[0.5, 0.5], [3.5, 0.5], [3.5, 5.5], [6.5, 5.5], [6.5, 0.5], [9.5, 0.5], [9.5, 8.5], [0.5, 8.5]];
    run(mask, dims, u, 'fill');
    expect(mask[at(2, 2)]).toBe(1);
    expect(mask[at(8, 2)]).toBe(1);
    expect(mask[at(5, 7)]).toBe(1);
    expect(mask[at(5, 2)]).toBe(0);
    expect(mask[at(4, 5)]).toBe(0);
  });

  it('uses the even-odd rule where an outline crosses itself', () => {
    const dims: Dims = [12, 12, 1];
    const { mask, at } = volume(dims);
    // Around the outside once, then around the middle: the middle is enclosed twice.
    const loop: Point[] = [[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5], [0.5, 0.5], [3.5, 3.5], [7.5, 3.5], [7.5, 7.5], [3.5, 7.5], [3.5, 3.5]];
    run(mask, dims, loop, 'fill');
    expect(mask[at(1, 5)]).toBe(1);
    expect(mask[at(9, 9)]).toBe(1);
    expect(mask[at(5, 5)]).toBe(0);
    // A bow tie: both lobes are inside.
    const tie = volume(dims);
    run(tie.mask, dims, [[1.5, 1.5], [9.5, 9.5], [9.5, 1.5], [1.5, 9.5]], 'fill');
    expect(tie.mask[tie.at(8, 5)]).toBe(1);
    expect(tie.mask[tie.at(3, 5)]).toBe(1);
    expect(tie.mask[tie.at(5, 2)]).toBe(0);
    expect(tie.mask[tie.at(5, 8)]).toBe(0);
  });

  it('changes nothing for an outline of fewer than three points', () => {
    const dims: Dims = [6, 6, 2];
    for (const action of ['fill', 'erase', 'eraseOutside'] as const) {
      const { mask } = volume(dims, 1);
      const before = mask.slice();
      expect(run(mask, dims, [[1, 1], [4, 4]], action, { label: action === 'fill' ? 2 : 1 })).toBe(0);
      expect(mask).toEqual(before);
    }
  });

  it('only writes over values it is allowed to', () => {
    const dims: Dims = [6, 6, 1];
    const { mask, at, count } = volume(dims);
    mask[at(2, 2)] = 2;
    mask[at(3, 2)] = 3;
    const writable = new Uint8Array(256);
    writable[0] = 1;
    writable[3] = 1;
    expect(run(mask, dims, rectangleOutline([1.5, 1.5], [3.5, 3.5]), 'fill', { writable })).toBe(3);
    expect(mask[at(2, 2)]).toBe(2);
    expect(mask[at(3, 2)]).toBe(1);
    expect(count()).toBe(3);
  });

  it('matches a point-by-point test on a tilted, stretched grid', () => {
    const dims: Dims = [14, 11, 6];
    const next = seeded(7);
    const map: PlaneMap = { x: [-3.1, 0.61, -0.37, 0.52], y: [1.7, 0.29, 0.83, -0.41], depth: [-2.2, 0.48, -0.22, 0.93] };
    const outline: Point[] = Array.from({ length: 9 }, () => [next() * 12 - 4, next() * 12 - 2] as Point);
    const depth: [number, number] = [-0.9, 1.4];
    const { mask, at } = volume(dims);
    run(mask, dims, outline, 'fill', { map, depth });
    let expected = 0;
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++) {
          const value = (c: readonly number[]) => c[0] + c[1] * i + c[2] * j + c[3] * k;
          const d = value(map.depth);
          const want = d >= depth[0] && d < depth[1] && inside([value(map.x), value(map.y)], outline);
          expect(mask[at(i, j, k)] === 1, `${i},${j},${k}`).toBe(want);
          if (want) expected++;
        }
    expect(expected).toBeGreaterThan(20);
  });
});

describe('erasing with an outline', () => {
  it('erases the segment inside and nothing of its neighbours', () => {
    const dims: Dims = [6, 6, 2];
    const { mask, at, count } = volume(dims, 1);
    mask[at(2, 2)] = 2;
    expect(run(mask, dims, rectangleOutline([0.5, 0.5], [3.5, 3.5]), 'erase')).toBe(8);
    expect(mask[at(2, 2)]).toBe(2);
    expect(mask[at(1, 1)]).toBe(0);
    expect(mask[at(1, 1, 1)]).toBe(1);
    expect(count()).toBe(72 - 9);
  });

  it('erases outside on this slice only', () => {
    const dims: Dims = [6, 6, 3];
    const { mask, at, count } = volume(dims, 1);
    mask[at(5, 5)] = 2;
    expect(run(mask, dims, rectangleOutline([0.5, 0.5], [3.5, 3.5]), 'eraseOutside')).toBe(36 - 9 - 1);
    expect(mask[at(2, 2)]).toBe(1);
    expect(mask[at(4, 4)]).toBe(0);
    expect(mask[at(5, 5)]).toBe(2);
    expect(count()).toBe(9 + 72);
  });

  it('erases outside through every slice when the depth is unlimited', () => {
    const dims: Dims = [6, 6, 3];
    const { mask, count, set } = volume(dims, 1);
    expect(run(mask, dims, rectangleOutline([0.5, 0.5], [3.5, 3.5]), 'eraseOutside', { depth: null })).toBe(3 * 27);
    expect(count()).toBe(27);
    expect(set().every((v) => /^[123],[123],/.test(v))).toBe(true);
  });

  it('works when the slices run along the first voxel axis', () => {
    const dims: Dims = [4, 6, 6];
    // A sagittal-like view: the plane shows (j, k) and the depth is i.
    const map: PlaneMap = { x: [0, 0, 1, 0], y: [0, 0, 0, 1], depth: [0, 1, 0, 0] };
    const { mask, set } = volume(dims);
    expect(run(mask, dims, rectangleOutline([0.5, 0.5], [2.5, 2.5]), 'fill', { map, depth: [1.5, 2.5] })).toBe(4);
    expect(set()).toEqual(['2,1,1', '2,2,1', '2,1,2', '2,2,2']);
    expect(run(mask, dims, rectangleOutline([0.5, 0.5], [1.5, 1.5]), 'eraseOutside', { map, depth: null })).toBe(3);
    expect(set()).toEqual(['2,1,1']);
  });
});

describe('a view over a volume', () => {
  const spacing: [number, number, number] = [0.7, 0.7, 5];
  const vol = { dims: [20, 20, 6] as Dims, spacing, origin: [10, -4, 30] as [number, number, number], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  // One screen pixel is 0.35 mm. Each frame looks at the middle of voxel (10, 10, 3).
  const focal: [number, number, number] = [10 + 7, -4 + 7, 30 + 15];
  const frames: Record<string, { frame: ViewFrame; axis: 0 | 1 | 2; across: number }> = {
    axial: { frame: { origin: [focal[0] - 35, focal[1] - 35, focal[2]], right: [0.35, 0, 0], down: [0, 0.35, 0], normal: [0, 0, -1], focal }, axis: 2, across: 20 * 20 },
    sagittal: { frame: { origin: [focal[0], focal[1] - 35, focal[2] + 35], right: [0, 0.35, 0], down: [0, 0, -0.35], normal: [1, 0, 0], focal }, axis: 0, across: 20 * 6 },
    coronal: { frame: { origin: [focal[0] - 35, focal[1], focal[2] + 35], right: [0.35, 0, 0], down: [0, 0, -0.35], normal: [0, -1, 0], focal }, axis: 1, across: 20 * 6 },
  };

  for (const [name, { frame, axis, across }] of Object.entries(frames)) {
    it(`cuts exactly one ${name} slice on thick-slice spacing`, () => {
      const { mask, set } = volume(vol.dims);
      const everything = rectangleOutline([-1000, -1000], [1000, 1000]);
      const n = cut(mask, vol.dims, { map: viewMap(vol, frame), outline: everything, depth: sliceRange(vol, frame, axis), action: 'fill', label: 1, writable: ANY });
      expect(n).toBe(across);
      const want = [10, 10, 3][axis];
      expect(set().every((v) => Number(v.split(',')[axis]) === want)).toBe(true);
    });
  }

  it('measures the outline in millimetres, not voxels', () => {
    const { frame } = frames.sagittal;
    const { mask, set } = volume(vol.dims);
    // 40 px wide is 14 mm: 20 voxels of 0.7 mm. 40 px tall is 14 mm: under three 5 mm slices.
    const outline = rectangleOutline([80, 80], [120, 120]);
    cut(mask, vol.dims, { map: viewMap(vol, frame), outline, depth: sliceRange(vol, frame, 0), action: 'fill', label: 1, writable: ANY });
    const ks = new Set(set().map((v) => v.split(',')[2]));
    const js = new Set(set().map((v) => v.split(',')[1]));
    expect([...ks].sort()).toEqual(['2', '3', '4']);
    expect(js.size).toBe(20);
  });

  it('follows a volume stored in another axis order', () => {
    // Voxel axis 0 runs along world z, axis 2 along world x.
    const turned = { dims: [6, 20, 20] as Dims, spacing: [5, 0.7, 0.7] as [number, number, number], origin: [10, -4, 30] as [number, number, number], direction: [0, 0, 1, 0, 1, 0, 1, 0, 0] };
    const f: [number, number, number] = [10 + 7, -4 + 7, 30 + 15];
    const frame: ViewFrame = { origin: [f[0] - 35, f[1] - 35, f[2]], right: [0.35, 0, 0], down: [0, 0.35, 0], normal: [0, 0, -1], focal: f };
    const { mask, set } = volume(turned.dims);
    const n = cut(mask, turned.dims, { map: viewMap(turned, frame), outline: rectangleOutline([-1000, -1000], [1000, 1000]), depth: sliceRange(turned, frame, 0), action: 'fill', label: 1, writable: ANY });
    expect(n).toBe(400);
    expect(set().every((v) => v.startsWith('3,'))).toBe(true);
  });
});

describe('outlines', () => {
  it('drops points closer together than the gap, and keeps the ends', () => {
    const drawn: Point[] = [[0, 0], [0.4, 0], [0.9, 0], [2, 0], [2.2, 0.1], [5, 5], [5.1, 5.1]];
    expect(thinOutline(drawn, 1)).toEqual([[0, 0], [2, 0], [5, 5], [5.1, 5.1]]);
  });

  it('makes a rectangle from two corners in any order', () => {
    expect(rectangleOutline([4, 1], [2, 5])).toEqual([[2, 1], [4, 1], [4, 5], [2, 5]]);
  });

  it('makes a circle from its centre and a point on its edge', () => {
    const circle = ellipseOutline([10, 10], [13, 14]);
    expect(circle.length).toBeGreaterThanOrEqual(48);
    for (const [x, y] of circle) expect(Math.hypot(x - 10, y - 10)).toBeCloseTo(5, 6);
  });
});

describe('which scissors do the cutting', () => {
  it('uses the outline code for freehand, erase outside and all slices', () => {
    expect(cutsWithOutline('freehand', 'erase', 'slice')).toBe(true);
    expect(cutsWithOutline('rectangle', 'outside', 'slice')).toBe(true);
    expect(cutsWithOutline('circle', 'fill', 'all')).toBe(true);
  });

  it('leaves a rectangle or circle on one slice, and the sphere, to the viewer', () => {
    expect(cutsWithOutline('rectangle', 'erase', 'slice')).toBe(false);
    expect(cutsWithOutline('circle', 'fill', 'slice')).toBe(false);
    expect(cutsWithOutline('sphere', 'outside', 'all')).toBe(false);
  });
});

describe('what a cut reaches outside the view', () => {
  const dims: Dims = [8, 8, 2];

  it('counts the voxels of the segment whose centres are off screen, on the slice only', () => {
    const v = volume(dims);
    // A view 4 pixels square that shows the corner of the slice: one voxel per pixel.
    for (let x = 0; x < 8; x++) v.mask[v.at(x, 1)] = 1;
    v.mask[v.at(6, 6)] = 2;
    v.mask[v.at(7, 7, 1)] = 1;
    expect(offScreen(v.mask, dims, { map: FLAT, depth: SLICE_0, label: 1 }, [4, 4])).toBe(4);
    expect(offScreen(v.mask, dims, { map: FLAT, depth: null, label: 1 }, [4, 4])).toBe(5);
    expect(offScreen(v.mask, dims, { map: FLAT, depth: SLICE_0, label: 1 }, [8, 8])).toBe(0);
  });

  it('follows the view when it is zoomed and panned', () => {
    const v = volume(dims);
    v.mask.fill(1, 0, 64);
    // Four pixels per voxel, panned so that voxels 2 to 5 are on screen each way.
    const zoomed: PlaneMap = { x: [-8, 4, 0, 0], y: [-8, 0, 4, 0], depth: [0, 0, 0, 1] };
    expect(offScreen(v.mask, dims, { map: zoomed, depth: SLICE_0, label: 1 }, [16, 16])).toBe(64 - 16);
  });

  it('tells what an erase outside took that could not be seen', () => {
    const v = volume(dims);
    for (let x = 0; x < 8; x++) v.mask[v.at(x, 1)] = 1;
    const view: [number, number] = [4, 4];
    const before = offScreen(v.mask, dims, { map: FLAT, depth: SLICE_0, label: 1 }, view);
    run(v.mask, dims, rectangleOutline([-0.5, 0.5], [1.5, 1.5]), 'eraseOutside');
    expect(v.set()).toEqual(['0,1,0', '1,1,0']);
    expect(before - offScreen(v.mask, dims, { map: FLAT, depth: SLICE_0, label: 1 }, view)).toBe(4);
  });
});
