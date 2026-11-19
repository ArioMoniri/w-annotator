import { describe, expect, it } from 'vitest';
import { isDicomSeg, readDicomSeg, writeDicomSeg } from './dicomseg';
import { readVolume, readVolumeAsync, resampleNearest, writeMask } from './index';
import { ascii, concat, dcmEl, dcmFile, dcmSeq, dcmSlice, encode, TS_EXPLICIT, us } from './fixtures';
import type { DicomSourceInfo, InputFile, VolumeData } from './types';

const SEG_CLASS = '1.2.840.10008.5.1.4.1.1.66.4';
const CT_CLASS = '1.2.840.10008.5.1.4.1.1.2';

// ---- a mask whose slices differ, with empty slices at both ends and in the middle ----

const COLS = 5;
const ROWS = 3; // 15 pixels per frame: frames do not end on byte boundaries
const SLICES = 6;
const c = Math.cos(0.3);
const s = Math.sin(0.3);

/** Labels 1, 2 and 5 on slices 1, 2 and 4; slices 0, 3 and 5 are empty. */
function maskData(): Uint8Array {
  const data = new Uint8Array(COLS * ROWS * SLICES);
  const set = (i: number, j: number, k: number, v: number) => (data[i + j * COLS + k * COLS * ROWS] = v);
  set(0, 0, 1, 1);
  set(1, 0, 1, 1);
  set(4, 2, 1, 2);
  set(2, 1, 2, 2);
  set(3, 1, 2, 5);
  set(0, 2, 2, 1);
  set(4, 0, 4, 5);
  set(4, 1, 4, 5);
  set(0, 1, 4, 1);
  return data;
}

/** Oblique: the in-plane axes are rotated about x, slices step along the tilted normal. */
function obliqueMask(): VolumeData {
  return {
    name: 'Liver mask',
    dims: [COLS, ROWS, SLICES],
    spacing: [0.7, 0.9, 2.5],
    origin: [-12.3, 45.6, -78.9],
    direction: [1, 0, 0, 0, c, s, 0, -s, c],
    data: maskData(),
  };
}

const SEGMENTS = [
  { index: 1, name: 'Liver', color: [220, 20, 60] as [number, number, number] },
  { index: 2, name: 'Tumour', color: [30, 144, 255] as [number, number, number] },
  { index: 5, name: 'Vessel' },
];

const file = (bytes: Uint8Array, name = 'seg.dcm'): InputFile => ({ name, bytes });

// ---- a small explicit-VR walker, independent of the reader under test ----

interface Node {
  tag: number;
  vr: string;
  value: Uint8Array;
  items?: Node[][];
}
const LONG = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UC', 'UN', 'UR', 'UT']);

function walk(b: Uint8Array, start = 0, end = b.length): Node[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Node[] = [];
  let pos = start;
  while (pos < end) {
    const tag = dv.getUint16(pos, true) * 0x10000 + dv.getUint16(pos + 2, true);
    const vr = String.fromCharCode(b[pos + 4], b[pos + 5]);
    const long = LONG.has(vr);
    const len = long ? dv.getUint32(pos + 8, true) : dv.getUint16(pos + 6, true);
    const off = pos + (long ? 12 : 8);
    const node: Node = { tag, vr, value: b.subarray(off, off + len) };
    if (vr === 'SQ') {
      node.items = [];
      let p = off;
      while (p < off + len) {
        const itemLen = dv.getUint32(p + 4, true);
        node.items.push(walk(b, p + 8, p + 8 + itemLen));
        p += 8 + itemLen;
      }
    }
    out.push(node);
    pos = off + len;
  }
  return out;
}
const parse = (bytes: Uint8Array) => walk(bytes, 132);
const find = (nodes: Node[], tag: number) => nodes.find((n) => n.tag === tag);
const text = (nodes: Node[], tag: number) => {
  const n = find(nodes, tag);
  return n ? new TextDecoder().decode(n.value).replace(/[\0 ]+$/, '') : undefined;
};
const tags = (nodes: Node[]) => nodes.map((n) => n.tag);

describe('writeDicomSeg and readDicomSeg', () => {
  it('round-trips a multi-segment oblique mask voxel for voxel, with the same geometry', () => {
    const mask = obliqueMask();
    const back = readDicomSeg(file(writeDicomSeg(mask, { segments: SEGMENTS })));
    expect(back.dims).toEqual(mask.dims);
    expect(back.spacing).toEqual(mask.spacing);
    expect(back.origin).toEqual(mask.origin);
    expect(back.direction).toEqual(mask.direction);
    expect(back.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.data)).toEqual(Array.from(mask.data));
    expect(back.name).toBe('Liver mask');
    expect(back.warnings).toBeUndefined();
  });

  it('keeps segment names and colours', () => {
    const back = readDicomSeg(file(writeDicomSeg(obliqueMask(), { segments: SEGMENTS })));
    expect(back.labels).toEqual({ 1: 'Liver', 2: 'Tumour', 5: 'Vessel' });
    expect(back.colors).toEqual({ 1: [220, 20, 60], 2: [30, 144, 255] });
  });

  it('keeps every 8-bit grey and the primary colours through the CIELab encoding', () => {
    const colours: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [1, 2, 3], [254, 127, 64]];
    for (let g = 0; g < 256; g += 5) colours.push([g, g, g]);
    const mask: VolumeData = { ...obliqueMask(), dims: [1, 1, 1], data: Uint8Array.of(1) };
    const segments = colours.map((color, n) => ({ index: n + 1, name: `c${n}`, color }));
    const back = readDicomSeg(file(writeDicomSeg(mask, { segments })));
    colours.forEach((color, n) => expect(back.colors?.[n + 1]).toEqual(color));
  });

  it('keeps names outside ASCII', () => {
    const back = readDicomSeg(file(writeDicomSeg(obliqueMask(), { segments: [{ index: 1, name: 'Nódulo 肝' }] })));
    expect(back.labels?.[1]).toBe('Nódulo 肝');
  });

  it('round-trips a mask whose slice axis runs against the plane normal', () => {
    const mask = { ...obliqueMask(), direction: [1, 0, 0, 0, 1, 0, 0, 0, -1] };
    const back = readDicomSeg(file(writeDicomSeg(mask, { segments: SEGMENTS })));
    expect(back.origin).toEqual(mask.origin);
    expect(back.direction).toEqual(mask.direction);
    expect(Array.from(back.data)).toEqual(Array.from(mask.data));
  });

  it('names segments that the caller did not list', () => {
    const back = readDicomSeg(file(writeDicomSeg(obliqueMask(), { segments: [{ index: 2, name: 'Tumour' }] })));
    expect(back.labels).toEqual({ 1: 'Segment 1', 2: 'Tumour', 5: 'Segment 5' });
    expect(Array.from(back.data)).toEqual(Array.from(maskData()));
  });

  it('writes an empty mask as one empty frame that reads back empty on the same grid', () => {
    const mask = { ...obliqueMask(), data: new Uint8Array(COLS * ROWS * SLICES) };
    const bytes = writeDicomSeg(mask, { segments: SEGMENTS });
    expect(text(parse(bytes), 0x00280008)).toBe('1');
    const back = readDicomSeg(file(bytes));
    expect(back.dims).toEqual(mask.dims);
    expect(back.origin).toEqual(mask.origin);
    expect(back.data.every((v) => v === 0)).toBe(true);
    expect(back.labels).toEqual({ 1: 'Liver', 2: 'Tumour', 5: 'Vessel' });
  });

  it('reads label numbers above 255 into 16 bits', () => {
    const data = new Uint16Array(COLS * ROWS * 2);
    data[3] = 300;
    data[20] = 7;
    const mask: VolumeData = { ...obliqueMask(), dims: [COLS, ROWS, 2], data };
    const back = readDicomSeg(file(writeDicomSeg(mask, { segments: [] })));
    expect(back.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });

  it('refuses masks that cannot be a segmentation', () => {
    const mask = obliqueMask();
    expect(() => writeDicomSeg({ ...mask, data: new Uint8Array(mask.data.length) }, { segments: [] })).toThrow(/no segment/i);
    expect(() => writeDicomSeg({ ...mask, data: Float32Array.from(mask.data, (v) => v * 0.5) }, { segments: [] })).toThrow(/not label numbers/);
    expect(() => writeDicomSeg(mask, { segments: [{ index: 0, name: 'Background' }] })).toThrow(/segment number/);
  });
});

describe('the DICOM SEG file that is written', () => {
  const written = (options: Partial<Parameters<typeof writeDicomSeg>[1]> = {}) =>
    writeDicomSeg(obliqueMask(), { segments: SEGMENTS, date: new Date(2026, 10, 19, 13, 5, 9), ...options });

  it('starts with the preamble and a file meta group for explicit VR little endian', () => {
    const bytes = written();
    expect(new TextDecoder().decode(bytes.subarray(128, 132))).toBe('DICM');
    const nodes = parse(bytes);
    expect(text(nodes, 0x00020002)).toBe(SEG_CLASS);
    expect(text(nodes, 0x00020010)).toBe(TS_EXPLICIT);
    expect(text(nodes, 0x00020003)).toBe(text(nodes, 0x00080018));
    // The group length counts the bytes of the rest of group 0002.
    const meta = nodes.filter((n) => n.tag >>> 16 === 2);
    const length = new DataView(meta[0].value.buffer, meta[0].value.byteOffset).getUint32(0, true);
    const firstOfDataset = find(nodes, 0x00080005) as Node;
    expect(132 + 12 + length).toBe(firstOfDataset.value.byteOffset - bytes.byteOffset - 8);
  });

  it('keeps elements in ascending tag order at every level, with even lengths', () => {
    const check = (nodes: Node[]) => {
      const t = tags(nodes);
      expect(t).toEqual([...t].sort((a, b) => a - b));
      expect(new Set(t).size).toBe(t.length);
      for (const n of nodes) {
        expect(n.value.length % 2).toBe(0);
        n.items?.forEach(check);
      }
    };
    check(parse(written()));
  });

  it('is a binary segmentation with one packed frame per segment and non-empty slice', () => {
    const nodes = parse(written());
    expect(text(nodes, 0x00080016)).toBe(SEG_CLASS);
    expect(text(nodes, 0x00080060)).toBe('SEG');
    expect(text(nodes, 0x00620001)).toBe('BINARY');
    expect(text(nodes, 0x00080023)).toBe('20261119');
    expect(text(nodes, 0x00080033)).toBe('130509');
    // Segment 1 on slices 1, 2, 4; segment 2 on 1, 2; segment 5 on 2, 4.
    expect(text(nodes, 0x00280008)).toBe('7');
    expect(Array.from(find(nodes, 0x00280100)?.value ?? [])).toEqual([1, 0]);
    expect(Array.from(find(nodes, 0x00280010)?.value ?? [])).toEqual([ROWS, 0]);
    expect(Array.from(find(nodes, 0x00280011)?.value ?? [])).toEqual([COLS, 0]);
    const pixels = find(nodes, 0x7fe00010) as Node;
    expect(pixels.vr).toBe('OB');
    expect(pixels.value.length).toBe(14); // 7 frames x 15 bits = 105 bits = 14 bytes
    // Frame 0 is segment 1 on slice 1: pixels 0 and 1. Frame 1 (bits 15..29) is segment 1 on slice 2: pixel 10, bit 25.
    expect(pixels.value[0]).toBe(0b00000011);
    expect(pixels.value[3]).toBe(0b00000010);
    const perFrame = find(nodes, 0x52009230)?.items ?? [];
    expect(perFrame).toHaveLength(7);
    const segmentOf = perFrame.map((f) => (find(find(f, 0x0062000a)?.items?.[0] ?? [], 0x0062000b) as Node).value[0]);
    expect(segmentOf).toEqual([1, 1, 1, 2, 2, 5, 5]);
    const z1 = text(find(perFrame[0], 0x00209113)?.items?.[0] ?? [], 0x00200032)?.split('\\').map(Number) ?? [];
    [-12.3, 45.6 - 2.5 * s, -78.9 + 2.5 * c].forEach((v, n) => expect(z1[n]).toBeCloseTo(v, 9));
  });

  it('describes each segment with a number, a label, a generic tissue code and a colour when given', () => {
    const segments = find(parse(written()), 0x00620002)?.items ?? [];
    expect(segments).toHaveLength(3);
    expect(segments.map((item) => text(item, 0x00620005))).toEqual(['Liver', 'Tumour', 'Vessel']);
    expect(segments.map((item) => (find(item, 0x00620004) as Node).value[0])).toEqual([1, 2, 5]);
    for (const item of segments) {
      for (const sequence of [0x00620003, 0x0062000f]) {
        const codeItem = find(item, sequence)?.items?.[0] ?? [];
        expect([text(codeItem, 0x00080100), text(codeItem, 0x00080102), text(codeItem, 0x00080104)]).toEqual(['T-D0050', 'SRT', 'Tissue']);
      }
    }
    expect(find(segments[0], 0x0062000d)?.value.length).toBe(6);
    expect(find(segments[2], 0x0062000d)).toBeUndefined();
    // Pure white is L = 100, a = b = 0: 65535 and the midpoint of the 16-bit range.
    const white = find(parse(written({ segments: [{ index: 1, name: 'w', color: [255, 255, 255] }] })), 0x00620002)?.items?.[0] ?? [];
    const lab = new Uint16Array((find(white, 0x0062000d) as Node).value.slice().buffer);
    expect(lab[0]).toBe(65535);
    expect(Math.abs(lab[1] - 32896)).toBeLessThanOrEqual(1);
    expect(Math.abs(lab[2] - 32896)).toBeLessThanOrEqual(1);
  });

  it('has shared geometry, a dimension index and decimal strings of at most 16 characters', () => {
    const nodes = parse(written());
    const shared = find(nodes, 0x52009229)?.items?.[0] ?? [];
    const orientation = text(find(shared, 0x00209116)?.items?.[0] ?? [], 0x00200037) ?? '';
    expect(orientation.split('\\')).toHaveLength(6);
    orientation.split('\\').forEach((v, n) => {
      expect(v.length).toBeLessThanOrEqual(16);
      expect(Number(v)).toBeCloseTo([1, 0, 0, 0, c, s][n], 12);
    });
    const measures = find(shared, 0x00289110)?.items?.[0] ?? [];
    expect(text(measures, 0x00280030)).toBe('0.9\\0.7'); // row spacing, then column spacing
    expect(text(measures, 0x00180088)).toBe('2.5');
    expect(find(nodes, 0x00209222)?.items).toHaveLength(2);
    expect(find(nodes, 0x00209221)?.items).toHaveLength(1);
  });

  it('without a source series makes up its own study, series and frame of reference and references nothing', () => {
    const a = parse(written());
    const b = parse(written());
    for (const tag of [0x0020000d, 0x0020000e, 0x00200052, 0x00080018]) {
      expect(text(a, tag)).toMatch(/^2\.25\.[1-9][0-9]{0,38}$/);
      expect(text(a, tag)).not.toBe(text(b, tag));
    }
    expect(find(a, 0x00081115)).toBeUndefined();
    expect(text(a, 0x00100010)).toBe('');
    expect(text(a, 0x00100020)).toBe('');
    expect(find(find(a, 0x52009230)?.items?.[0] ?? [], 0x00089124)).toBeUndefined();
  });

  it('with a source series joins its study and references the slice behind every frame', () => {
    const source: DicomSourceInfo = {
      studyInstanceUID: '1.2.3.1',
      seriesInstanceUID: '1.2.3.2',
      frameOfReferenceUID: '1.2.3.3',
      patientName: 'Phantom^Test',
      patientID: 'PH-1',
      patientBirthDate: '19700101',
      patientSex: 'O',
      studyDate: '20250102',
      studyTime: '101112',
      accessionNumber: 'ACC7',
      studyID: 'S1',
      instances: Array.from({ length: SLICES }, (_, k) => ({ sopClassUID: CT_CLASS, sopInstanceUID: `1.2.3.4.${k}` })),
    };
    const nodes = parse(written({ source }));
    expect(text(nodes, 0x0020000d)).toBe('1.2.3.1');
    expect(text(nodes, 0x0020000e)).toMatch(/^2\.25\./);
    expect(text(nodes, 0x00200052)).toBe('1.2.3.3');
    expect(text(nodes, 0x00100010)).toBe('Phantom^Test');
    expect(text(nodes, 0x00100020)).toBe('PH-1');
    expect(text(nodes, 0x00100030)).toBe('19700101');
    expect(text(nodes, 0x00100040)).toBe('O');
    expect(text(nodes, 0x00080020)).toBe('20250102');
    expect(text(nodes, 0x00080030)).toBe('101112');
    expect(text(nodes, 0x00080050)).toBe('ACC7');
    expect(text(nodes, 0x00200010)).toBe('S1');
    const series = find(nodes, 0x00081115)?.items?.[0] ?? [];
    expect(text(series, 0x0020000e)).toBe('1.2.3.2');
    expect((find(series, 0x0008114a)?.items ?? []).map((item) => text(item, 0x00081155))).toEqual(source.instances.map((r) => r.sopInstanceUID));
    // Frames are segment 1 on slices 1, 2, 4, then segment 2 on 1, 2, then segment 5 on 2, 4.
    const referenced = (find(nodes, 0x52009230)?.items ?? []).map((frame) => {
      const sourceImage = find(find(frame, 0x00089124)?.items?.[0] ?? [], 0x00082112)?.items?.[0] ?? [];
      expect(text(sourceImage, 0x00081150)).toBe(CT_CLASS);
      return text(sourceImage, 0x00081155);
    });
    expect(referenced).toEqual([1, 2, 4, 1, 2, 2, 4].map((k) => `1.2.3.4.${k}`));
  });

  it('writes Latin-1 patient names from the source as UTF-8', () => {
    const source: DicomSourceInfo = { studyInstanceUID: '1.2', seriesInstanceUID: '1.3', specificCharacterSet: 'ISO_IR 100', patientName: 'Müller^Jörg', instances: [] };
    const nodes = parse(written({ source }));
    expect(text(nodes, 0x00080005)).toBe('ISO_IR 192');
    expect(text(nodes, 0x00100010)).toBe('Müller^Jörg');
  });
});

// ---- segmentations built by hand, as other software writes them ----

interface HandFrame {
  segment: number;
  position: number[];
  /** Pixels that are set, as indices into the frame. */
  on: number[];
}
interface HandOpts {
  frames: HandFrame[];
  rows?: number;
  cols?: number;
  type?: string;
  spacingBetweenSlices?: number;
  orientation?: number[];
  segments?: [number, string][];
  /** Put the segment number in the shared functional groups instead of per frame. */
  sharedSegment?: boolean;
  transferSyntax?: string;
}

function packBits(frames: HandFrame[], frameSize: number): Uint8Array {
  let bits = '';
  for (const f of frames) for (let i = 0; i < frameSize; i++) bits += f.on.includes(i) ? '1' : '0';
  const out = new Uint8Array(Math.ceil(bits.length / 8) + (Math.ceil(bits.length / 8) % 2));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') out[Math.floor(i / 8)] += 2 ** (i % 8);
  return out;
}

function handSeg(o: HandOpts): Uint8Array {
  const rows = o.rows ?? ROWS;
  const cols = o.cols ?? COLS;
  const fractional = o.type === 'FRACTIONAL';
  const measures = [dcmEl(0x00280030, 'DS', '0.9\\0.7')];
  if (o.spacingBetweenSlices) measures.unshift(dcmEl(0x00180088, 'DS', String(o.spacingBetweenSlices)));
  const shared = [
    dcmSeq(0x00209116, [dcmEl(0x00200037, 'DS', (o.orientation ?? [1, 0, 0, 0, 1, 0]).join('\\'))]),
    dcmSeq(0x00289110, [concat(...measures)]),
  ];
  if (o.sharedSegment) shared.push(dcmSeq(0x0062000a, [dcmEl(0x0062000b, 'US', us(o.frames[0].segment))]));
  const perFrame = o.frames.map((f) =>
    concat(
      dcmSeq(0x00209113, [dcmEl(0x00200032, 'DS', f.position.join('\\'))]),
      ...(o.sharedSegment ? [] : [dcmSeq(0x0062000a, [dcmEl(0x0062000b, 'US', us(f.segment))])]),
    ),
  );
  const pixels = fractional
    ? Uint8Array.from(o.frames.flatMap((f) => Array.from({ length: rows * cols }, (_, i) => (f.on.includes(i) ? 40 + i : 0))).concat(rows * cols * o.frames.length % 2 ? [0] : []))
    : packBits(o.frames, rows * cols);
  const dataset = concat(
    dcmEl(0x00080016, 'UI', SEG_CLASS),
    dcmEl(0x00080060, 'CS', 'SEG'),
    dcmEl(0x0008103e, 'LO', 'Hand made'),
    dcmEl(0x00280002, 'US', us(1)),
    dcmEl(0x00280008, 'IS', String(o.frames.length)),
    dcmEl(0x00280010, 'US', us(rows)),
    dcmEl(0x00280011, 'US', us(cols)),
    dcmEl(0x00280100, 'US', us(fractional ? 8 : 1)),
    dcmEl(0x00620001, 'CS', o.type ?? 'BINARY'),
    dcmSeq(
      0x00620002,
      (o.segments ?? [[1, 'One'], [2, 'Two']]).map(([n, label]) =>
        concat(dcmSeq(0x00620003, [dcmEl(0x00080100, 'SH', 'T-D0050')]), dcmEl(0x00620004, 'US', us(n)), dcmEl(0x00620005, 'LO', label)),
      ),
    ),
    dcmSeq(0x52009229, [concat(...shared)]),
    dcmSeq(0x52009230, perFrame),
    dcmEl(0x7fe00010, 'OB', pixels),
  );
  return dcmFile(o.transferSyntax ?? TS_EXPLICIT, dataset);
}

/** The labelmap the frames describe, for slices `first..` at 2 mm steps along z from z = 10. */
function expectedVolume(frames: HandFrame[], slices: number): number[] {
  const out = new Array<number>(COLS * ROWS * slices).fill(0);
  for (const f of [...frames].sort((a, b) => a.segment - b.segment)) {
    const k = Math.round((f.position[2] - 10) / 2);
    for (const i of f.on) out[k * COLS * ROWS + i] = f.segment;
  }
  return out;
}

describe('readDicomSeg with files from other software', () => {
  // Frames out of order, on slices z = 10, 12 and 16 only (14 is absent), two segments.
  const frames: HandFrame[] = [
    { segment: 2, position: [1, 2, 16], on: [0, 7, 14] },
    { segment: 1, position: [1, 2, 12], on: [1, 2, 3, 8] },
    { segment: 1, position: [1, 2, 10], on: [14] },
    { segment: 2, position: [1, 2, 12], on: [13] },
    { segment: 1, position: [1, 2, 16], on: [4, 9] },
  ];

  it('unpacks bits that cross frame boundaries and places frames given in any order', () => {
    const v = readDicomSeg(file(handSeg({ frames, spacingBetweenSlices: 2 })));
    expect(v.name).toBe('Hand made');
    expect(v.dims).toEqual([COLS, ROWS, 4]);
    expect(v.spacing).toEqual([0.7, 0.9, 2]);
    expect(v.origin).toEqual([1, 2, 10]);
    expect(v.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(v.data)).toEqual(expectedVolume(frames, 4));
    expect(v.labels).toEqual({ 1: 'One', 2: 'Two' });
    expect(v.warnings).toBeUndefined();
  });

  it('leaves slices without a frame empty', () => {
    const v = readDicomSeg(file(handSeg({ frames, spacingBetweenSlices: 2 })));
    expect(Array.from(v.data.subarray(2 * COLS * ROWS, 3 * COLS * ROWS)).every((x) => x === 0)).toBe(true);
  });

  it('reads implicit VR little endian', () => {
    const explicit = handSeg({ frames, spacingBetweenSlices: 2 });
    // Rebuild the same data set with implicit headers through the image reader's own helper.
    const implicit = (tag: number, vr: string, value: Uint8Array | string) => dcmEl(tag, vr, value, false);
    const ds = concat(
      implicit(0x00080016, 'UI', SEG_CLASS),
      implicit(0x00280008, 'IS', '2'),
      implicit(0x00280010, 'US', us(ROWS)),
      implicit(0x00280011, 'US', us(COLS)),
      implicit(0x00280100, 'US', us(1)),
      implicit(0x00620001, 'CS', 'BINARY'),
      dcmSeq(0x00620002, [concat(implicit(0x00620004, 'US', us(3)), implicit(0x00620005, 'LO', 'Three'))], false),
      dcmSeq(0x52009229, [concat(dcmSeq(0x00209116, [implicit(0x00200037, 'DS', '1\\0\\0\\0\\1\\0')], false), dcmSeq(0x00289110, [implicit(0x00280030, 'DS', '0.9\\0.7')], false))], false),
      dcmSeq(0x52009230, [10, 12].map((z) => concat(dcmSeq(0x00209113, [implicit(0x00200032, 'DS', `1\\2\\${z}`)], false), dcmSeq(0x0062000a, [implicit(0x0062000b, 'US', us(3))], false))), false),
      implicit(0x7fe00010, 'OW', packBits([{ segment: 3, position: [], on: [14] }, { segment: 3, position: [], on: [0] }], 15)),
    );
    const v = readDicomSeg(file(dcmFile('1.2.840.10008.1.2', ds)));
    expect(explicit.length).toBeGreaterThan(0);
    expect(v.dims).toEqual([COLS, ROWS, 2]);
    expect(v.labels).toEqual({ 3: 'Three' });
    const want = new Array<number>(30).fill(0);
    want[14] = 3;
    want[15] = 3;
    expect(Array.from(v.data)).toEqual(want);
  });

  it('keeps the higher segment number where segments overlap, and says so', () => {
    const overlapping: HandFrame[] = [
      { segment: 2, position: [1, 2, 10], on: [3, 4] },
      { segment: 1, position: [1, 2, 10], on: [4, 5] },
    ];
    const v = readDicomSeg(file(handSeg({ frames: overlapping, spacingBetweenSlices: 2 })));
    expect(Array.from(v.data.subarray(3, 6))).toEqual([2, 2, 1]);
    expect(v.warnings).toEqual(['Some segments overlap. Where they do, the segment with the higher number was kept.']);
  });

  it('takes fractional values above zero as inside, and says so', () => {
    const v = readDicomSeg(file(handSeg({ frames, type: 'FRACTIONAL', spacingBetweenSlices: 2 })));
    expect(Array.from(v.data)).toEqual(expectedVolume(frames, 4));
    expect(v.warnings).toEqual(['This segmentation stores fractional values. Every voxel above zero was taken as part of its segment.']);
  });

  it('takes the segment number from the shared groups of a single-segment file', () => {
    const one: HandFrame[] = [
      { segment: 2, position: [1, 2, 12], on: [1] },
      { segment: 2, position: [1, 2, 10], on: [0] },
    ];
    const v = readDicomSeg(file(handSeg({ frames: one, sharedSegment: true })));
    expect(v.data[0]).toBe(2);
    expect(v.data[COLS * ROWS + 1]).toBe(2);
  });

  it('works out the slice spacing from the frames when the file does not state it', () => {
    const v = readDicomSeg(file(handSeg({ frames })));
    expect(v.spacing[2]).toBe(2);
    expect(v.dims[2]).toBe(4);
  });

  it('uses the reference image for the slice spacing of sparse frames', () => {
    // Frames 4 mm apart only: on their own they look like a 4 mm stack.
    const sparse: HandFrame[] = [
      { segment: 1, position: [1, 2, 10], on: [0] },
      { segment: 1, position: [1, 2, 14], on: [1] },
    ];
    const bytes = handSeg({ frames: sparse });
    expect(readDicomSeg(file(bytes)).dims[2]).toBe(2);
    const reference: VolumeData = { name: 'ct', dims: [8, 8, 9], spacing: [0.7, 0.9, 2], origin: [1, 2, 4], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: new Int16Array(8 * 8 * 9) };
    const v = readDicomSeg(file(bytes), reference);
    expect(v.spacing[2]).toBe(2);
    expect(v.dims[2]).toBe(3);
    expect(v.data[0]).toBe(1);
    expect(v.data[2 * COLS * ROWS + 1]).toBe(1);
  });

  it('reads an oblique segmentation, ordering slices along the plane normal', () => {
    // Normal is (0, -s, c). Three frames 3 mm apart, given last first.
    const at = (k: number) => [5, 6 - 3 * k * s, 7 + 3 * k * c];
    const oblique: HandFrame[] = [2, 0, 1].map((k) => ({ segment: 1, position: at(k), on: [k] }));
    const v = readDicomSeg(file(handSeg({ frames: oblique, orientation: [1, 0, 0, 0, c, s] })));
    expect(v.dims).toEqual([COLS, ROWS, 3]);
    v.origin.forEach((x, n) => expect(x).toBeCloseTo(at(0)[n], 9));
    v.spacing.forEach((x, n) => expect(x).toBeCloseTo([0.7, 0.9, 3][n], 9));
    v.direction.forEach((x, n) => expect(x).toBeCloseTo([1, 0, 0, 0, c, s, 0, -s, c][n], 9));
    for (let k = 0; k < 3; k++) expect(v.data[k * COLS * ROWS + k]).toBe(1);
  });

  it('reads its own file by the standard attributes alone when the private grid is not there', () => {
    const mask = obliqueMask();
    const bytes = writeDicomSeg(mask, { segments: SEGMENTS });
    // Rename the private creator in place: the block no longer belongs to this app.
    const at = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 11)) === 'W ANNOTATOR');
    const stripped = bytes.slice();
    stripped.set(ascii('X'), at);
    const v = readDicomSeg(file(stripped));
    // Only slices 1..4 hold frames, so the grid starts at slice 1.
    expect(v.dims).toEqual([COLS, ROWS, 4]);
    v.spacing.forEach((x, n) => expect(x).toBeCloseTo(mask.spacing[n], 9));
    v.direction.forEach((x, n) => expect(x).toBeCloseTo(mask.direction[n], 9));
    [-12.3, 45.6 - 2.5 * s, -78.9 + 2.5 * c].forEach((x, n) => expect(v.origin[n]).toBeCloseTo(x, 9));
    expect(Array.from(v.data)).toEqual(Array.from(mask.data.subarray(COLS * ROWS, 5 * COLS * ROWS)));
  });

  it('explains what it cannot read', () => {
    expect(() => readDicomSeg(file(dcmSlice({ rows: 1, cols: 1, pixels: us(1) })))).toThrow('This file is not a DICOM segmentation.');
    expect(() => readDicomSeg(file(ascii('hello')))).toThrow('This file is not a DICOM segmentation.');
    expect(() => readDicomSeg(file(handSeg({ frames, type: 'LABELMAP' })))).toThrow('DICOM segmentations of type "LABELMAP" are not supported.');
    expect(() => readDicomSeg(file(handSeg({ frames, transferSyntax: '1.2.840.10008.1.2.5' })))).toThrow(/compressed/);
    const uneven = [...frames, { segment: 1, position: [1, 2, 13.1], on: [0] }];
    expect(() => readDicomSeg(file(handSeg({ frames: uneven })))).toThrow(/unevenly spaced/);
    const whole = handSeg({ frames, spacingBetweenSlices: 2 });
    expect(() => readDicomSeg(file(whole.subarray(0, whole.length - 6)))).toThrow(/incomplete or damaged/);
  });
});

describe('isDicomSeg', () => {
  it('recognises a segmentation by its SOP class, with or without a file meta group', () => {
    const written = writeDicomSeg(obliqueMask(), { segments: SEGMENTS });
    expect(isDicomSeg(file(written))).toBe(true);
    const bare = handSeg({ frames: [{ segment: 1, position: [0, 0, 0], on: [0] }] });
    expect(isDicomSeg(file(bare))).toBe(true);
    expect(isDicomSeg(file(bare.subarray(dcmFile(TS_EXPLICIT, new Uint8Array(0)).length)))).toBe(true);
  });
  it('says no to images and to files that are not DICOM', () => {
    expect(isDicomSeg(file(dcmSlice({ rows: 1, cols: 1, pixels: us(1) })))).toBe(false);
    expect(isDicomSeg(file(ascii('not dicom at all, just some text')))).toBe(false);
    expect(isDicomSeg(file(new Uint8Array(0)))).toBe(false);
  });
});

describe('DICOM SEG through readVolume, readVolumeAsync and writeMask', () => {
  const ctSlice = (k: number, extra: Uint8Array[] = []) => ({
    name: `CT${k}`,
    bytes: dcmSlice({
      rows: ROWS,
      cols: COLS,
      pixels: encode(Array.from({ length: COLS * ROWS }, (_, p) => p + 100 * k), 'uint16'),
      position: [-12.3, 45.6, -78.9 + 2.5 * k],
      orientation: [1, 0, 0, 0, 1, 0],
      pixelSpacing: [0.9, 0.7],
      series: '1.2.3.2',
      instance: k + 1,
      extra,
    }),
  });

  it('opens a segmentation file on its own as a labelmap', async () => {
    const mask = obliqueMask();
    const bytes = writeDicomSeg(mask, { segments: SEGMENTS });
    const sync = readVolume([file(bytes, 'mask')]);
    expect(Array.from(sync.data)).toEqual(Array.from(mask.data));
    expect(sync.labels).toEqual({ 1: 'Liver', 2: 'Tumour', 5: 'Vessel' });
    expect(await readVolumeAsync([file(bytes, 'mask')])).toEqual(sync);
  });

  it('opens the image when a segmentation is picked together with its series', () => {
    const seg = file(writeDicomSeg({ ...obliqueMask(), direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { segments: SEGMENTS }));
    const v = readVolume([seg, ctSlice(1), ctSlice(0)]);
    expect(v.dims).toEqual([COLS, ROWS, 2]);
    expect(v.data).toBeInstanceOf(Uint16Array);
    expect(v.data[COLS * ROWS]).toBe(100);
  });

  it('writeMask writes a segmentation from the labels and colours of the mask', () => {
    const mask: VolumeData = { ...obliqueMask(), labels: { 1: 'Liver', 2: 'Tumour' }, colors: { 2: [1, 2, 3] } };
    const back = readVolume([file(writeMask(mask, 'dcm'))]);
    expect(back.labels).toEqual({ 1: 'Liver', 2: 'Tumour', 5: 'Segment 5' });
    expect(back.colors).toEqual({ 2: [1, 2, 3] });
    expect(Array.from(back.data)).toEqual(Array.from(mask.data));
  });

  it('writeMask still writes the other formats', () => {
    const mask = obliqueMask();
    const back = readVolume([{ name: 'm.nrrd', bytes: writeMask(mask, 'nrrd') }]);
    expect(Array.from(back.data)).toEqual(Array.from(mask.data));
  });

  it('a segmentation read back lands on the right voxels of a reference image with another grid', () => {
    // The mask covers part of a larger, finer image: in-plane the image has twice the resolution and an offset.
    const mask: VolumeData = { ...obliqueMask(), direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 2], origin: [10, 20, 30] };
    const seg = readDicomSeg(file(writeDicomSeg(mask, { segments: SEGMENTS })));
    const image: VolumeData = {
      name: 'ct',
      dims: [14, 10, 8],
      spacing: [0.5, 0.5, 2],
      origin: [9.75, 19.75, 28],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      data: new Int16Array(14 * 10 * 8),
    };
    const placed = resampleNearest(seg, image);
    expect(placed.dims).toEqual(image.dims);
    expect(placed.labels).toEqual(seg.labels);
    expect(placed.colors).toEqual(seg.colors);
    // Image voxel (i, j, k) is at world (9.75 + i/2, 19.75 + j/2, 28 + 2k): mask voxel (floor(i/2), floor(j/2), k - 1).
    let checked = 0;
    for (let k = 0; k < 8; k++) {
      for (let j = 0; j < 10; j++) {
        for (let i = 0; i < 14; i++) {
          const mi = Math.floor(i / 2);
          const mj = Math.floor(j / 2);
          const mk = k - 1;
          const inside = mi < COLS && mj < ROWS && mk >= 0 && mk < SLICES;
          const want = inside ? mask.data[mi + mj * COLS + mk * COLS * ROWS] : 0;
          expect(placed.data[i + j * 14 + k * 140]).toBe(want);
          if (want) checked++;
        }
      }
    }
    expect(checked).toBe(9 * 4);
  });

  it('the series reader collects what a segmentation must reference, in slice order', () => {
    const uids = (k: number) => [
      dcmEl(0x00080016, 'UI', CT_CLASS),
      dcmEl(0x00080018, 'UI', `1.2.3.4.${k}`),
      dcmEl(0x00080020, 'DA', '20250102'),
      dcmEl(0x00080050, 'SH', 'ACC7'),
      dcmEl(0x00100010, 'PN', 'Phantom^Test'),
      dcmEl(0x00100020, 'LO', 'PH-1'),
      dcmEl(0x0020000d, 'UI', '1.2.3.1'),
      dcmEl(0x00200052, 'UI', '1.2.3.3'),
    ];
    const v = readVolume([2, 0, 1].map((k) => ctSlice(k, uids(k))));
    expect(v.dicom).toEqual({
      studyInstanceUID: '1.2.3.1',
      seriesInstanceUID: '1.2.3.2',
      frameOfReferenceUID: '1.2.3.3',
      studyDate: '20250102',
      accessionNumber: 'ACC7',
      patientName: 'Phantom^Test',
      patientID: 'PH-1',
      instances: [0, 1, 2].map((k) => ({ sopClassUID: CT_CLASS, sopInstanceUID: `1.2.3.4.${k}` })),
    });
    // And it goes straight back into a segmentation of that image.
    const mask: VolumeData = { ...v, name: 'mask', data: new Uint8Array(v.data.length).fill(0, 0), dicom: undefined };
    mask.data[COLS * ROWS * 2] = 1;
    const nodes = parse(writeMask(mask, 'dcm', { source: v.dicom }));
    expect(text(nodes, 0x0020000d)).toBe('1.2.3.1');
    const frame = find(nodes, 0x52009230)?.items?.[0] ?? [];
    const sourceImage = find(find(frame, 0x00089124)?.items?.[0] ?? [], 0x00082112)?.items?.[0] ?? [];
    expect(text(sourceImage, 0x00081155)).toBe('1.2.3.4.2');
  });

  it('gives each frame of a multi-frame source its frame number', () => {
    const ds = concat(
      dcmEl(0x00080016, 'UI', '1.2.840.10008.5.1.4.1.1.2.1'),
      dcmEl(0x00080018, 'UI', '1.2.3.9'),
      dcmEl(0x00180088, 'DS', '2.5'),
      dcmEl(0x0020000d, 'UI', '1.2.3.1'),
      dcmEl(0x0020000e, 'UI', '1.2.3.2'),
      dcmEl(0x00200032, 'DS', '0\\0\\0'),
      dcmEl(0x00200037, 'DS', '1\\0\\0\\0\\1\\0'),
      dcmEl(0x00280002, 'US', us(1)),
      dcmEl(0x00280008, 'IS', '2'),
      dcmEl(0x00280010, 'US', us(1)),
      dcmEl(0x00280011, 'US', us(2)),
      dcmEl(0x00280100, 'US', us(16)),
      dcmEl(0x7fe00010, 'OW', encode([1, 2, 3, 4], 'uint16')),
    );
    const v = readVolume([{ name: 'mf.dcm', bytes: dcmFile(TS_EXPLICIT, ds) }]);
    expect(v.dicom?.instances).toEqual([
      { sopClassUID: '1.2.840.10008.5.1.4.1.1.2.1', sopInstanceUID: '1.2.3.9', frame: 1 },
      { sopClassUID: '1.2.840.10008.5.1.4.1.1.2.1', sopInstanceUID: '1.2.3.9', frame: 2 },
    ]);
  });

  it('leaves the source out when slices cannot be identified', () => {
    expect(readVolume([ctSlice(0), ctSlice(1)]).dicom).toBeUndefined();
  });
});
