import { describe, expect, it } from 'vitest';
import { gunzipSync, zlibSync } from 'fflate';
import { readVolume, sameGrid, writeVolume, type VolumeData, type WriteFormat } from './index';
import { ascii, concat, encode, niftiBytes, ramp } from './fixtures';
import type { ScalarArray } from './types';

const FORMATS: WriteFormat[] = ['nii', 'nii.gz', 'mha', 'nrrd'];
const roundTrip = (v: VolumeData, format: WriteFormat) => readVolume([{ name: `${v.name}.${format}`, bytes: writeVolume(v, format) }]);

/** An asymmetric phantom: every voxel has a different value, so any flip or axis swap shows. */
function phantom(data: ScalarArray, g: Partial<VolumeData> = {}): VolumeData {
  return {
    name: 'phantom',
    dims: [4, 3, 2],
    spacing: [0.5, 0.75, 2.5],
    origin: [-120.5, 33.25, -7],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    data,
    ...g,
  };
}

const ARRAYS: ScalarArray[] = [
  new Uint8Array(ramp(24, 200)),
  new Int8Array(ramp(24, -12)),
  new Uint16Array(ramp(24, 65000)),
  new Int16Array(ramp(24, -1000)),
  new Uint32Array(ramp(24, 4294967000)),
  new Int32Array(ramp(24, -2147483648)),
  new Float32Array(ramp(24).map((x) => x * 0.37 - 3)),
  new Float64Array(ramp(24).map((x) => x * 0.1 - 1)),
];

describe('writeVolume round-trips', () => {
  for (const format of FORMATS) {
    for (const data of ARRAYS) {
      it(`${format} keeps ${data.constructor.name} voxels, type and geometry exactly`, () => {
        const v = phantom(data);
        const back = roundTrip(v, format);
        expect(back.data.constructor).toBe(data.constructor);
        expect(back).toEqual(v);
      });
    }

    it(`${format} keeps flipped and permuted axes exactly`, () => {
      const v = phantom(new Int16Array(ramp(24)), { direction: [0, -1, 0, 0, 0, 1, -1, 0, 0] });
      expect(roundTrip(v, format)).toEqual(v);
      const w = phantom(new Int16Array(ramp(24)), { direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1] });
      expect(roundTrip(w, format)).toEqual(w);
      const left = phantom(new Int16Array(ramp(24)), { direction: [1, 0, 0, 0, 1, 0, 0, 0, -1] });
      expect(roundTrip(left, format)).toEqual(left);
    });

    it(`${format} keeps an oblique orientation and is stable from the second write on`, () => {
      const c = Math.cos(0.3);
      const s = Math.sin(0.3);
      const v = phantom(new Int16Array(ramp(24)), {
        direction: [c, s, 0, -s, c, 0, 0, 0, 1],
        spacing: [0.7, 0.7, 1.3],
        origin: [12.3, -45.6, 78.9],
      });
      const once = roundTrip(v, format);
      expect(sameGrid(once, v, 1e-4)).toBe(true);
      once.direction.forEach((x, i) => expect(x).toBeCloseTo(v.direction[i], 6));
      once.spacing.forEach((x, i) => expect(x).toBeCloseTo(v.spacing[i], 6));
      expect(Array.from(once.data)).toEqual(ramp(24));
      const twice = roundTrip(once, format);
      expect(sameGrid(twice, once, 1e-5)).toBe(true);
      if (format === 'mha') expect(twice).toEqual(once);
    });
  }

  it('a NIfTI read from another program survives read, write, read unchanged', () => {
    const srow = [-0.7, 0, 0, 100.1, 0, 0.7, 0, -80.3, 0, 0, 2.5, 50];
    const first = readVolume([{ name: 'm.nii', bytes: niftiBytes({ dim: [4, 3, 2], datatype: 2, bitpix: 8, data: encode(ramp(24), 'uint8'), sformCode: 1, srow }) }]);
    const second = roundTrip(first, 'nii.gz');
    expect(second).toEqual(first);
  });

  it('NRRD keeps segment names', () => {
    const v = phantom(new Uint8Array(ramp(24)), { labels: { 1: 'Liver', 7: 'Left kidney' } });
    const back = readVolume([{ name: 'phantom.seg.nrrd', bytes: writeVolume(v, 'nrrd') }]);
    expect(back).toEqual(v);
  });

  it('rejects an unknown format', () => {
    expect(() => writeVolume(phantom(new Uint8Array(24)), 'tiff' as WriteFormat)).toThrow(/not supported/);
  });
});

describe('written files follow their format', () => {
  const v = phantom(new Int16Array(ramp(24)));

  it('NIfTI-1 has the n+1 magic, mm units and both sform and qform in RAS', () => {
    const b = writeVolume(v, 'nii');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(b.length).toBe(352 + 48);
    expect(dv.getInt32(0, true)).toBe(348);
    expect(String.fromCharCode(...b.subarray(344, 347))).toBe('n+1');
    expect(dv.getInt16(40, true)).toBe(3);
    expect([dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)]).toEqual([4, 3, 2]);
    expect(dv.getInt16(70, true)).toBe(4);
    expect(dv.getInt16(72, true)).toBe(16);
    expect(b[123] & 7).toBe(2);
    expect(dv.getInt16(252, true)).toBeGreaterThan(0);
    expect(dv.getInt16(254, true)).toBeGreaterThan(0);
    // srow_x = (-0.5, 0, 0, 120.5): LPS x is negated.
    expect([0, 1, 2, 3].map((i) => dv.getFloat32(280 + i * 4, true))).toEqual([-0.5, -0, -0, 120.5]);
    expect([0, 1, 2, 3].map((i) => dv.getFloat32(296 + i * 4, true))).toEqual([-0, -0.75, -0, -33.25]);
    expect([0, 1, 2, 3].map((i) => dv.getFloat32(312 + i * 4, true))).toEqual([0, 0, 2.5, -7]);
    // qform: 180 degrees about z is the quaternion (b, c, d) = (0, 0, 1); offsets match the sform.
    expect([256, 260, 264].map((o) => dv.getFloat32(o, true))).toEqual([0, 0, 1]);
    expect([268, 272, 276].map((o) => dv.getFloat32(o, true))).toEqual([120.5, -33.25, -7]);
    expect([76, 80, 84, 88].map((o) => dv.getFloat32(o, true))).toEqual([1, 0.5, 0.75, 2.5]);
  });

  it('the qform alone describes the same geometry as the sform, including a flipped axis', () => {
    const flipped = phantom(new Int16Array(ramp(24)), { direction: [0, 1, 0, 1, 0, 0, 0, 0, 1] });
    for (const vol of [v, flipped]) {
      const b = writeVolume(vol, 'nii');
      new DataView(b.buffer).setInt16(254, 0, true); // drop the sform
      const back = readVolume([{ name: 'phantom.nii', bytes: b }]);
      expect(sameGrid(back, vol, 1e-4)).toBe(true);
    }
  });

  it('nii.gz is the gzipped NIfTI', () => {
    expect(gunzipSync(writeVolume(v, 'nii.gz'))).toEqual(writeVolume(v, 'nii'));
  });

  it('MHA declares compressed local data', () => {
    const text = String.fromCharCode(...writeVolume(v, 'mha').subarray(0, 290));
    expect(text).toMatch(/^ObjectType = Image\nNDims = 3\n/);
    expect(text).toContain('CompressedData = True\n');
    expect(text).toContain('DimSize = 4 3 2\n');
    expect(text).toContain('ElementType = MET_SHORT\n');
    expect(text).toContain('Offset = -120.5 33.25 -7\n');
    expect(text).toMatch(/ElementType = MET_SHORT\nElementDataFile = LOCAL\n/);
  });

  it('NRRD declares gzip encoding in LPS space', () => {
    const text = String.fromCharCode(...writeVolume(v, 'nrrd').subarray(0, 240));
    expect(text).toMatch(/^NRRD0004\n/);
    expect(text).toContain('space: left-posterior-superior\n');
    expect(text).toContain('encoding: gzip\n');
    expect(text).toContain('space directions: (0.5,0,0) (0,0.75,0) (0,0,2.5)\n');
    expect(text).toContain('space origin: (-120.5,33.25,-7)\n');
  });
});

describe('image and mask from different formats', () => {
  // The same physical grid, written the way ITK-based tools write each format.
  const image = () =>
    readVolume([
      {
        name: 'ct.mha',
        bytes: concat(
          ascii(
            'ObjectType = Image\nNDims = 3\nCompressedData = True\nTransformMatrix = 1 0 0 0 1 0 0 0 1\nOffset = -100 -80 50\n' +
              'ElementSpacing = 0.5 0.5 2\nDimSize = 4 3 2\nElementType = MET_SHORT\nElementDataFile = LOCAL\n',
          ),
          zlibSync(encode(ramp(24, -1000), 'int16')),
        ),
      },
    ]);
  const mask = (srow: number[]) =>
    readVolume([
      {
        name: 'ct_mask.nii',
        bytes: niftiBytes({ dim: [4, 3, 2], datatype: 2, bitpix: 8, data: encode(ramp(24), 'uint8'), sformCode: 1, srow }),
      },
    ]);

  it('an MHA image and its NIfTI mask are on the same grid', () => {
    const m = mask([-0.5, 0, 0, 100, 0, -0.5, 0, 80, 0, 0, 2, 50]);
    expect(m.origin).toEqual([-100, -80, 50]);
    expect(m.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(sameGrid(image(), m)).toBe(true);
    expect(sameGrid(m, image())).toBe(true);
  });

  it('a mask stored left-right flipped is not on the same grid', () => {
    // RAS identity: voxel i runs towards patient right, the image runs towards left.
    expect(sameGrid(image(), mask([0.5, 0, 0, 100, 0, -0.5, 0, 80, 0, 0, 2, 50]))).toBe(false);
  });

  it('a mask shifted by one voxel is not on the same grid', () => {
    expect(sameGrid(image(), mask([-0.5, 0, 0, 100.5, 0, -0.5, 0, 80, 0, 0, 2, 50]))).toBe(false);
  });

  it('a mask saved as nii.gz from the image grid overlays the image again', () => {
    const img = image();
    const saved = writeVolume({ ...img, name: 'mask', data: new Uint8Array(24).fill(1) }, 'nii.gz');
    const back = readVolume([{ name: 'mask.nii.gz', bytes: saved }]);
    expect(sameGrid(img, back, 1e-9)).toBe(true);
    expect(back.data).toBeInstanceOf(Uint8Array);
  });
});
