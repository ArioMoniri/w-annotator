/**
 * Brush size rules. The size the user sees is a diameter in millimetres. A voxel is
 * painted when its centre is inside the brush, so a brush much smaller than a voxel
 * would paint nothing: the radius handed to the tools never drops below what reaches
 * the voxel under the cursor.
 */

export const BRUSH_MAX = 100;

/** Just over half a voxel diagonal, so a cursor on a voxel corner still reaches a centre. */
const REACH = 0.505;

const usable = (mm: number) => (Number.isFinite(mm) && mm > 0 ? mm : 1);

/**
 * The smallest radius, in mm, that paints at least one voxel wherever the cursor is on
 * a slice. `sliceAxis` is the voxel axis that runs through the slices of the view.
 */
export function minBrushRadius(spacing: readonly number[], sliceAxis: 0 | 1 | 2): number {
  const [a, b] = [0, 1, 2].filter((k) => k !== sliceAxis).map((k) => usable(spacing[k]));
  return REACH * Math.hypot(a, b);
}

/** The radius the tools get for a diameter of `size` mm on a view. */
export function brushRadius(size: number, spacing: readonly number[], sliceAxis: 0 | 1 | 2): number {
  return Math.max(size / 2, minBrushRadius(spacing, sliceAxis));
}

/** The smallest diameter worth offering for an image: one that paints on its finest plane. Rounded up to 0.1 mm. */
export function minBrushSize(spacing: readonly number[]): number {
  const radius = Math.min(...([0, 1, 2] as const).map((axis) => minBrushRadius(spacing, axis)));
  const size = Math.ceil(radius * 2 * 10 - 1e-9) / 10;
  return Math.min(Math.max(size, 0.1), BRUSH_MAX / 2);
}

/** A size as it is kept and shown: one decimal below 5 mm, whole millimetres above, inside the limits. */
export function cleanBrushSize(mm: number, min: number): number {
  if (!Number.isFinite(mm)) return min;
  const tenth = Math.round(mm * 10) / 10;
  const rounded = tenth < 5 ? tenth : Math.round(mm);
  return Math.min(BRUSH_MAX, Math.max(min, rounded));
}

/** One press of the smaller or larger shortcut. */
export function stepBrushSize(size: number, direction: 1 | -1, min: number): number {
  const up = direction > 0;
  const step = (up ? size >= 10 : size > 10) ? 2 : (up ? size >= 5 : size > 5) ? 1 : 0.5;
  return cleanBrushSize(size + direction * step, min);
}
