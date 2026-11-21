import { voxelAt } from '../viewer/geometry';

interface Labelmap {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  data: ArrayLike<number>;
}

/**
 * The segment at a world point: the value of the voxel that holds it. 0 on
 * background, outside the volume, and for a segment that is not shown, so
 * only what can be seen can be picked.
 */
export function segmentAt(mask: Labelmap, world: ArrayLike<number>, segments: readonly { index: number; visible: boolean }[], maskHidden: boolean): number {
  if (maskHidden) return 0;
  const ijk = voxelAt(mask, world);
  if (!ijk) return 0;
  const value = mask.data[ijk[0] + (ijk[1] + ijk[2] * mask.dims[1]) * mask.dims[0]];
  return segments.some((seg) => seg.index === value && seg.visible) ? value : 0;
}
