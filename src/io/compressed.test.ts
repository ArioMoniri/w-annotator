import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import charlsFactory from '@cornerstonejs/codec-charls/wasmjs';
import openjpegFactory from '@cornerstonejs/codec-openjpeg/wasmjs';
import openjphFactory from '@cornerstonejs/codec-openjph/wasmjs';
import type { CodecLoader, FrameDecoder } from './dicom';
import { readVolume, readVolumeAsync } from './index';
import { concat, dcmEl, dcmFile, dcmSlice, encode, us } from './fixtures';
import type { InputFile } from './types';

const RLE = '1.2.840.10008.1.2.5';
const JPEG_LS = '1.2.840.10008.1.2.4.80';
const J2K = '1.2.840.10008.1.2.4.90';
const HTJ2K = '1.2.840.10008.1.2.4.201';

// ---- builders, independent of the code under test ----

function item(tag: number, body: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, tag >>> 16, true);
  dv.setUint16(2, tag & 0xffff, true);
  dv.setUint32(4, body.length, true);
  return concat(head, body);
}

const even = (b: Uint8Array) => (b.length % 2 ? concat(b, Uint8Array.of(0)) : b);

/**
 * Encapsulated pixel data: an offset table item, then every fragment as an item.
 * `frames` lists the fragments of each frame. `table` 'basic' fills the basic offset table.
 */
function encapsulated(frames: Uint8Array[][], table: 'basic' | 'empty' = 'empty'): Uint8Array {
  const items: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  for (const fragments of frames) {
    offsets.push(pos);
    for (const f of fragments) {
      const it = item(0xfffee000, even(f));
      items.push(it);
      pos += it.length;
    }
  }
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, 0x7fe0, true);
  dv.setUint16(2, 0x0010, true);
  head.set([0x4f, 0x42], 4); // OB
  dv.setUint32(8, 0xffffffff, true);
  return concat(
    head,
    item(0xfffee000, table === 'basic' ? encode(offsets, 'uint32') : new Uint8Array(0)),
    ...items,
    item(0xfffee0dd, new Uint8Array(0)),
  );
}

interface ImageOpts {
  transferSyntax: string;
  rows: number;
  cols: number;
  frames?: number;
  bits?: number;
  bitsStored?: number;
  signed?: boolean;
  slope?: number;
  intercept?: number;
  position?: number[];
  photometric?: string;
  instance?: number;
  /** The complete (7FE0,0010) element. */
  pixelData: Uint8Array;
}

function image(o: ImageOpts): Uint8Array {
  const bits = o.bits ?? 16;
  const parts = [
    dcmEl(0x00180088, 'DS', '2.5'),
    dcmEl(0x0020000e, 'UI', '1.2.3'),
    dcmEl(0x00200013, 'IS', String(o.instance ?? 1)),
    dcmEl(0x00200032, 'DS', (o.position ?? [-10, -20, 5]).join('\\')),
    dcmEl(0x00200037, 'DS', '1\\0\\0\\0\\1\\0'),
    dcmEl(0x00280002, 'US', us(1)),
    dcmEl(0x00280004, 'CS', o.photometric ?? 'MONOCHROME2'),
  ];
  if (o.frames) parts.push(dcmEl(0x00280008, 'IS', String(o.frames)));
  parts.push(
    dcmEl(0x00280010, 'US', us(o.rows)),
    dcmEl(0x00280011, 'US', us(o.cols)),
    dcmEl(0x00280030, 'DS', '0.75\\0.5'),
    dcmEl(0x00280100, 'US', us(bits)),
    dcmEl(0x00280101, 'US', us(o.bitsStored ?? bits)),
    dcmEl(0x00280102, 'US', us((o.bitsStored ?? bits) - 1)),
    dcmEl(0x00280103, 'US', us(o.signed ? 1 : 0)),
  );
  if (o.intercept !== undefined) parts.push(dcmEl(0x00281052, 'DS', String(o.intercept)));
  if (o.slope !== undefined) parts.push(dcmEl(0x00281053, 'DS', String(o.slope)));
  return dcmFile(o.transferSyntax, concat(...parts, o.pixelData));
}

/** PackBits as DICOM RLE uses it: replicate runs of 2..128 equal bytes, literal runs of 1..128 bytes. */
function packBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run > 1) {
      out.push(257 - run, src[i]);
      i += run;
      continue;
    }
    const start = i;
    i++;
    while (i < src.length && i - start < 128 && !(i + 1 < src.length && src[i + 1] === src[i])) i++;
    out.push(i - start - 1, ...src.subarray(start, i));
  }
  if (out.length % 2) out.push(0x80); // the no-op byte pads a segment to an even length
  return Uint8Array.from(out);
}

/** One RLE frame: the 64-byte header, then one PackBits segment per byte plane, most significant first. */
function rleFrame(pixels: Uint8Array, bytesPerPixel: number): Uint8Array {
  const count = pixels.length / bytesPerPixel;
  const segments: Uint8Array[] = [];
  for (let s = 0; s < bytesPerPixel; s++) {
    const plane = new Uint8Array(count);
    for (let p = 0; p < count; p++) plane[p] = pixels[p * bytesPerPixel + (bytesPerPixel - 1 - s)];
    segments.push(packBits(plane));
  }
  const header = new Uint8Array(64);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, segments.length, true);
  let offset = 64;
  segments.forEach((seg, s) => {
    dv.setUint32(4 + 4 * s, offset, true);
    offset += seg.length;
  });
  return concat(header, ...segments);
}

// 5 columns x 4 rows; runs, single values and negative numbers so that both kinds of PackBits run occur.
const COLS = 5;
const ROWS = 4;
const phantom = (z: number): number[] =>
  Array.from({ length: COLS * ROWS }, (_, p) => (p < 7 ? -1000 : p % 4 === 0 ? 3000 + z : p * 37 + z * 101 - 500));

// ---- a decoder that needs no codec: the "compressed" frame is the pixel bytes with a JPEG end marker ----

const fakeEncode = (pixels: Uint8Array) => concat(pixels, Uint8Array.of(0xff, 0xd9));
const fakeDecoder: FrameDecoder = (encoded) => {
  // A padding byte may follow the end marker.
  const end = encoded[encoded.length - 1] === 0xd9 ? encoded.length - 2 : encoded.length - 3;
  return encoded.slice(0, end);
};
const fakeCodecs: CodecLoader = async () => fakeDecoder;

function halves(b: Uint8Array): Uint8Array[] {
  const cut = (b.length >> 2) * 2;
  return [b.subarray(0, cut), b.subarray(cut)];
}

const fixture = (name: string): InputFile => ({
  name,
  bytes: new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
});

describe('RLE Lossless DICOM', () => {
  it('round-trips a hand-compressed 16-bit series with rescale applied after decoding', async () => {
    const files = [2, 0, 1].map((z) => ({
      name: `IM${z}`,
      bytes: image({
        transferSyntax: RLE,
        rows: ROWS,
        cols: COLS,
        signed: true,
        intercept: -24,
        slope: 2,
        position: [-10, -20, 5 + 2.5 * z],
        instance: z + 1,
        pixelData: encapsulated([[rleFrame(encode(phantom(z), 'int16'), 2)]]),
      }),
    }));
    const v = await readVolumeAsync(files);
    expect(v.dims).toEqual([COLS, ROWS, 3]);
    expect(v.spacing).toEqual([0.5, 0.75, 2.5]);
    expect(v.origin).toEqual([-10, -20, 5]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual([0, 1, 2].flatMap(phantom).map((x) => x * 2 - 24));
  });

  it('reads an 8-bit multi-frame file with a basic offset table', async () => {
    const frames = [0, 1].map((z) => Uint8Array.from(phantom(z), (x) => x & 0xff));
    const bytes = image({
      transferSyntax: RLE,
      rows: ROWS,
      cols: COLS,
      bits: 8,
      frames: 2,
      pixelData: encapsulated(frames.map((f) => [rleFrame(f, 1)]), 'basic'),
    });
    const v = await readVolumeAsync([{ name: 'mf.dcm', bytes }]);
    expect(v.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(v.data)).toEqual([...frames[0], ...frames[1]]);
  });

  it('reports a damaged RLE frame', async () => {
    const frame = rleFrame(encode(phantom(0), 'int16'), 2);
    const bytes = image({ transferSyntax: RLE, rows: ROWS, cols: COLS, pixelData: encapsulated([[frame.subarray(0, 70)]]) });
    await expect(readVolumeAsync([{ name: 'a.dcm', bytes }])).rejects.toThrow(/incomplete or damaged/);
  });

  it('reads a file written by pydicom', async () => {
    const v = await readVolumeAsync([fixture('rle.dcm')]);
    expect(v.dims).toEqual([40, 36, 3]);
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual(fixtureValues());
  });
});

/** What make_fixtures.py put in the 16-bit fixtures. */
function fixtureValues(): number[] {
  const out: number[] = [];
  for (let f = 0; f < 3; f++) for (let p = 0; p < 36 * 40; p++) out.push(((p * 37 + f * 101) % 4000) - 1000);
  return out;
}

describe('encapsulated pixel data', () => {
  const frames = [0, 1, 2].map((z) => encode(phantom(z), 'int16'));
  const expected = [0, 1, 2].flatMap(phantom);
  const read = (pixelData: Uint8Array, o: Partial<ImageOpts> = {}) =>
    readVolumeAsync(
      [{ name: 'mf.dcm', bytes: image({ transferSyntax: JPEG_LS, rows: ROWS, cols: COLS, frames: 3, signed: true, pixelData, ...o }) }],
      { loadCodec: fakeCodecs },
    );

  it('takes one fragment per frame when the offset table is empty', async () => {
    const v = await read(encapsulated(frames.map((f) => [fakeEncode(f)])));
    expect(v.dims).toEqual([COLS, ROWS, 3]);
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('joins the fragments of each frame using the basic offset table', async () => {
    const v = await read(encapsulated(frames.map((f) => halves(fakeEncode(f))), 'basic'));
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('joins fragments up to each end-of-image marker when there is no offset table', async () => {
    // Frame 0 in three fragments, frame 1 in one, frame 2 in two.
    const [a, b] = halves(fakeEncode(frames[0]));
    const v = await read(encapsulated([[a.subarray(0, 4), a.subarray(4), b], [fakeEncode(frames[1])], halves(fakeEncode(frames[2]))]));
    expect(Array.from(v.data)).toEqual(expected);
  });

  it('joins every fragment of a single-frame file', async () => {
    const v = await read(encapsulated([halves(fakeEncode(frames[1]))]), { frames: undefined });
    expect(v.dims).toEqual([COLS, ROWS, 1]);
    expect(Array.from(v.data)).toEqual(phantom(1));
  });

  it('gives each decoder call the frame description', async () => {
    const decode = vi.fn(fakeDecoder);
    await readVolumeAsync(
      [{ name: 'a.dcm', bytes: image({ transferSyntax: J2K, rows: ROWS, cols: COLS, signed: true, bitsStored: 12, pixelData: encapsulated([[fakeEncode(frames[0])]]) }) }],
      { loadCodec: async () => decode },
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0][1]).toEqual({ rows: ROWS, cols: COLS, bitsAllocated: 16, bitsStored: 12, signed: true, transferSyntax: J2K });
  });

  it('sign-extends signed pixels stored in fewer bits than allocated', async () => {
    // A codec returns 12-bit two's complement in the low bits: 0xfff is -1, 0x800 is -2048.
    const raw = encode([0xfff, 0x800, 0x7ff, 5], 'uint16');
    const v = await read(encapsulated([[fakeEncode(raw)]]), { rows: 2, cols: 2, frames: undefined, bitsStored: 12 });
    expect(v.data).toBeInstanceOf(Int16Array);
    expect(Array.from(v.data)).toEqual([-1, -2048, 2047, 5]);
  });

  it('widens 8-bit decoder output when 16 bits are allocated', async () => {
    const v = await readVolumeAsync(
      [{ name: 'a.dcm', bytes: image({ transferSyntax: J2K, rows: 1, cols: 3, pixelData: encapsulated([[Uint8Array.of(1, 2)]]) }) }],
      { loadCodec: async () => () => Uint8Array.of(7, 200, 9) },
    );
    expect(v.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(v.data)).toEqual([7, 200, 9]);
  });

  it('reports a decoder result of the wrong size', async () => {
    const short = read(encapsulated(frames.map((f) => [fakeEncode(f.subarray(0, 10))])));
    await expect(short).rejects.toThrow(/incomplete or damaged/);
  });

  it('reports a decoder that fails as a damaged file', async () => {
    const failing: CodecLoader = async () => () => {
      throw new Error('bad marker');
    };
    const bytes = image({ transferSyntax: J2K, rows: ROWS, cols: COLS, pixelData: encapsulated([[fakeEncode(frames[0])]]) });
    await expect(readVolumeAsync([{ name: 'a.dcm', bytes }], { loadCodec: failing })).rejects.toThrow(/incomplete or damaged/);
  });

  it('reports pixel data cut off inside a fragment', async () => {
    const whole = image({ transferSyntax: J2K, rows: ROWS, cols: COLS, pixelData: encapsulated([[fakeEncode(frames[0])]]) });
    await expect(readVolumeAsync([{ name: 'a.dcm', bytes: whole.subarray(0, whole.length - 20) }], { loadCodec: fakeCodecs })).rejects.toThrow(
      /incomplete or damaged/,
    );
  });

  it('reports fewer frames than the header promises', async () => {
    await expect(read(encapsulated(frames.slice(0, 2).map((f) => [fakeEncode(f)])))).rejects.toThrow(/incomplete or damaged/);
  });

  it('only decodes the series that is opened', async () => {
    const loadCodec = vi.fn(fakeCodecs);
    const scout = { name: 'scout', bytes: dcmSlice({ rows: 1, cols: 2, pixels: encode([1, 2], 'uint16'), series: '9.9' }) };
    const big = { name: 'mf', bytes: image({ transferSyntax: J2K, rows: ROWS, cols: COLS, frames: 3, signed: true, pixelData: encapsulated(frames.map((f) => [fakeEncode(f)])) }) };
    const v = await readVolumeAsync([scout, big], { loadCodec });
    expect(Array.from(v.data)).toEqual(expected);
    expect(loadCodec).toHaveBeenCalledTimes(1);
    expect(loadCodec).toHaveBeenCalledWith(J2K);
  });
});

describe('readVolumeAsync', () => {
  const plain = (z: number) => ({
    name: `IM${z}`,
    bytes: dcmSlice({ rows: ROWS, cols: COLS, pixels: encode(phantom(z), 'int16'), signed: true, position: [0, 0, z], orientation: [1, 0, 0, 0, 1, 0], intercept: -5 }),
  });

  it('gives the same volume as readVolume for uncompressed DICOM, without loading a codec', async () => {
    const loadCodec = vi.fn(fakeCodecs);
    const files = [plain(1), plain(0)];
    expect(await readVolumeAsync(files, { loadCodec })).toEqual(readVolume(files));
    expect(loadCodec).not.toHaveBeenCalled();
  });

  it('gives the same errors as readVolume', async () => {
    await expect(readVolumeAsync([])).rejects.toThrow(/No file/);
    await expect(readVolumeAsync([{ name: 'notes.txt', bytes: new Uint8Array(40).fill(65) }])).rejects.toThrow(/not a supported image/);
    await expect(readVolumeAsync([{ name: 'a.nii', bytes: new Uint8Array(10) }])).rejects.toBeInstanceOf(Error);
  });

  it('explains which compressions it cannot read', async () => {
    const mpeg = image({ transferSyntax: '1.2.840.10008.1.2.4.100', rows: 1, cols: 1, pixelData: encapsulated([[Uint8Array.of(1, 2)]]) });
    await expect(readVolumeAsync([{ name: 'v.dcm', bytes: mpeg }])).rejects.toThrow(
      'This DICOM file uses a compression that cannot be opened (1.2.840.10008.1.2.4.100). Convert the series to NIfTI first.',
    );
  });
});

describe('readVolume with compressed DICOM', () => {
  it('says that compressed files need the asynchronous reader', () => {
    const bytes = image({ transferSyntax: RLE, rows: ROWS, cols: COLS, pixelData: encapsulated([[rleFrame(encode(phantom(0), 'uint16'), 2)]]) });
    expect(() => readVolume([{ name: 'a.dcm', bytes }])).toThrow('Compressed DICOM cannot be read synchronously. Use readVolumeAsync.');
  });
});

// ---- the real codecs ----

interface Encoder {
  getDecodedBuffer(info: {
    width: number;
    height: number;
    bitsPerSample: number;
    componentCount: number;
    isSigned: boolean;
    isUsingColorTransform: boolean;
  }): Uint8Array;
  encode(): void;
  getEncodedBuffer(): Uint8Array;
  delete(): void;
}
type EncoderModule = Record<string, new () => Encoder>;

async function encodeWith(factory: () => Promise<unknown>, cls: string, pixels: Uint8Array, bits: number, signed: boolean): Promise<Uint8Array> {
  const codec = (await factory()) as EncoderModule;
  const encoder = new codec[cls]();
  encoder
    .getDecodedBuffer({ width: COLS8, height: ROWS8, bitsPerSample: bits, componentCount: 1, isSigned: signed, isUsingColorTransform: false })
    .set(pixels);
  encoder.encode();
  const out = encoder.getEncodedBuffer().slice();
  encoder.delete();
  return out;
}

// Large enough for the wavelet codecs' default decomposition levels.
const COLS8 = 40;
const ROWS8 = 36;
const big = (z: number): number[] => Array.from({ length: COLS8 * ROWS8 }, (_, p) => ((p * 53 + z * 977) % 5000) - 2000);

describe('wasm codecs', () => {
  const cases: [string, string, () => Promise<unknown>, string][] = [
    ['JPEG-LS', JPEG_LS, charlsFactory, 'JpegLSEncoder'],
    ['JPEG 2000', J2K, openjpegFactory, 'J2KEncoder'],
    ['HTJ2K', HTJ2K, openjphFactory, 'HTJ2KEncoder'],
  ];
  for (const [name, transferSyntax, factory, cls] of cases) {
    it(`round-trips ${name} lossless, signed 16-bit, two frames`, async () => {
      const frames = await Promise.all([0, 1].map((z) => encodeWith(factory, cls, encode(big(z), 'int16'), 16, true)));
      const bytes = image({
        transferSyntax,
        rows: ROWS8,
        cols: COLS8,
        frames: 2,
        signed: true,
        intercept: -1,
        pixelData: encapsulated(frames.map((f) => halves(f)), 'basic'),
      });
      const v = await readVolumeAsync([{ name: 'c.dcm', bytes }]);
      expect(v.dims).toEqual([COLS8, ROWS8, 2]);
      expect(v.data).toBeInstanceOf(Int16Array);
      expect(Array.from(v.data)).toEqual([...big(0), ...big(1)].map((x) => x - 1));
    });
  }

  it('round-trips JPEG-LS unsigned 8-bit', async () => {
    const pixels = Uint8Array.from(big(0), (x) => x & 0xff);
    const frame = await encodeWith(charlsFactory, 'JpegLSEncoder', pixels, 8, false);
    const bytes = image({ transferSyntax: JPEG_LS, rows: ROWS8, cols: COLS8, bits: 8, pixelData: encapsulated([[frame]]) });
    const v = await readVolumeAsync([{ name: 'c.dcm', bytes }]);
    expect(v.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(v.data)).toEqual(Array.from(pixels));
  });

  it('reports a corrupt JPEG 2000 stream as a damaged file', async () => {
    const junk = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
    const bytes = image({ transferSyntax: J2K, rows: ROWS8, cols: COLS8, pixelData: encapsulated([[junk]]) });
    await expect(readVolumeAsync([{ name: 'c.dcm', bytes }])).rejects.toThrow(/incomplete or damaged/);
  });
});

describe('compressed files written by other software', () => {
  for (const name of ['jpegls.dcm', 'j2k.dcm', 'jpeglossless.dcm']) {
    it(`reads ${name} exactly`, async () => {
      const v = await readVolumeAsync([fixture(name)]);
      expect(v.name).toBe('Phantom');
      expect(v.dims).toEqual([40, 36, 3]);
      expect(v.spacing.slice(0, 2)).toEqual([0.5, 0.75]);
      // GDCM dropped SpacingBetweenSlices when it rewrote the file.
      if (name !== 'jpeglossless.dcm') expect(v.spacing[2]).toBe(2.5);
      expect(v.data).toBeInstanceOf(Int16Array);
      expect(Array.from(v.data)).toEqual(fixtureValues());
    });
  }

  it('reads JPEG Baseline within the loss of the compression', async () => {
    const v = await readVolumeAsync([fixture('jpegbaseline.dcm')]);
    expect(v.dims).toEqual([40, 36, 3]);
    expect(v.data).toBeInstanceOf(Uint8Array);
    let worst = 0;
    for (let f = 0; f < 3; f++) {
      for (let y = 0; y < 36; y++) {
        for (let x = 0; x < 40; x++) worst = Math.max(worst, Math.abs(v.data[(f * 36 + y) * 40 + x] - (3 * x + 2 * y + 10 * f)));
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
  });
});
