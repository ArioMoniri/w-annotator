import type { VolumeData } from '../io/types';

type Geometry = Pick<VolumeData, 'dims' | 'spacing' | 'origin' | 'direction'>;

/** World (LPS, mm) to continuous voxel index. */
export function worldToIndex(vol: Geometry, w: ArrayLike<number>): [number, number, number] {
  const d = vol.direction;
  const x = w[0] - vol.origin[0];
  const y = w[1] - vol.origin[1];
  const z = w[2] - vol.origin[2];
  return [
    (d[0] * x + d[1] * y + d[2] * z) / vol.spacing[0],
    (d[3] * x + d[4] * y + d[5] * z) / vol.spacing[1],
    (d[6] * x + d[7] * y + d[8] * z) / vol.spacing[2],
  ];
}

export function indexToWorld(vol: Geometry, ijk: ArrayLike<number>): [number, number, number] {
  const d = vol.direction;
  const a = ijk[0] * vol.spacing[0];
  const b = ijk[1] * vol.spacing[1];
  const c = ijk[2] * vol.spacing[2];
  return [
    vol.origin[0] + d[0] * a + d[3] * b + d[6] * c,
    vol.origin[1] + d[1] * a + d[4] * b + d[7] * c,
    vol.origin[2] + d[2] * a + d[5] * b + d[8] * c,
  ];
}

/** Rounded voxel index, or null when the point is outside the volume. */
export function voxelAt(vol: Geometry, w: ArrayLike<number>): [number, number, number] | null {
  const f = worldToIndex(vol, w);
  const i = Math.round(f[0]);
  const j = Math.round(f[1]);
  const k = Math.round(f[2]);
  if (i < 0 || j < 0 || k < 0 || i >= vol.dims[0] || j >= vol.dims[1] || k >= vol.dims[2]) return null;
  return [i, j, k];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
