import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'fflate';
import { readVolume, writeVolume, type VolumeData, type WriteFormat } from './index';
import { ascii, concat, encode, niftiBytes, ramp, type NiiOpts } from './fixtures';

const NAMES: Record<number, string> = {
  1: 'Liver',
  2: 'Lésion',
  7: 'He said "left" = right\\wrong',
  40: '腎臓 {a: 1}',
  255: ' = ',
};
const FORMATS: WriteFormat[] = ['nii', 'nii.gz', 'mha'];

function mask(labels?: Record<number, string>): VolumeData {
  const v: VolumeData = {
    name: 'mask',
    dims: [4, 3, 2],
    spacing: [0.5, 0.75, 2.5],
    origin: [-120.5, 33.25, -7],
    direction: [0, -1, 0, 0, 0, 1, -1, 0, 0],
    data: new Uint8Array(ramp(24, 3)),
  };
  if (labels) v.labels = labels;
  return v;
}
const reopen = (v: VolumeData, format: WriteFormat) =>
  readVolume([{ name: `mask.${format}`, bytes: writeVolume(v, format) }]);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** One NIfTI header extension: esize, ecode, then the body padded to a multiple of 16 bytes in all. */
function ext(ecode: number, body: Uint8Array, le = true): Uint8Array {
  const esize = Math.ceil((8 + body.length) / 16) * 16;
  const out = new Uint8Array(esize);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, esize, le);
  dv.setInt32(4, ecode, le);
  out.set(body, 8);
  return out;
}

/** A NIfTI file from the fixtures with raw bytes spliced in between the header and the voxels. */
function withExtensions(o: NiiOpts, extra: Uint8Array, extender = [1, 0, 0, 0]): Uint8Array {
  const plain = niftiBytes(o);
  const hdr = o.version === 2 ? 540 : 348;
  const out = concat(plain.subarray(0, hdr), Uint8Array.from(extender), extra, plain.subarray(hdr + 4));
  const dv = new DataView(out.buffer);
  const le = o.le ?? true;
  if (o.version === 2) dv.setBigInt64(168, BigInt(hdr + 4 + extra.length), le);
  else dv.setFloat32(108, hdr + 4 + extra.length, le);
  return out;
}

const opts = (extra: Partial<NiiOpts> = {}): NiiOpts => ({
  dim: [3, 2, 2],
  datatype: 4,
  bitpix: 16,
  data: encode(ramp(12, -5), 'int16', extra.le ?? true),
  sformCode: 1,
  srow: [-0.5, 0, 0, 10, 0, -0.5, 0, 20, 0, 0, 2, 30],
  ...extra,
});
const labelJson = (labels: unknown) => new TextEncoder().encode(JSON.stringify({ 'w-annotator': { labels } }));

describe('segment names survive saving', () => {
  for (const format of FORMATS) {
    it(`${format} keeps names, including accents, quotes and equals signs`, () => {
      const v = mask(NAMES);
      const back = reopen(v, format);
      expect(back.labels).toEqual(NAMES);
      expect(back).toEqual(v);
      expect(back.data).toBeInstanceOf(Uint8Array);
    });

    it(`${format} gives the same voxels and geometry with and without names`, () => {
      const plain = reopen(mask(), format);
      const named = reopen(mask(NAMES), format);
      expect(plain.labels).toBeUndefined();
      expect('labels' in plain).toBe(false);
      expect({ ...named, labels: undefined }).toEqual({ ...plain, labels: undefined });
      expect(plain).toEqual(mask());
    });

    it(`${format} output is byte-identical when there are no names`, () => {
      const none = writeVolume(mask(), format);
      expect(writeVolume(mask({}), format)).toEqual(none);
      expect(writeVolume({ ...mask(), labels: undefined }, format)).toEqual(none);
    });

    it(`${format} is stable when saved again`, () => {
      const once = reopen(mask(NAMES), format);
      expect(writeVolume(once, format)).toEqual(writeVolume(mask(NAMES), format));
    });
  }

  it('keeps names for a 16-bit mask too', () => {
    for (const format of FORMATS) {
      const v = { ...mask({ 300: 'Big' }), data: new Uint16Array(ramp(24, 290)) };
      expect(reopen(v, format)).toEqual(v);
    }
  });
});

describe('NIfTI label extension layout', () => {
  it('without names there is no extension and vox_offset stays 352', () => {
    const b = writeVolume(mask(), 'nii');
    expect(b.length).toBe(352 + 24);
    expect(new DataView(b.buffer).getFloat32(108, true)).toBe(352);
    expect(Array.from(b.subarray(348, 352))).toEqual([0, 0, 0, 0]);
    expect(Array.from(b.subarray(352))).toEqual(ramp(24, 3));
  });

  it('with names there is one comment extension holding UTF-8 JSON', () => {
    const b = writeVolume(mask(NAMES), 'nii');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(Array.from(b.subarray(348, 352))).toEqual([1, 0, 0, 0]);
    const esize = dv.getInt32(352, true);
    expect(esize % 16).toBe(0);
    expect(esize).toBeGreaterThan(8);
    expect(dv.getInt32(356, true)).toBe(6);
    expect(dv.getFloat32(108, true)).toBe(352 + esize);
    expect(b.length).toBe(352 + esize + 24);
    expect(Array.from(b.subarray(352 + esize))).toEqual(ramp(24, 3));
    const body = b.subarray(360, 352 + esize);
    const end = body.indexOf(0) < 0 ? body.length : body.indexOf(0);
    expect(body.subarray(end).every((x) => x === 0)).toBe(true);
    expect(JSON.parse(text(body.subarray(0, end)))).toEqual({
      'w-annotator': { labels: { '1': NAMES[1], '2': NAMES[2], '7': NAMES[7], '40': NAMES[40], '255': NAMES[255] } },
    });
    expect(text(body)).toContain('Lésion');
  });

  it('pads every body length to a multiple of 16', () => {
    for (let n = 0; n < 20; n++) {
      const b = writeVolume(mask({ 1: 'x'.repeat(n) }), 'nii');
      const esize = new DataView(b.buffer).getInt32(352, true);
      expect(esize % 16).toBe(0);
      expect(b.length).toBe(352 + esize + 24);
      expect(readVolume([{ name: 'm.nii', bytes: b }]).labels).toEqual({ 1: 'x'.repeat(n) });
    }
  });

  it('nii.gz is the gzipped NIfTI with the same extension', () => {
    expect(gunzipSync(writeVolume(mask(NAMES), 'nii.gz'))).toEqual(writeVolume(mask(NAMES), 'nii'));
  });
});

describe('NIfTI extensions when reading', () => {
  const expectPlain = (bytes: Uint8Array, name = 'x.nii') => {
    const v = readVolume([{ name, bytes }]);
    expect(Array.from(v.data)).toEqual(ramp(12, -5));
    expect(v.origin).toEqual([-10, -20, 30]);
    expect(v.spacing).toEqual([0.5, 0.5, 2]);
    return v;
  };

  for (const version of [1, 2] as const) {
    for (const le of [true, false]) {
      const tag = `NIfTI-${version} ${le ? 'little' : 'big'}-endian`;

      it(`${tag}: reads names from a comment extension, plain and gzipped`, () => {
        const bytes = withExtensions(opts({ version, le }), ext(6, labelJson({ 1: 'Liver', 2: 'Lésion' }), le));
        expect(expectPlain(bytes).labels).toEqual({ 1: 'Liver', 2: 'Lésion' });
        expect(expectPlain(gzipSync(bytes), 'x.nii.gz').labels).toEqual({ 1: 'Liver', 2: 'Lésion' });
      });

      it(`${tag}: opens files with DICOM and AFNI extensions from other software`, () => {
        const foreign = concat(ext(2, Uint8Array.from(ramp(100)), le), ext(4, ascii('<AFNI_attributes/>'), le));
        expect(expectPlain(withExtensions(opts({ version, le }), foreign)).labels).toBeUndefined();
        const mixed = concat(foreign, ext(6, ascii('just a note'), le), ext(6, labelJson({ 3: 'Spleen' }), le));
        expect(expectPlain(withExtensions(opts({ version, le }), mixed)).labels).toEqual({ 3: 'Spleen' });
      });
    }
  }

  it('ignores a comment extension that is not ours', () => {
    for (const body of ['hello', '{"other":1}', '{"1":"w-annotator"}', '{"w-annotator":5}', '{"w-annotator":{"labels":[1,2]}}', '{broken', '']) {
      expect(expectPlain(withExtensions(opts(), ext(6, ascii(body)))).labels).toBeUndefined();
    }
  });

  it('keeps only well-formed entries of a labels object', () => {
    const body = labelJson({ 1: 'Liver', x: 'no', 2: 5, '-3': 'neg', 1.5: 'frac', __proto__: 'p', 4: '' });
    expect(expectPlain(withExtensions(opts(), ext(6, body))).labels).toEqual({ 1: 'Liver', 4: '' });
  });

  it('does not throw on truncated or garbage extensions', () => {
    const size = (esize: number, ecode = 6) => {
      const e = ext(ecode, labelJson({ 1: 'Liver' }));
      new DataView(e.buffer).setInt32(0, esize, true);
      return e;
    };
    const garbage: Uint8Array[] = [
      size(0),
      size(-16),
      size(7),
      size(1 << 30),
      size(0x7fffffff),
      new Uint8Array(4).fill(0xff),
      new Uint8Array(3),
      Uint8Array.from(ramp(64, 200)),
      concat(ext(4, ascii('ok')), size(4096)),
    ];
    for (const g of garbage) expect(expectPlain(withExtensions(opts(), g)).labels).toBeUndefined();
    // Extender set but no room for any extension at all.
    expect(expectPlain(withExtensions(opts(), new Uint8Array(0))).labels).toBeUndefined();
    // Extender clear: whatever sits before the voxels is not read as an extension.
    const off = withExtensions(opts(), ext(6, labelJson({ 1: 'Liver' })), [0, 0, 0, 0]);
    expect(expectPlain(off).labels).toBeUndefined();
  });

  it('does not throw when vox_offset points before or beyond the extension', () => {
    const bytes = withExtensions(opts(), ext(6, labelJson({ 1: 'Liver' })));
    const short = bytes.slice();
    new DataView(short.buffer).setFloat32(108, 360, true); // cuts the extension header off
    expect(() => readVolume([{ name: 'x.nii', bytes: short }])).not.toThrow();
    expect(readVolume([{ name: 'x.nii', bytes: short }]).labels).toBeUndefined();
    const cut = bytes.subarray(0, 370); // the file ends inside the extension
    expect(() => readVolume([{ name: 'x.nii', bytes: cut }])).toThrow(/incomplete or damaged/);
  });

  it('reads names from the .hdr of a header and .img pair', () => {
    const o = opts({ magic: 'ni1' });
    const hdr = concat(niftiBytes(o), Uint8Array.from([1, 0, 0, 0]), ext(6, labelJson({ 9: 'Aorta' })));
    const v = readVolume([
      { name: 'x.hdr', bytes: hdr },
      { name: 'x.img', bytes: o.data },
    ]);
    expect(Array.from(v.data)).toEqual(ramp(12, -5));
    expect(v.labels).toEqual({ 9: 'Aorta' });
  });
});

describe('MetaImage label line', () => {
  it('writes one ASCII WAnnotatorLabels line before ElementDataFile, which stays last', () => {
    const b = writeVolume(mask(NAMES), 'mha');
    const marker = 'ElementDataFile = LOCAL\n';
    const head = new TextDecoder('latin1').decode(b);
    const header = head.slice(0, head.indexOf(marker) + marker.length);
    const lines = header.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('ElementDataFile = LOCAL');
    const mine = lines.filter((l) => l.startsWith('WAnnotatorLabels = '));
    expect(mine).toHaveLength(1);
    expect(lines.indexOf(mine[0])).toBe(lines.length - 2);
    expect(header).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(JSON.parse(mine[0].slice('WAnnotatorLabels = '.length))).toEqual({ ...NAMES });
  });

  it('writes no label line without names', () => {
    expect(new TextDecoder('latin1').decode(writeVolume(mask(), 'mha'))).not.toContain('WAnnotatorLabels');
  });

  it('reads the line whatever its case and position, and ignores a broken one', () => {
    const file = (line: string) =>
      concat(
        ascii(`ObjectType = Image\n${line}\nNDims = 3\nDimSize = 3 2 2\nElementType = MET_SHORT\nElementDataFile = LOCAL\n`),
        encode(ramp(12), 'int16'),
      );
    const read = (line: string) => readVolume([{ name: 'm.mha', bytes: file(line) }]);
    expect(read('wannotatorlabels={"1":"A = B","2":"L\\u00e9sion"}\r').labels).toEqual({ 1: 'A = B', 2: 'Lésion' });
    expect(read('WAnnotatorLabels = {"w-annotator":{"labels":{"5":"Wrapped"}}}').labels).toEqual({ 5: 'Wrapped' });
    for (const bad of ['WAnnotatorLabels = {"1":', 'WAnnotatorLabels = ', 'WAnnotatorLabels = [1]', 'Other = 1']) {
      const v = read(bad);
      expect(v.labels).toBeUndefined();
      expect(Array.from(v.data)).toEqual(ramp(12));
    }
  });
});
