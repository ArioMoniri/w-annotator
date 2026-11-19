import { describe, expect, it } from 'vitest';
import { deflateSync } from 'fflate';
import { readVolume } from './index';
import { TS_EXPLICIT, TS_IMPLICIT, ascii, concat, dcmEl, dcmFile, dcmSeq, dcmSlice, encode, ramp, us, type SliceOpts } from './fixtures';

// A 3 (columns) x 2 (rows) slice; slice z holds 100*z + 0..5 so that order and orientation show.
const slice = (z: number, o: Partial<SliceOpts> = {}) => ({
  name: `IM${z}`,
  bytes: dcmSlice({
    rows: 2,
    cols: 3,
    pixels: encode(ramp(6, 100 * z), 'uint16'),
    position: [-10, -20, 5 + 2.5 * z],
    orientation: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [0.75, 0.5],
    instance: z + 1,
    description: 'Thorax 2.5',
    ...o,
  }),
});
const expected = [...ramp(6, 0), ...ramp(6, 100), ...ramp(6, 200)];

describe('DICOM series', () => {
  it('builds a volume from slices given in any order', () => {
    const v = readVolume([slice(2), slice(0), slice(1)]);
    expect(v.name).toBe('Thorax 2.5');
    expect(v.dims).toEqual([3, 2, 3]);
    // PixelSpacing is (between rows, between columns): x spacing is the second number.
    expect(v.spacing).toEqual([0.5, 0.75, 2.5]);
    expect(v.origin).toEqual([-10, -20, 5]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(v.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('reads implicit VR little endian', () => {
    const v = readVolume([2, 0, 1].map((z) => slice(z, { explicit: false })));
    expect(v.dims).toEqual([3, 2, 3]);
    expect(v.spacing).toEqual([0.5, 0.75, 2.5]);
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('sorts along the slice normal, not by instance number or z', () => {
    // Rows run along +x, columns along -y, so the normal is -z: the first slice is the highest one.
    const files = [0, 1, 2].map((z) => slice(z, { orientation: [1, 0, 0, 0, -1, 0], instance: 3 - z }));
    const v = readVolume(files);
    expect(v.origin).toEqual([-10, -20, 10]);
    expect(v.direction).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    expect(Array.from(v.data)).toEqual([...ramp(6, 200), ...ramp(6, 100), ...ramp(6, 0)]);
  });

  it('handles an oblique series', () => {
    const c = Math.cos(0.2);
    const s = Math.sin(0.2);
    // In-plane axes rotated about x; slices step 3 mm along the normal (0, -s, c).
    const files = [1, 0, 2].map((z) =>
      slice(z, { orientation: [1, 0, 0, 0, c, s], position: [1, 2 - 3 * z * s, 3 + 3 * z * c] }),
    );
    const v = readVolume(files);
    v.spacing.forEach((x, i) => expect(x).toBeCloseTo([0.5, 0.75, 3][i], 9));
    v.origin.forEach((x, i) => expect(x).toBeCloseTo([1, 2, 3][i], 9));
    v.direction.forEach((x, i) => expect(x).toBeCloseTo([1, 0, 0, 0, c, s, 0, -s, c][i], 9));
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('applies an integer rescale as CT numbers in Int16', () => {
    const v = readVolume([0, 1, 2].map((z) => slice(z, { slope: 1, intercept: -1024 })));
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(expected.map((x) => x - 1024));
  });

  it('applies a fractional rescale as Float32, per slice', () => {
    const v = readVolume([slice(0, { slope: 0.5, intercept: 1 }), slice(1, { slope: 2, intercept: 0 })]);
    expect(v.data).toBeInstanceOf(Float32Array);
    expect(Array.from(v.data)).toEqual([...ramp(6).map((x) => x * 0.5 + 1), ...ramp(6, 100).map((x) => x * 2)]);
  });

  it('widens to Int32 when rescaled integers do not fit Int16', () => {
    const v = readVolume([slice(1, { slope: 1000, intercept: 0 })]);
    expect(v.data).toBeInstanceOf(Int32Array);
    expect(Array.from(v.data)).toEqual(ramp(6, 100).map((x) => x * 1000));
  });

  it('reads signed 16-bit and 8-bit pixels', () => {
    const signed = readVolume([slice(0, { signed: true, pixels: encode([-3, -2, -1, 0, 1, 2], 'int16') })]);
    expect(signed.data).toBeInstanceOf(Int16Array);
    expect(Array.from(signed.data)).toEqual([-3, -2, -1, 0, 1, 2]);
    const bytes = readVolume([slice(0, { bits: 8, pixels: encode([0, 1, 2, 3, 4, 255], 'uint8') })]);
    expect(bytes.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes.data)).toEqual([0, 1, 2, 3, 4, 255]);
  });

  it('reads a single slice using its slice thickness', () => {
    const v = readVolume([slice(0, { extra: [dcmEl(0x00180050, 'DS', '4')] })]);
    expect(v.dims).toEqual([3, 2, 1]);
    expect(v.spacing).toEqual([0.5, 0.75, 4]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('falls back to instance order and unit geometry without position tags', () => {
    const files = [2, 0, 1].map((z) => slice(z, { position: undefined, orientation: undefined, pixelSpacing: undefined }));
    const v = readVolume(files);
    expect(v.spacing).toEqual([1, 1, 1]);
    expect(v.origin).toEqual([0, 0, 0]);
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('skips sequences of undefined and defined length, and private tags', () => {
    const nested = dcmSeq(0x00081140, [concat(dcmEl(0x00081150, 'UI', '1.2'), dcmSeq(0x00081199, [dcmEl(0x00081155, 'UI', '9.9')]))]);
    for (const explicit of [true, false]) {
      const extra = [
        explicit ? nested : dcmSeq(0x00081140, [dcmEl(0x00081150, 'UI', '1.2', false)], false),
        dcmSeq(0x00321064, [dcmEl(0x00080100, 'SH', 'X', explicit)], explicit, false),
        dcmEl(0x00091001, 'UN', Uint8Array.of(1, 2, 3, 4), explicit),
      ];
      const v = readVolume([0, 1, 2].map((z) => slice(z, { explicit, extra })));
      expect(Array.from(v.data)).toEqual(expected);
    }
  });

  it('uses the largest series and ignores files that are not DICOM images', () => {
    const scout = slice(7, { series: '9.9.9', rows: 1, cols: 2, pixels: encode([1, 2], 'uint16') });
    const v = readVolume([scout, slice(1), { name: 'DICOMDIR', bytes: ascii('not dicom at all, just text') }, slice(0), slice(2)]);
    expect(v.dims).toEqual([3, 2, 3]);
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('reads files named .dcm and names the volume after the file when there is no description', () => {
    const f = { name: 'dir/head.dcm', bytes: slice(0, { description: undefined }).bytes };
    expect(readVolume([f]).name).toBe('head');
  });

  it('reads a data set without preamble or file meta group', () => {
    const full = slice(0).bytes;
    const meta = dcmFile(TS_EXPLICIT, new Uint8Array(0)).length;
    expect(Array.from(readVolume([{ name: 'raw', bytes: full.subarray(meta) }]).data)).toEqual(ramp(6));
    const implicit = slice(0, { explicit: false }).bytes;
    const metaI = dcmFile(TS_IMPLICIT, new Uint8Array(0)).length;
    expect(Array.from(readVolume([{ name: 'raw', bytes: implicit.subarray(metaI) }]).data)).toEqual(ramp(6));
  });
});

describe('DICOM transfer syntaxes', () => {
  it('reads deflated explicit VR little endian', () => {
    const plain = slice(0, { transferSyntax: '1.2.840.10008.1.2.1.99' }).bytes;
    const meta = dcmFile('1.2.840.10008.1.2.1.99', new Uint8Array(0)).length;
    const bytes = concat(plain.subarray(0, meta), deflateSync(plain.subarray(meta)));
    expect(Array.from(readVolume([{ name: 'd.dcm', bytes }]).data)).toEqual(ramp(6));
  });
  it('explains that big-endian DICOM is not supported', () => {
    expect(() => readVolume([slice(0, { transferSyntax: '1.2.840.10008.1.2.2' })])).toThrow(/Big-endian DICOM is not supported/);
  });
});

describe('DICOM multi-frame', () => {
  const common = (frames: number) => [
    dcmEl(0x0020000e, 'UI', '1.2.3'),
    dcmEl(0x00280002, 'US', us(1)),
    dcmEl(0x00280008, 'IS', String(frames)),
    dcmEl(0x00280010, 'US', us(2)),
    dcmEl(0x00280011, 'US', us(3)),
    dcmEl(0x00280100, 'US', us(16)),
    dcmEl(0x00280103, 'US', us(0)),
  ];
  const pixels = dcmEl(0x7fe00010, 'OW', encode(expected, 'uint16'));

  it('reads a classic multi-frame file with top-level geometry', () => {
    const ds = concat(
      dcmEl(0x00180088, 'DS', '2.5'),
      dcmEl(0x00200032, 'DS', '-10\\-20\\5'),
      dcmEl(0x00200037, 'DS', '1\\0\\0\\0\\1\\0'),
      ...common(3),
      dcmEl(0x00280030, 'DS', '0.75\\0.5'),
      dcmEl(0x00281052, 'DS', '-1024'),
      dcmEl(0x00281053, 'DS', '1'),
      pixels,
    );
    const v = readVolume([{ name: 'mf.dcm', bytes: dcmFile(TS_EXPLICIT, ds) }]);
    expect(v.dims).toEqual([3, 2, 3]);
    expect(v.spacing).toEqual([0.5, 0.75, 2.5]);
    expect(v.origin).toEqual([-10, -20, 5]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(expected.map((x) => x - 1024));
  });

  it('reads an enhanced multi-frame file with per-frame positions, sorting the frames', () => {
    const shared = dcmSeq(0x52009229, [
      concat(
        dcmSeq(0x00209116, [dcmEl(0x00200037, 'DS', '1\\0\\0\\0\\1\\0')]),
        dcmSeq(0x00289110, [concat(dcmEl(0x00180050, 'DS', '2.5'), dcmEl(0x00280030, 'DS', '0.75\\0.5'))]),
        dcmSeq(0x00289145, [concat(dcmEl(0x00281052, 'DS', '-1000'), dcmEl(0x00281053, 'DS', '1'))]),
      ),
    ]);
    // Frames are stored top slice first: z = 10, 7.5, 5.
    const perFrame = dcmSeq(
      0x52009230,
      [10, 7.5, 5].map((z) => dcmSeq(0x00209113, [dcmEl(0x00200032, 'DS', `-10\\-20\\${z}`)])),
    );
    const ds = concat(...common(3), shared, perFrame, pixels);
    const v = readVolume([{ name: 'enhanced.dcm', bytes: dcmFile(TS_EXPLICIT, ds) }]);
    expect(v.dims).toEqual([3, 2, 3]);
    expect(v.spacing).toEqual([0.5, 0.75, 2.5]);
    expect(v.origin).toEqual([-10, -20, 5]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(v.data)).toEqual([...ramp(6, 200), ...ramp(6, 100), ...ramp(6, 0)].map((x) => x - 1000));
  });
});

describe('DICOM errors', () => {
  it('explains that compressed transfer syntaxes are not supported', () => {
    const jpeg = slice(0, { transferSyntax: '1.2.840.10008.1.2.4.70' });
    expect(() => readVolume([jpeg])).toThrow('Compressed DICOM is not supported yet. Convert the series to NIfTI first.');
  });
  it('reports a series with a missing slice instead of guessing', () => {
    expect(() => readVolume([slice(0), slice(1), slice(3)])).toThrow(/missing or unevenly spaced/);
  });
  it('reports truncated pixel data', () => {
    const f = slice(0);
    expect(() => readVolume([{ name: 'a.dcm', bytes: f.bytes.subarray(0, f.bytes.length - 4) }])).toThrow(/incomplete or damaged/);
  });
  it('reports colour images', () => {
    const rgb = dcmFile(
      TS_EXPLICIT,
      concat(
        dcmEl(0x00280002, 'US', us(3)),
        dcmEl(0x00280010, 'US', us(1)),
        dcmEl(0x00280011, 'US', us(1)),
        dcmEl(0x00280100, 'US', us(8)),
        dcmEl(0x7fe00010, 'OB', Uint8Array.of(1, 2, 3, 0)),
      ),
    );
    expect(() => readVolume([{ name: 'rgb.dcm', bytes: rgb }])).toThrow(/colour/i);
  });
  it('reports a DICOM file without an image', () => {
    const report = dcmFile(TS_EXPLICIT, dcmEl(0x00080060, 'CS', 'SR'));
    expect(() => readVolume([{ name: 'sr.dcm', bytes: report }])).toThrow(/no image/i);
  });
  it('reports slices of different sizes in one series', () => {
    const odd = slice(1, { rows: 1, cols: 2, pixels: encode([1, 2], 'uint16') });
    expect(() => readVolume([slice(0), odd])).toThrow(/different sizes/);
  });
});
