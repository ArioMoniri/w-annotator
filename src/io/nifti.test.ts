import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { readVolume } from './index';
import { encode, niftiBytes, ramp, type NiiOpts } from './fixtures';
import type { ScalarType } from './util';

const read = (name: string, bytes: Uint8Array) => readVolume([{ name, bytes }]);
const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
};

const base = (extra: Partial<NiiOpts> = {}): NiiOpts => ({
  dim: [3, 2, 2],
  datatype: 4,
  bitpix: 16,
  data: encode(ramp(12), 'int16', extra.le ?? true),
  ...extra,
});

describe('NIfTI geometry', () => {
  it('converts a RAS identity sform with an origin to LPS', () => {
    const v = read(
      'brain.nii',
      niftiBytes(base({ sformCode: 1, srow: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30] })),
    );
    expect(v.name).toBe('brain');
    expect(v.dims).toEqual([3, 2, 2]);
    expect(v.spacing).toEqual([1, 1, 1]);
    expect(v.origin).toEqual([-10, -20, 30]);
    expect(v.direction).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('reads a gzipped file with an oblique, axis-swapping sform', () => {
    const c = Math.cos(Math.PI / 6);
    const s = 0.5;
    // RAS columns: i = 1.5*(0, c, s), j = 2*(-1, 0, 0), k = 3*(0, -s, c); translation (5, -7, 11).
    const srow = [0, -2, 0, 5, 1.5 * c, 0, -3 * s, -7, 1.5 * s, 0, 3 * c, 11];
    const v = read('ct.nii.gz', gzipSync(niftiBytes(base({ sformCode: 2, srow }))));
    close(v.spacing, [1.5, 2, 3]);
    close(v.origin, [-5, 7, 11]);
    close(v.direction, [0, -c, s, 1, 0, 0, 0, s, c]);
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('prefers the sform over the qform when both are set', () => {
    const v = read(
      'a.nii',
      niftiBytes(
        base({
          sformCode: 1,
          srow: [2, 0, 0, 1, 0, 2, 0, 2, 0, 0, 2, 3],
          qformCode: 1,
          quatern: [0, 0, 0, 9, 9, 9],
          pixdim: [1, 5, 5, 5],
        }),
      ),
    );
    expect(v.spacing).toEqual([2, 2, 2]);
    expect(v.origin).toEqual([-1, -2, 3]);
  });

  it('uses the qform (quaternion, qfac and offsets) when there is no sform', () => {
    // 90 degrees about z: R = [[0,-1,0],[1,0,0],[0,0,1]], qfac -1 flips k.
    const h = Math.SQRT1_2;
    const v = read(
      'a.nii',
      niftiBytes(base({ qformCode: 1, quatern: [0, 0, h, 1, 2, 3], pixdim: [-1, 2, 3, 4] })),
    );
    close(v.spacing, [2, 3, 4]);
    close(v.origin, [-1, -2, 3]);
    close(v.direction, [0, -1, 0, 1, 0, 0, 0, 0, -1]);
  });

  it('falls back to pixdim when neither sform nor qform is set', () => {
    const v = read('a.nii', niftiBytes(base({ pixdim: [1, 2, 3, 4] })));
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(v.origin).toEqual([0, 0, 0]);
    expect(v.direction).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
  });

  it('falls back to the qform when the sform is degenerate', () => {
    const v = read(
      'a.nii',
      niftiBytes(base({ sformCode: 1, srow: new Array<number>(12).fill(0), qformCode: 1, pixdim: [1, 2, 3, 4] })),
    );
    expect(v.spacing).toEqual([2, 3, 4]);
  });
});

describe('NIfTI data', () => {
  const types: [number, ScalarType, string, number[]][] = [
    [2, 'uint8', 'Uint8Array', [0, 1, 200, 255]],
    [256, 'int8', 'Int8Array', [-128, -1, 0, 127]],
    [4, 'int16', 'Int16Array', [-32768, -2, 3, 32767]],
    [512, 'uint16', 'Uint16Array', [0, 1, 40000, 65535]],
    [8, 'int32', 'Int32Array', [-2147483648, -7, 7, 2147483647]],
    [768, 'uint32', 'Uint32Array', [0, 1, 3000000000, 4294967295]],
    [16, 'float32', 'Float32Array', [-1.5, 0, 0.25, 1e10]],
    [64, 'float64', 'Float64Array', [-1.1, 0, 0.3, 1e300]],
    [1024, 'int64', 'Float64Array', [-5, 0, 7, 2 ** 40]],
    [1280, 'uint64', 'Float64Array', [0, 1, 7, 2 ** 40]],
  ];
  for (const [code, type, ctor, values] of types) {
    for (const le of [true, false]) {
      it(`reads ${type} ${le ? 'little' : 'big'} endian`, () => {
        const expected = type === 'float32' ? Array.from(new Float32Array(values)) : values;
        const bytes = niftiBytes({ dim: [2, 2, 1], datatype: code, bitpix: 8, data: encode(values, type, le), le });
        const v = read('t.nii', bytes);
        expect(v.data.constructor.name).toBe(ctor);
        expect(Array.from(v.data)).toEqual(expected);
        expect(v.dims).toEqual([2, 2, 1]);
      });
    }
  }

  it('applies scl_slope and scl_inter and returns Float32', () => {
    const v = read('a.nii', niftiBytes(base({ slope: 0.5, inter: -10 })));
    expect(v.data).toBeInstanceOf(Float32Array);
    expect(Array.from(v.data)).toEqual(ramp(12).map((x) => x * 0.5 - 10));
  });

  it('keeps the stored type when scaling is the identity or slope is 0', () => {
    expect(read('a.nii', niftiBytes(base({ slope: 1, inter: 0 }))).data).toBeInstanceOf(Int16Array);
    expect(read('a.nii', niftiBytes(base({ slope: 0, inter: 5 }))).data).toBeInstanceOf(Int16Array);
  });

  for (const le of [true, false]) {
    it(`reads NIfTI-2 ${le ? 'little' : 'big'} endian`, () => {
      const v = read(
        'a.nii',
        niftiBytes(base({ version: 2, le, sformCode: 1, srow: [0.7, 0, 0, 10, 0, 0.7, 0, 20, 0, 0, 2.5, 30] })),
      );
      expect(v.dims).toEqual([3, 2, 2]);
      expect(v.spacing).toEqual([0.7, 0.7, 2.5]);
      expect(v.origin).toEqual([-10, -20, 30]);
      expect(v.direction).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
      expect(Array.from(v.data)).toEqual(ramp(12));
    });
  }

  it('takes the first volume of a 4D file', () => {
    const v = read('a.nii', niftiBytes(base({ dim: [3, 2, 2, 2], data: encode(ramp(24, 100), 'int16') })));
    expect(v.dims).toEqual([3, 2, 2]);
    expect(Array.from(v.data)).toEqual(ramp(12, 100));
  });

  it('reads a 2D file as a single slice', () => {
    const v = read('a.nii', niftiBytes(base({ dim: [3, 2], data: encode(ramp(6), 'int16') })));
    expect(v.dims).toEqual([3, 2, 1]);
    expect(Array.from(v.data)).toEqual(ramp(6));
  });

  it('reads a .hdr/.img pair in either order', () => {
    const hdr = { name: 'p.hdr', bytes: niftiBytes(base({ magic: 'ni1', pixdim: [1, 2, 2, 2] })) };
    const img = { name: 'p.img', bytes: encode(ramp(12), 'int16') };
    for (const files of [
      [hdr, img],
      [img, hdr],
    ]) {
      const v = readVolume(files);
      expect(v.name).toBe('p');
      expect(v.spacing).toEqual([2, 2, 2]);
      expect(Array.from(v.data)).toEqual(ramp(12));
    }
  });

  it('detects NIfTI by content when the name has no known extension', () => {
    expect(read('scan', niftiBytes(base())).dims).toEqual([3, 2, 2]);
    expect(read('scan.bin', gzipSync(niftiBytes(base()))).dims).toEqual([3, 2, 2]);
  });

  it('reads a gzipped file that is named .nii', () => {
    expect(read('a.nii', gzipSync(niftiBytes(base()))).dims).toEqual([3, 2, 2]);
  });
});

describe('NIfTI errors', () => {
  it('reports truncated voxel data', () => {
    const bytes = niftiBytes(base());
    expect(() => read('a.nii', bytes.subarray(0, bytes.length - 3))).toThrow(/incomplete or damaged/);
  });
  it('reports a truncated header', () => {
    expect(() => read('a.nii', niftiBytes(base()).subarray(0, 100))).toThrow(/not a valid NIfTI/);
  });
  it('reports a file that is not NIfTI at all', () => {
    expect(() => read('a.nii', new Uint8Array(400).fill(7))).toThrow(/not a valid NIfTI/);
  });
  it('reports a damaged gzip stream', () => {
    const gz = gzipSync(niftiBytes(base()));
    expect(() => read('a.nii.gz', gz.subarray(0, gz.length - 12))).toThrow(/could not be unpacked/);
  });
  it('reports unsupported voxel types such as RGB', () => {
    expect(() => read('a.nii', niftiBytes(base({ datatype: 128, bitpix: 24 })))).toThrow(/colour|not supported/i);
  });
  it('reports a missing .img file', () => {
    expect(() => read('p.hdr', niftiBytes(base({ magic: 'ni1' })))).toThrow(/\.img/);
  });
  it('reports nonsense image sizes', () => {
    expect(() => read('a.nii', niftiBytes(base({ dim: [3, 0, 2] })))).toThrow(/invalid image size/);
  });
});
