import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { readVolume } from './index';
import { ascii, concat, encode, ramp } from './fixtures';
import type { ScalarType } from './util';

const nrrd = (lines: string[], data: Uint8Array = new Uint8Array(0)) =>
  concat(ascii(['NRRD0004', ...lines].join('\n') + '\n\n'), data);
const read = (name: string, bytes: Uint8Array) => readVolume([{ name, bytes }]);

const BASIC = ['type: short', 'dimension: 3', 'sizes: 3 2 2', 'endian: little', 'encoding: raw'];
const data12 = encode(ramp(12), 'int16');

describe('NRRD geometry', () => {
  it('keeps LPS geometry as it is', () => {
    const v = read(
      'ct.nrrd',
      nrrd(
        [...BASIC, 'space: left-posterior-superior', 'space directions: (0,0.5,0) (-0.75,0,0) (0,0,2)', 'space origin: (-100,-80.5,50)'],
        data12,
      ),
    );
    expect(v.name).toBe('ct');
    expect(v.dims).toEqual([3, 2, 2]);
    expect(v.spacing).toEqual([0.5, 0.75, 2]);
    expect(v.origin).toEqual([-100, -80.5, 50]);
    expect(v.direction).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(ramp(12));
  });

  it('converts RAS space to LPS', () => {
    const v = read(
      'a.nrrd',
      nrrd([...BASIC, 'space: right-anterior-superior', 'space directions: (2,0,0) (0,3,0) (0,0,4)', 'space origin: (10,20,30)'], data12),
    );
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(v.origin).toEqual([-10, -20, 30]);
    expect(v.direction).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
  });

  it('converts LAS space to LPS and accepts the short space names', () => {
    const v = read(
      'a.nrrd',
      nrrd([...BASIC, 'space: LAS', 'space directions: (2,0,0) (0,3,0) (0,0,4)', 'space origin: (10,20,30)'], data12),
    );
    expect(v.origin).toEqual([10, -20, 30]);
    expect(v.direction).toEqual([1, 0, 0, 0, -1, 0, 0, 0, 1]);
    const r = read('a.nrrd', nrrd([...BASIC, 'space: RAS', 'space directions: (1,0,0) (0,1,0) (0,0,1)', 'space origin: (1,2,3)'], data12));
    expect(r.origin).toEqual([-1, -2, 3]);
  });

  it('falls back to spacings, then to unit spacing', () => {
    const v = read('a.nrrd', nrrd([...BASIC, 'spacings: 2 3 4'], data12));
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(v.origin).toEqual([0, 0, 0]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(read('a.nrrd', nrrd(BASIC, data12)).spacing).toEqual([1, 1, 1]);
  });

  it('reads a 2D image as a single slice', () => {
    const v = read(
      'a.nrrd',
      nrrd(['type: uchar', 'dimension: 2', 'sizes: 3 2', 'encoding: raw', 'spacings: 0.5 0.25'], encode(ramp(6), 'uint8')),
    );
    expect(v.dims).toEqual([3, 2, 1]);
    expect(v.spacing).toEqual([0.5, 0.25, 1]);
    expect(Array.from(v.data)).toEqual(ramp(6));
  });
});

describe('NRRD data', () => {
  it('reads gzip-encoded data under both encoding names', () => {
    for (const enc of ['gzip', 'gz']) {
      const v = read('a.nrrd', nrrd([...BASIC.slice(0, 4), `encoding: ${enc}`], gzipSync(data12)));
      expect(Array.from(v.data)).toEqual(ramp(12));
    }
  });

  it('reads ASCII-encoded data', () => {
    const v = read('a.nrrd', nrrd([...BASIC.slice(0, 4), 'encoding: ascii'], ascii('0 1 2 3 4 5\n6 7 8 9 10 -11\n')));
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual([...ramp(11), -11]);
  });

  const types: [string, ScalarType, string, number[]][] = [
    ['unsigned char', 'uint8', 'Uint8Array', [0, 1, 200, 255]],
    ['uint8', 'uint8', 'Uint8Array', [0, 1, 200, 255]],
    ['signed char', 'int8', 'Int8Array', [-128, -1, 0, 127]],
    ['short', 'int16', 'Int16Array', [-32768, -2, 3, 32767]],
    ['int16_t', 'int16', 'Int16Array', [-32768, -2, 3, 32767]],
    ['unsigned short', 'uint16', 'Uint16Array', [0, 1, 40000, 65535]],
    ['int', 'int32', 'Int32Array', [-2147483648, -7, 7, 2147483647]],
    ['unsigned int', 'uint32', 'Uint32Array', [0, 1, 3000000000, 4294967295]],
    ['long long', 'int64', 'Float64Array', [-5, 0, 7, 2 ** 40]],
    ['uint64', 'uint64', 'Float64Array', [0, 1, 7, 2 ** 40]],
    ['float', 'float32', 'Float32Array', [-1.5, 0, 0.25, 1024]],
    ['double', 'float64', 'Float64Array', [-1.1, 0, 0.3, 1e300]],
  ];
  for (const [name, type, ctor, values] of types) {
    for (const endian of ['little', 'big']) {
      it(`reads type "${name}" ${endian} endian`, () => {
        const v = read(
          'a.nrrd',
          nrrd(
            [`type: ${name}`, 'dimension: 3', 'sizes: 2 2 1', `endian: ${endian}`, 'encoding: raw'],
            encode(values, type, endian === 'little'),
          ),
        );
        expect(v.data.constructor.name).toBe(ctor);
        expect(Array.from(v.data)).toEqual(values);
      });
    }
  }

  it('reads a detached .nhdr header with raw and with gzip data files', () => {
    const raw = readVolume([
      { name: 'ct.nhdr', bytes: nrrd([...BASIC, 'data file: ct.raw']) },
      { name: 'ct.raw', bytes: data12 },
    ]);
    expect(raw.name).toBe('ct');
    expect(Array.from(raw.data)).toEqual(ramp(12));
    const gz = readVolume([
      { name: 'dir/ct.raw.gz', bytes: gzipSync(data12) },
      { name: 'dir/ct.nhdr', bytes: nrrd([...BASIC.slice(0, 4), 'encoding: gzip', 'datafile: ./ct.raw.gz']) },
    ]);
    expect(Array.from(gz.data)).toEqual(ramp(12));
  });

  it('honours byte skip, including -1 for data at the end of the file', () => {
    const padded = concat(ascii('JUNK!'), data12);
    expect(Array.from(read('a.nrrd', nrrd([...BASIC, 'byte skip: 5'], padded)).data)).toEqual(ramp(12));
    expect(Array.from(read('a.nrrd', nrrd([...BASIC, 'byte skip: -1'], padded)).data)).toEqual(ramp(12));
  });

  it('ignores comments, key/value pairs and Windows line endings', () => {
    const bytes = concat(
      ascii('NRRD0005\r\n# a comment\r\ntype: short\r\ndimension: 3\r\nsizes: 3 2 2\r\nendian: little\r\nencoding: raw\r\nfoo:=bar\r\n\r\n'),
      data12,
    );
    expect(Array.from(read('a.nrrd', bytes).data)).toEqual(ramp(12));
  });

  it('detects NRRD by content when the name has no known extension', () => {
    expect(read('volume', nrrd(BASIC, data12)).dims).toEqual([3, 2, 2]);
  });
});

describe('NRRD segmentations', () => {
  const SEG = [
    'type: unsigned char',
    'space: left-posterior-superior',
    'encoding: raw',
    'Segment0_ID:=Segment_1',
    'Segment0_LabelValue:=1',
    'Segment0_Name:=Liver',
    'Segment1_LabelValue:=5',
    'Segment1_Name:=Left kidney',
  ];

  it('reads segment names keyed by label value', () => {
    const v = read(
      'liver.seg.nrrd',
      nrrd([...SEG, 'dimension: 3', 'sizes: 2 2 1', 'space directions: (1,0,0) (0,1,0) (0,0,1)', 'space origin: (0,0,0)'], encode([0, 1, 5, 1], 'uint8')),
    );
    expect(v.name).toBe('liver');
    expect(v.labels).toEqual({ 1: 'Liver', 5: 'Left kidney' });
    expect(Array.from(v.data)).toEqual([0, 1, 5, 1]);
  });

  it('takes the first component when the list axis comes first', () => {
    // 2 layers interleaved: layer 0 holds 1..4, layer 1 holds 9.
    const v = read(
      'a.seg.nrrd',
      nrrd(
        [...SEG, 'dimension: 4', 'sizes: 2 2 2 1', 'space directions: none (2,0,0) (0,3,0) (0,0,4)', 'kinds: list domain domain domain', 'space origin: (1,2,3)'],
        encode([1, 9, 2, 9, 3, 9, 4, 9], 'uint8'),
      ),
    );
    expect(v.dims).toEqual([2, 2, 1]);
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(v.origin).toEqual([1, 2, 3]);
    expect(Array.from(v.data)).toEqual([1, 2, 3, 4]);
  });

  it('takes the first component when the list axis comes last', () => {
    const v = read(
      'a.seg.nrrd',
      nrrd(
        [...SEG, 'dimension: 4', 'sizes: 2 2 1 2', 'space directions: (2,0,0) (0,3,0) (0,0,4) none', 'space origin: (1,2,3)'],
        encode([1, 2, 3, 4, 9, 9, 9, 9], 'uint8'),
      ),
    );
    expect(v.dims).toEqual([2, 2, 1]);
    expect(v.spacing).toEqual([2, 3, 4]);
    expect(Array.from(v.data)).toEqual([1, 2, 3, 4]);
  });

  it('takes the first component when the list axis is in the middle', () => {
    const v = read(
      'a.nrrd',
      nrrd(
        ['type: uchar', 'encoding: raw', 'dimension: 4', 'sizes: 2 2 2 1', 'space dimension: 3', 'space directions: (1,0,0) (0,1,0) none (0,0,1)'],
        encode([1, 2, 3, 4, 9, 9, 9, 9], 'uint8'),
      ),
    );
    expect(v.dims).toEqual([2, 2, 1]);
    expect(Array.from(v.data)).toEqual([1, 2, 3, 4]);
  });
});

describe('NRRD errors', () => {
  it('reports truncated data', () => {
    expect(() => read('a.nrrd', nrrd(BASIC, data12.subarray(0, 20)))).toThrow(/incomplete or damaged/);
  });
  it('reports a damaged gzip stream', () => {
    expect(() => read('a.nrrd', nrrd([...BASIC.slice(0, 4), 'encoding: gzip'], ascii('nope nope nope nope')))).toThrow(
      /could not be unpacked/,
    );
  });
  it('reports unsupported encodings by name', () => {
    expect(() => read('a.nrrd', nrrd([...BASIC.slice(0, 4), 'encoding: bzip2'], data12))).toThrow(/bzip2/);
  });
  it('reports unknown types and missing fields', () => {
    expect(() => read('a.nrrd', nrrd(['type: block', 'dimension: 3', 'sizes: 1 1 1', 'encoding: raw'], data12))).toThrow(/block/);
    expect(() => read('a.nrrd', nrrd(['type: short', 'encoding: raw'], data12))).toThrow(/not a valid NRRD/);
    expect(() => read('a.nrrd', ascii('garbage'))).toThrow(/not a valid NRRD/);
  });
  it('asks for the data file of a detached header', () => {
    expect(() => read('ct.nhdr', nrrd([...BASIC, 'data file: ct.raw']))).toThrow(/ct\.raw.*missing/);
  });
});
