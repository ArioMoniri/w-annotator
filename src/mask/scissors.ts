/**
 * Scissors: erase or fill with an outline drawn on a view. The outline is in
 * the plane of the view; a voxel is inside when its centre is, by the even-odd
 * rule, so a loop that crosses itself encloses what it goes around once. Works
 * for any view over any grid: voxel rows are cut against the outline in plane
 * coordinates, so thick slices and tilted volumes need no special case.
 */

export type Point = readonly [number, number];
type Vec3 = ArrayLike<number>;

/** A value that is linear in the voxel index: c[0] + c[1]·i + c[2]·j + c[3]·k. */
export type Affine = readonly [number, number, number, number];

/** Where a voxel centre lies in a view: across, down, and how far in front of or behind the view's plane. */
export interface PlaneMap {
  x: Affine;
  y: Affine;
  depth: Affine;
}

/** A view as it is on screen: the world point at its top-left pixel, one pixel right and down in mm, and the plane it shows. */
export interface ViewFrame {
  origin: Vec3;
  right: Vec3;
  down: Vec3;
  normal: Vec3;
  focal: Vec3;
}

interface Geometry {
  dims: ArrayLike<number>;
  spacing: ArrayLike<number>;
  origin: ArrayLike<number>;
  direction: ArrayLike<number>;
}

export type CutAction = 'erase' | 'eraseOutside' | 'fill';

export type ScissorsShape = 'rectangle' | 'circle' | 'freehand' | 'sphere';
export type ScissorsAction = 'erase' | 'outside' | 'fill';
export type ScissorsDepth = 'slice' | 'all';

/**
 * True when the app cuts with its own outline code: a freehand loop, erasing outside,
 * or cutting through every slice. A rectangle or circle on one slice, and the sphere,
 * are left to the viewer's own scissors.
 */
export function cutsWithOutline(shape: ScissorsShape, action: ScissorsAction, depth: ScissorsDepth): boolean {
  return shape !== 'sphere' && (shape === 'freehand' || action === 'outside' || depth === 'all');
}

export interface Cut {
  map: PlaneMap;
  /** In the units of `map.x` and `map.y`. Closed from the last point back to the first. */
  outline: readonly Point[];
  /** Depths to work on, from the first up to but not including the second; null for every depth. */
  depth: readonly [number, number] | null;
  action: CutAction;
  /** The segment erased or filled with. */
  label: number;
  /** For `fill`: 1 at each value that may be written over. */
  writable: Uint8Array;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Maps voxel centres of `vol` into a view: x and y in screen pixels, depth in mm from the plane on screen. */
export function viewMap(vol: Geometry, frame: ViewFrame): PlaneMap {
  const d = vol.direction;
  const axes = [0, 1, 2].map((a) => [d[a * 3] * vol.spacing[a], d[a * 3 + 1] * vol.spacing[a], d[a * 3 + 2] * vol.spacing[a]]);
  const along = (dir: Vec3, from: Vec3, scale: number): Affine => {
    const rel = [vol.origin[0] - from[0], vol.origin[1] - from[1], vol.origin[2] - from[2]];
    return [dot(rel, dir) / scale, dot(axes[0], dir) / scale, dot(axes[1], dir) / scale, dot(axes[2], dir) / scale];
  };
  return {
    x: along(frame.right, frame.origin, dot(frame.right, frame.right)),
    y: along(frame.down, frame.origin, dot(frame.down, frame.down)),
    depth: along(frame.normal, frame.focal, 1),
  };
}

/** The depths, in mm, that hold the slice on screen: the layer of voxels along `axis` nearest the view's plane. */
export function sliceRange(vol: Geometry, frame: ViewFrame, axis: 0 | 1 | 2): [number, number] {
  const d = vol.direction;
  const rel = [frame.focal[0] - vol.origin[0], frame.focal[1] - vol.origin[1], frame.focal[2] - vol.origin[2]];
  const column = [d[axis * 3], d[axis * 3 + 1], d[axis * 3 + 2]];
  const at = dot(rel, column) / vol.spacing[axis];
  const slice = Math.min(vol.dims[axis] - 1, Math.max(0, Math.round(at)));
  const lean = dot(column, frame.normal);
  const step = vol.spacing[axis] * Math.abs(lean);
  // Depth grows along the view normal, which may point either way along the voxel axis.
  const centre = (slice - at) * vol.spacing[axis] * lean;
  return [centre - step / 2, centre + step / 2];
}

/** A drawn line with points closer than `gap` to the last kept one left out. The first and last points stay. */
export function thinOutline(points: readonly Point[], gap: number): Point[] {
  const out: Point[] = [];
  for (let n = 0; n < points.length; n++) {
    const p = points[n];
    const last = out[out.length - 1];
    if (!last || n === points.length - 1 || Math.hypot(p[0] - last[0], p[1] - last[1]) >= gap) out.push(p);
  }
  return out;
}

export function rectangleOutline(a: Point, b: Point): Point[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** A circle around `centre` through `edge`, as a many-sided outline. */
export function ellipseOutline(centre: Point, edge: Point, sides = 72): Point[] {
  const r = Math.hypot(edge[0] - centre[0], edge[1] - centre[1]);
  return Array.from({ length: sides }, (_, n) => {
    const a = (n / sides) * 2 * Math.PI;
    return [centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)] as Point;
  });
}

/**
 * How many voxels of a segment, within the depths of a cut, have their centre outside a view
 * of `size` pixels. Counted before and after a cut, the difference is what the cut changed
 * where nobody could see it.
 */
export function offScreen(mask: Uint8Array, dims: ArrayLike<number>, c: Pick<Cut, 'map' | 'depth' | 'label'>, size: readonly [number, number]): number {
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  const { x, y, depth } = c.map;
  let count = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const base = (j + k * ny) * nx;
      const px = x[0] + x[2] * j + x[3] * k;
      const py = y[0] + y[2] * j + y[3] * k;
      const pd = depth[0] + depth[2] * j + depth[3] * k;
      for (let i = 0; i < nx; i++) {
        if (mask[base + i] !== c.label) continue;
        if (c.depth) {
          const d = pd + depth[1] * i;
          if (d < c.depth[0] || d >= c.depth[1]) continue;
        }
        const sx = px + x[1] * i;
        const sy = py + y[1] * i;
        if (sx < 0 || sy < 0 || sx >= size[0] || sy >= size[1]) count++;
      }
    }
  }
  return count;
}

const TINY = 1e-9;

/** Erases or fills with an outline. Returns how many voxels changed. */
export function cut(mask: Uint8Array, dims: ArrayLike<number>, c: Cut): number {
  const n = c.outline.length;
  if (n < 3) return 0;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  const { x, y, depth } = c.map;
  const { label, action, writable } = c;

  // Along a row of voxels (i changes), the centre moves by (dx, dy) in the plane.
  const dx = x[1];
  const dy = y[1];
  const len2 = dx * dx + dy * dy;
  const along = len2 > TINY;
  // Every outline point, as a distance across the row direction and a position along it.
  const across = new Float64Array(n);
  const position = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    across[p] = -dy * c.outline[p][0] + dx * c.outline[p][1];
    position[p] = along ? (dx * c.outline[p][0] + dy * c.outline[p][1]) / len2 : 0;
  }
  const hits = new Float64Array(n);
  let changed = 0;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      // The part of the row inside the depth range.
      let from = 0;
      let to = nx - 1;
      if (c.depth) {
        const d0 = depth[0] + depth[2] * j + depth[3] * k;
        const dd = depth[1];
        if (Math.abs(dd) < TINY) {
          if (d0 < c.depth[0] || d0 >= c.depth[1]) continue;
        } else {
          const a = (c.depth[0] - d0) / dd;
          const b = (c.depth[1] - d0) / dd;
          // Half-open in depth, whichever way depth runs along the row.
          if (dd > 0) {
            from = Math.max(from, Math.ceil(a));
            to = Math.min(to, Math.ceil(b) - 1);
          } else {
            from = Math.max(from, Math.floor(b) + 1);
            to = Math.min(to, Math.floor(a));
          }
          if (from > to) continue;
        }
      }
      const px = x[0] + x[2] * j + x[3] * k;
      const py = y[0] + y[2] * j + y[3] * k;
      const base = (j + k * ny) * nx;

      // Where the row crosses the outline, as positions along the row.
      let count = 0;
      if (along) {
        const s0 = -dy * px + dx * py;
        const t0 = (dx * px + dy * py) / len2;
        for (let p = 0, q = n - 1; p < n; q = p++) {
          const sp = across[p] - s0;
          const sq = across[q] - s0;
          if (sp <= 0 === sq <= 0) continue;
          hits[count++] = position[p] + (sp / (sp - sq)) * (position[q] - position[p]) - t0;
        }
        if (count > 1) hits.subarray(0, count).sort();
      } else {
        // The row runs straight through the view: one point decides for all of it.
        let odd = false;
        for (let p = 0, q = n - 1; p < n; q = p++) {
          const ay = c.outline[p][1];
          const by = c.outline[q][1];
          if (ay <= py === by <= py) continue;
          if (c.outline[p][0] + ((py - ay) / (by - ay)) * (c.outline[q][0] - c.outline[p][0]) > px) odd = !odd;
        }
        if (odd) {
          hits[0] = -Infinity;
          hits[1] = Infinity;
          count = 2;
        }
      }

      if (action === 'eraseOutside') {
        let i = from;
        for (let h = 0; h + 1 < count; h += 2) {
          const stop = Math.min(to, Math.ceil(hits[h]) - 1);
          for (; i <= stop; i++) {
            if (mask[base + i] === label) {
              mask[base + i] = 0;
              changed++;
            }
          }
          i = Math.max(i, Math.ceil(hits[h + 1]));
        }
        for (; i <= to; i++) {
          if (mask[base + i] === label) {
            mask[base + i] = 0;
            changed++;
          }
        }
        continue;
      }
      for (let h = 0; h + 1 < count; h += 2) {
        const first = Math.max(from, Math.ceil(hits[h]));
        const last = Math.min(to, Math.ceil(hits[h + 1]) - 1);
        for (let i = first; i <= last; i++) {
          const v = mask[base + i];
          if (action === 'erase') {
            if (v !== label) continue;
            mask[base + i] = 0;
          } else {
            if (v === label || !writable[v]) continue;
            mask[base + i] = label;
          }
          changed++;
        }
      }
    }
  }
  return changed;
}
