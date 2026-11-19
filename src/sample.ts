/**
 * A small synthetic image and a two-label mask for the welcome tour, made in
 * code so the app ships with no image data. It is a phantom, not anatomy: an
 * ellipsoid "body" in air with two blobs and a bright rod, laid out off-centre
 * so left and right can be told apart.
 */

export const SAMPLE_IMAGE_NAME = 'sample_image.nii';
export const SAMPLE_MASK_NAME = 'sample_mask.nii';

const DIMS = [64, 64, 48] as const;
const SPACING = [1, 1, 1.5] as const;

/** A minimal NIfTI-1 file: little-endian, sform set to the spacing, no extensions. */
function nifti(data: Int16Array | Uint8Array, dtype: number, bitpix: number): Uint8Array {
  const buf = new ArrayBuffer(352 + data.byteLength);
  const v = new DataView(buf);
  v.setInt32(0, 348, true);
  v.setInt16(40, 3, true);
  DIMS.forEach((d, i) => v.setInt16(42 + i * 2, d, true));
  v.setInt16(70, dtype, true);
  v.setInt16(72, bitpix, true);
  v.setFloat32(76, 1, true);
  SPACING.forEach((s, i) => v.setFloat32(80 + i * 4, s, true));
  v.setFloat32(108, 352, true);
  v.setFloat32(112, 1, true);
  v.setInt16(254, 1, true);
  SPACING.forEach((s, r) => v.setFloat32(280 + r * 16 + r * 4, s, true));
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
  new Uint8Array(buf, 352).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return new Uint8Array(buf);
}

const inside = (x: number, y: number, z: number, c: readonly number[], r: readonly number[]) =>
  ((x - c[0]) / r[0]) ** 2 + ((y - c[1]) / r[1]) ** 2 + ((z - c[2]) / r[2]) ** 2 < 1;

/** The sample as files, image first, ready for the normal open path. */
export function makeSample(): { name: string; bytes: Uint8Array }[] {
  const [nx, ny, nz] = DIMS;
  const image = new Int16Array(nx * ny * nz).fill(-1000);
  const mask = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (!inside(x, y, z, [32, 32, 23.5], [27, 22, 30])) continue;
        const i = z * nx * ny + y * nx + x;
        // A little fixed texture so window/level has something to show.
        let value = 40 + Math.round(12 * Math.sin(x * 0.9) * Math.cos(y * 0.7 + z * 0.5));
        if (Math.hypot(x - 32, y - 47) < 3.5) value = 600;
        if (inside(x, y, z, [21, 30, 24], [10, 9, 12])) {
          value += 60;
          mask[i] = 1;
        } else if (inside(x, y, z, [44, 35, 21], [6, 6, 6])) {
          value += 110;
          mask[i] = 2;
        }
        image[i] = value;
      }
  return [
    { name: SAMPLE_IMAGE_NAME, bytes: nifti(image, 4, 16) },
    { name: SAMPLE_MASK_NAME, bytes: nifti(mask, 2, 8) },
  ];
}
