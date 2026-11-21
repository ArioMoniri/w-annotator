/**
 * Fill between slices, shown before it is done. The proposal is drawn from a
 * buffer of its own; the mask is not written until `apply`, so nothing reaches
 * the undo history, the recovery copy or a room before then.
 */
import { interpolateSlices, interpolatedVoxels } from './interpolate';

type Dims = [number, number, number];

/** The two values a preview buffer holds. They are drawn in one colour at two strengths, as stripes. */
export const PREVIEW_DARK = 1;
export const PREVIEW_LIGHT = 2;

export interface FillRequest {
  label: number;
  /** The voxel axis that runs through the slices being joined. */
  axis: 0 | 1 | 2;
  /** 1 at every value the fill may write over. */
  writable: Uint8Array;
}

/** Marks `voxels` in `shown` as diagonal stripes, two voxels wide, across the slices along `axis`. */
export function previewLabels(shown: Uint8Array, dims: Dims, voxels: Uint32Array, axis: 0 | 1 | 2): void {
  const [nx, ny] = dims;
  for (let n = 0; n < voxels.length; n++) {
    const o = voxels[n];
    const x = o % nx;
    const y = Math.floor(o / nx) % ny;
    const z = Math.floor(o / (nx * ny));
    const sum = axis === 0 ? y + z : axis === 1 ? x + z : x + y;
    shown[o] = (sum >> 1) & 1 ? PREVIEW_LIGHT : PREVIEW_DARK;
  }
}

export class FillPreview {
  private request: FillRequest | null = null;
  private voxels: Uint32Array | null = null;

  get active(): boolean {
    return this.request !== null;
  }

  /** How many voxels the preview on screen proposes. */
  get count(): number {
    return this.voxels?.length ?? 0;
  }

  /**
   * Works out the fill and marks it in `shown`. The mask is only read. Returns the
   * number of voxels proposed; with none, no preview is started.
   */
  start(mask: Uint8Array, dims: Dims, request: FillRequest, shown: Uint8Array): number {
    this.cancel(shown);
    const voxels = interpolatedVoxels(mask, dims, request.label, request.axis, request.writable);
    if (voxels.length === 0) return 0;
    this.request = request;
    this.voxels = voxels;
    previewLabels(shown, dims, voxels, request.axis);
    return voxels.length;
  }

  /**
   * Does the fill on the mask as it is now, which may have changed since the preview
   * was shown, and ends the preview. Returns the number of voxels set.
   */
  apply(mask: Uint8Array, dims: Dims, shown: Uint8Array): number {
    const request = this.request;
    if (!request) return 0;
    this.cancel(shown);
    return interpolateSlices(mask, dims, request.label, request.axis, request.writable);
  }

  /** Ends the preview and clears its marks. False when there was none. */
  cancel(shown: Uint8Array): boolean {
    if (!this.request) return false;
    if (this.voxels) for (let n = 0; n < this.voxels.length; n++) shown[this.voxels[n]] = 0;
    this.request = null;
    this.voxels = null;
    return true;
  }
}
