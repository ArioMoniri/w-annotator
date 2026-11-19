import { describe, expect, it } from 'vitest';
import { labelValues, readVolume, sameGrid } from './io';
import { SAMPLE_IMAGE_NAME, SAMPLE_MASK_NAME, makeSample } from './sample';

describe('makeSample', () => {
  const [imageFile, maskFile] = makeSample();
  const image = readVolume([imageFile]);
  const mask = readVolume([maskFile]);

  it('gives an image and a mask that the normal readers open', () => {
    expect(imageFile.name).toBe(SAMPLE_IMAGE_NAME);
    expect(maskFile.name).toBe(SAMPLE_MASK_NAME);
    expect(image.dims).toEqual([64, 64, 48]);
    expect(sameGrid(image, mask)).toBe(true);
  });
  it('has exactly two labels in the mask', () => {
    expect(labelValues(mask)).toEqual([1, 2]);
  });
  it('looks like a body in air: dense inside, air at the corners', () => {
    const [nx, ny] = image.dims;
    const at = (x: number, y: number, z: number) => image.data[z * nx * ny + y * nx + x];
    expect(at(0, 0, 0)).toBe(-1000);
    expect(at(32, 32, 24)).toBeGreaterThan(-200);
  });
  it('is the same every time and stays small', () => {
    expect(makeSample()[0].bytes).toEqual(imageFile.bytes);
    expect(imageFile.bytes.length + maskFile.bytes.length).toBeLessThan(1_000_000);
  });
  it('is not mirror-symmetric, so a left-right flip would show', () => {
    const [nx, ny, nz] = mask.dims;
    let differs = false;
    for (let z = 0; z < nz && !differs; z++)
      for (let y = 0; y < ny && !differs; y++)
        for (let x = 0; x < nx / 2; x++)
          if (mask.data[z * nx * ny + y * nx + x] !== mask.data[z * nx * ny + y * nx + (nx - 1 - x)]) {
            differs = true;
            break;
          }
    expect(differs).toBe(true);
  });
});
