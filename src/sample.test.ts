import { gunzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { labelValues, readVolume, sameGrid } from './io';
import { SAMPLE_IMAGE_NAME, SAMPLE_MASK_NAME, loadSample, makeSample } from './sample';

describe('loadSample', () => {
  const bundled = (path: string) => new Uint8Array(readFileSync(join('public', path)));
  const serve =
    (body: (url: string) => Uint8Array, status = 200): typeof fetch =>
    async (input) =>
      new Response(body(String(input)) as BodyInit, { status });
  const fromDisk = serve((url) => bundled(url.replace(/^\//, '')));
  const isPhantom = (files: { name: string }[]) => files.map((f) => f.name).join() === [SAMPLE_IMAGE_NAME, SAMPLE_MASK_NAME].join();

  it('gives the bundled scan and its mask, image first', async () => {
    const asked: string[] = [];
    const sample = await loadSample(async (input) => {
      asked.push(String(input));
      return fromDisk(input);
    }, '/');
    expect(sample.bundled).toBe(true);
    expect(asked.sort()).toEqual(['/sample/chest_ct.nii.gz', '/sample/lungs.nii.gz']);
    expect(sample.files.map((f) => f.name)).toEqual(['chest_ct.nii.gz', 'lungs.nii.gz']);
    // Comparing 7 MB element by element can outlast the test timeout on a busy machine.
    expect(Buffer.compare(Buffer.from(sample.files[0].bytes), Buffer.from(bundled('sample/chest_ct.nii.gz')))).toBe(0);
  });
  it('asks under the base the app is served from', async () => {
    const asked: string[] = [];
    await loadSample(async (input) => {
      asked.push(String(input));
      throw new Error('offline');
    }, './');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => url.startsWith('./sample/'))).toBe(true);
  });
  it('falls back to the phantom when the request fails', async () => {
    const sample = await loadSample(async () => {
      throw new TypeError('Failed to fetch');
    }, '/');
    expect(sample.bundled).toBe(false);
    expect(isPhantom(sample.files)).toBe(true);
  });
  it('falls back when a file is missing', async () => {
    const sample = await loadSample(serve(() => new TextEncoder().encode('Not found'), 404), '/');
    expect(sample.bundled).toBe(false);
    expect(isPhantom(sample.files)).toBe(true);
  });
  it('falls back when the server answers with a page instead of the file', async () => {
    const sample = await loadSample(serve(() => new TextEncoder().encode('<!doctype html><html></html>')), '/');
    expect(sample.bundled).toBe(false);
    expect(isPhantom(sample.files)).toBe(true);
  });
  it('falls back when a file is cut short', async () => {
    const sample = await loadSample(serve((url) => bundled(url.replace(/^\//, '')).subarray(0, 5000)), '/');
    expect(sample.bundled).toBe(false);
    expect(isPhantom(sample.files)).toBe(true);
  });
});

describe('the bundled sample', () => {
  const file = (name: string) => ({ name, bytes: new Uint8Array(readFileSync(join('public/sample', name))) });
  const image = readVolume([file('chest_ct.nii.gz')]);
  const mask = readVolume([file('lungs.nii.gz')]);

  it('is an int16 image and a mask on the same grid, small enough to ship', () => {
    expect(image.data).toBeInstanceOf(Int16Array);
    expect(image.dims).toEqual([256, 176, 121]);
    expect(image.spacing[2]).toBeCloseTo(2.5, 5);
    expect(sameGrid(image, mask)).toBe(true);
    expect(file('chest_ct.nii.gz').bytes.length + file('lungs.nii.gz').bytes.length).toBeLessThan(7_500_000);
  });
  it('names its three segments', () => {
    expect(labelValues(mask)).toEqual([1, 2, 3]);
    expect(mask.labels).toEqual({ 1: 'Left lung', 2: 'Right lung', 3: 'Airways' });
  });
  it('has the left lung on the patient left, which is +x in LPS', () => {
    const nx = mask.dims[0];
    const sum = [0, 0, 0];
    const n = [0, 0, 0];
    for (let i = 0; i < mask.data.length; i++) {
      const v = mask.data[i];
      if (v === 1 || v === 2) {
        sum[v] += mask.origin[0] + mask.spacing[0] * (i % nx);
        n[v]++;
      }
    }
    expect(mask.direction.slice(0, 3)).toEqual([1, 0, 0]);
    expect(sum[1] / n[1]).toBeGreaterThan(20);
    expect(sum[2] / n[2]).toBeLessThan(-20);
  });
  it('has air under the lung label', () => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i] === 1) {
        sum += image.data[i];
        n++;
      }
    expect(sum / n).toBeLessThan(-700);
  });
  it('does not say which scan it came from', () => {
    for (const name of ['chest_ct.nii.gz', 'lungs.nii.gz']) {
      const header = new TextDecoder('latin1').decode(gunzipSync(file(name).bytes).subarray(0, 600));
      expect(header).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    }
  });
});

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
