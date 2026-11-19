import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { readVolume } from './index';
import { ascii, concat, encode, ramp } from './fixtures';
import type { ScalarType } from './util';

const header = (lines: string[]) => ascii(lines.join('\n') + '\n');
const mha = (lines: string[], data: Uint8Array) => concat(header([...lines, 'ElementDataFile = LOCAL']), data);
const read = (name: string, bytes: Uint8Array) => readVolume([{ name, bytes }]);

const BASIC = ['ObjectType = Image', 'NDims = 3', 'DimSize = 3 2 2', 'ElementType = MET_SHORT'];

describe('MetaImage .mha', () => {
  it('reads an uncompressed file with its LPS geometry unchanged', () => {
    const v = read(
      'ct.mha',
      mha(
        [...BASIC, 'ElementSpacing = 0.5 0.75 2', 'Offset = -100 -80.5 50', 'TransformMatrix = 0 1 0 -1 0 0 0 0 1'],
        encode(ramp(12, -3), 'int16'),
      ),
    );
    expect(v.name).toBe('ct');
    expect(v.dims).toEqual([3, 2, 2]);
    expect(v.spacing).toEqual([0.5, 0.75, 2]);
    expect(v.origin).toEqual([-100, -80.5, 50]);
    // The first three numbers are the world direction of the i axis.
    expect(v.direction).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(ramp(12, -3));
  });

  it('defaults to unit spacing, zero origin and identity direction', () => {
    const v = read('a.mha', mha(BASIC, encode(ramp(12), 'int16')));
    expect(v.spacing).toEqual([1, 1, 1]);
    expect(v.origin).toEqual([0, 0, 0]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('reads zlib-compressed data', () => {
    const z = zlibSync(encode(ramp(12), 'int16'));
    const v = read('a.mha', mha([...BASIC, 'CompressedData = True', `CompressedDataSize = ${z.length}`], z));
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('accepts the alternative key names', () => {
    const v = read(
      'a.mha',
      mha([...BASIC, 'ElementSize = 2 3 4', 'Position = 1 2 3', 'Rotation = 1 0 0 0 0 1 0 1 0'], encode(ramp(12), 'int16')),
    );
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(v.origin).toEqual([1, 2, 3]);
    expect(v.direction).toEqual([1, 0, 0, 0, 0, 1, 0, 1, 0]);
    const w = read(
      'a.mha',
      mha([...BASIC, 'Origin = 4 5 6', 'Orientation = 0 0 1 0 1 0 1 0 0'], encode(ramp(12), 'int16')),
    );
    expect(w.origin).toEqual([4, 5, 6]);
    expect(w.direction).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 0]);
  });

  it('prefers ElementSpacing over ElementSize', () => {
    const v = read('a.mha', mha([...BASIC, 'ElementSize = 9 9 9', 'ElementSpacing = 2 3 4'], encode(ramp(12), 'int16')));
    expect(v.spacing).toEqual([2, 3, 4]);
  });

  const types: [string, ScalarType, string, number[]][] = [
    ['MET_UCHAR', 'uint8', 'Uint8Array', [0, 1, 200, 255]],
    ['MET_CHAR', 'int8', 'Int8Array', [-128, -1, 0, 127]],
    ['MET_SHORT', 'int16', 'Int16Array', [-32768, -2, 3, 32767]],
    ['MET_USHORT', 'uint16', 'Uint16Array', [0, 1, 40000, 65535]],
    ['MET_INT', 'int32', 'Int32Array', [-2147483648, -7, 7, 2147483647]],
    ['MET_UINT', 'uint32', 'Uint32Array', [0, 1, 3000000000, 4294967295]],
    ['MET_LONG', 'int32', 'Int32Array', [-9, -7, 7, 9]],
    ['MET_ULONG', 'uint32', 'Uint32Array', [0, 1, 7, 4294967295]],
    ['MET_LONG_LONG', 'int64', 'Float64Array', [-5, 0, 7, 2 ** 40]],
    ['MET_ULONG_LONG', 'uint64', 'Float64Array', [0, 1, 7, 2 ** 40]],
    ['MET_FLOAT', 'float32', 'Float32Array', [-1.5, 0, 0.25, 1024]],
    ['MET_DOUBLE', 'float64', 'Float64Array', [-1.1, 0, 0.3, 1e300]],
  ];
  for (const [met, type, ctor, values] of types) {
    for (const [key, msb] of [
      ['BinaryDataByteOrderMSB', false],
      ['BinaryDataByteOrderMSB', true],
      ['ElementByteOrderMSB', true],
    ] as const) {
      it(`reads ${met} with ${key} = ${msb}`, () => {
        const v = read(
          'a.mha',
          mha(
            ['ObjectType = Image', 'NDims = 3', 'DimSize = 2 2 1', `${key} = ${msb ? 'True' : 'False'}`, `ElementType = ${met}`],
            encode(values, type, !msb),
          ),
        );
        expect(v.data.constructor.name).toBe(ctor);
        expect(Array.from(v.data)).toEqual(values);
      });
    }
  }

  it('reads a 2D image as a single slice', () => {
    const v = read(
      'a.mha',
      mha(
        ['NDims = 2', 'DimSize = 3 2', 'ElementSpacing = 0.5 0.25', 'Offset = 7 8', 'TransformMatrix = 0 1 -1 0', 'ElementType = MET_UCHAR'],
        encode(ramp(6), 'uint8'),
      ),
    );
    expect(v.dims).toEqual([3, 2, 1]);
    expect(v.spacing).toEqual([0.5, 0.25, 1]);
    expect(v.origin).toEqual([7, 8, 0]);
    expect(v.direction).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    expect(Array.from(v.data)).toEqual(ramp(6));
  });

  it('copes with Windows line endings and odd spacing around "="', () => {
    const bytes = concat(
      ascii('ObjectType=Image\r\nNDims =3\r\nDimSize=  3 2 2\r\nElementType = MET_UCHAR \r\nElementDataFile = LOCAL\r\n'),
      encode(ramp(12), 'uint8'),
    );
    expect(Array.from(read('a.mha', bytes).data)).toEqual(ramp(12));
  });

  it('detects MetaImage by content when the name has no known extension', () => {
    expect(read('image', mha(BASIC, encode(ramp(12), 'int16'))).dims).toEqual([3, 2, 2]);
  });
});

describe('MetaImage .mhd with a separate data file', () => {
  const mhd = (lines: string[], dataFile: string) => header([...BASIC, ...lines, `ElementDataFile = ${dataFile}`]);

  it('reads the .raw file named in the header', () => {
    const v = readVolume([
      { name: 'ct.raw', bytes: encode(ramp(12), 'int16') },
      { name: 'ct.mhd', bytes: mhd([], 'ct.raw') },
    ]);
    expect(v.name).toBe('ct');
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('matches the data file regardless of folder and case', () => {
    const v = readVolume([
      { name: '/x/y/ct.mhd', bytes: mhd([], './sub/CT.raw') },
      { name: '/x/y/ct.RAW', bytes: encode(ramp(12), 'int16') },
    ]);
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('reads a compressed .zraw file', () => {
    const v = readVolume([
      { name: 'ct.mhd', bytes: mhd(['CompressedData = True'], 'ct.zraw') },
      { name: 'ct.zraw', bytes: zlibSync(encode(ramp(12), 'int16')) },
    ]);
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('skips HeaderSize bytes of the data file, or finds the data at the end for -1', () => {
    const data = concat(ascii('JUNK!'), encode(ramp(12), 'int16'));
    for (const size of [5, -1]) {
      const v = readVolume([
        { name: 'ct.mhd', bytes: mhd([`HeaderSize = ${size}`], 'ct.raw') },
        { name: 'ct.raw', bytes: data },
      ]);
      expect(Array.from(v.data)).toEqual(ramp(12));
    }
  });

  it('asks for the data file when it was not given', () => {
    expect(() => readVolume([{ name: 'ct.mhd', bytes: mhd([], 'ct.raw') }])).toThrow(/ct\.raw.*missing/);
  });
});

describe('MetaImage errors', () => {
  it('reports truncated data', () => {
    expect(() => read('a.mha', mha(BASIC, encode(ramp(11), 'int16')))).toThrow(/incomplete or damaged/);
  });
  it('reports damaged compressed data', () => {
    expect(() => read('a.mha', mha([...BASIC, 'CompressedData = True'], ascii('not zlib at all')))).toThrow(
      /could not be unpacked|incomplete or damaged/,
    );
  });
  it('reports a header without the required fields', () => {
    expect(() => read('a.mha', mha(['ObjectType = Image', 'NDims = 3'], new Uint8Array(4)))).toThrow(/not a valid MetaImage/);
    expect(() => read('a.mha', ascii('hello world'))).toThrow(/not a valid MetaImage/);
  });
  it('reports unknown element types and multi-channel images', () => {
    expect(() => read('a.mha', mha(['NDims = 3', 'DimSize = 1 1 1', 'ElementType = MET_WEIRD'], new Uint8Array(8)))).toThrow(
      /MET_WEIRD/,
    );
    expect(() =>
      read('a.mha', mha([...BASIC, 'ElementNumberOfChannels = 3'], new Uint8Array(72))),
    ).toThrow(/colour|channel/i);
  });
  it('reports 4D images', () => {
    expect(() =>
      read('a.mha', mha(['NDims = 4', 'DimSize = 1 1 1 2', 'ElementType = MET_UCHAR'], new Uint8Array(2))),
    ).toThrow(/2D and 3D/);
  });
});
