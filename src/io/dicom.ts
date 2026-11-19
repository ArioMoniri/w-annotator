import { inflateSync } from 'fflate';
import { baseName } from './names';
import type { DicomSourceInfo, InputFile, ScalarArray, VolumeData } from './types';
import { HOST_LE, IoError, concatBytes, geometryFromSteps, latin1, swapBytes, voxelCount } from './util';

const DAMAGED = 'This DICOM file is incomplete or damaged.';
const UNDEFINED_LENGTH = 0xffffffff;
const PIXEL_DATA = 0x7fe00010;
const ITEM = 0xfffee000;
const SEQUENCE_END = 0xfffee0dd;

/** VRs whose explicit header has a 4-byte length. */
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV']);

// Functional group sequences of enhanced multi-frame images: the only sequences whose content is kept.
const SHARED_GROUPS = 0x52009229;
const PER_FRAME_GROUPS = 0x52009230;
const PLANE_POSITION = 0x00209113;
const PLANE_ORIENTATION = 0x00209116;
const PIXEL_MEASURES = 0x00289110;
const PIXEL_TRANSFORM = 0x00289145;
const SEGMENTS = 0x00620002;
const SEGMENT_IDENTIFICATION = 0x0062000a;
const KEPT_SEQUENCES = new Set([
  SHARED_GROUPS,
  PER_FRAME_GROUPS,
  PLANE_POSITION,
  PLANE_ORIENTATION,
  PIXEL_MEASURES,
  PIXEL_TRANSFORM,
  SEGMENTS,
  SEGMENT_IDENTIFICATION,
]);

export const SEG_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.4';

/** Transfer syntaxes with encapsulated pixel data that `readDicomAsync` can decode. */
const COMPRESSED = new Set([
  '1.2.840.10008.1.2.5', // RLE Lossless
  '1.2.840.10008.1.2.4.50', // JPEG Baseline, 8-bit
  '1.2.840.10008.1.2.4.57', // JPEG Lossless
  '1.2.840.10008.1.2.4.70', // JPEG Lossless, first-order prediction
  '1.2.840.10008.1.2.4.80', // JPEG-LS Lossless
  '1.2.840.10008.1.2.4.81', // JPEG-LS Near-lossless
  '1.2.840.10008.1.2.4.90', // JPEG 2000 Lossless
  '1.2.840.10008.1.2.4.91', // JPEG 2000
  '1.2.840.10008.1.2.4.201', // HTJ2K Lossless
  '1.2.840.10008.1.2.4.202', // HTJ2K Lossless, RPCL
  '1.2.840.10008.1.2.4.203', // HTJ2K
]);

/** What a decoder is told about the frame it decodes. */
export interface FrameSpec {
  rows: number;
  cols: number;
  bitsAllocated: number;
  bitsStored: number;
  signed: boolean;
  transferSyntax: string;
}

/**
 * Decodes one compressed frame into little-endian pixel bytes, row by row:
 * `rows * cols * bitsAllocated / 8` of them. The result must be a copy the caller may keep.
 */
export type FrameDecoder = (encoded: Uint8Array, frame: FrameSpec) => Uint8Array | Promise<Uint8Array>;

/** Gets the decoder for a transfer syntax UID, loading its code on first use. */
export type CodecLoader = (transferSyntax: string) => Promise<FrameDecoder>;

export interface Element {
  off: number;
  len: number;
  items?: DataSet[];
}
export type DataSet = Map<number, Element>;

export class Parser {
  private readonly dv: DataView;

  constructor(
    readonly b: Uint8Array,
    private readonly explicit: boolean,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  private tag(pos: number): number {
    return this.dv.getUint16(pos, true) * 0x10000 + this.dv.getUint16(pos + 2, true);
  }

  /**
   * Reads elements from `pos` into `out` until `end`, an item delimiter or (at
   * the top level) the pixel data. Returns the position after what was read.
   */
  parse(pos: number, end: number, out: DataSet, top: boolean): number {
    const { b, dv } = this;
    while (pos + 8 <= end) {
      const tag = this.tag(pos);
      if (tag >= 0xfffe0000 && tag < 0xffff0000) return pos + 8; // item or sequence delimiter
      let vr = '';
      let len: number;
      let off: number;
      if (this.explicit) {
        vr = String.fromCharCode(b[pos + 4], b[pos + 5]);
        if (LONG_VRS.has(vr)) {
          len = dv.getUint32(pos + 8, true);
          off = pos + 12;
        } else {
          len = dv.getUint16(pos + 6, true);
          off = pos + 8;
        }
      } else {
        len = dv.getUint32(pos + 4, true);
        off = pos + 8;
      }
      if (top && tag === PIXEL_DATA) {
        if (len !== UNDEFINED_LENGTH && off + len > b.length) throw new IoError(DAMAGED);
        out.set(tag, { off, len });
        return end;
      }
      const kept = KEPT_SEQUENCES.has(tag);
      if (len === UNDEFINED_LENGTH || (kept && (vr === 'SQ' || !this.explicit))) {
        // A sequence. Undefined-length ones must be walked to find their end.
        const seqEnd = len === UNDEFINED_LENGTH ? end : off + len;
        if (seqEnd > b.length) throw new IoError(DAMAGED);
        const items: DataSet[] = [];
        let p = off;
        while (p + 8 <= seqEnd) {
          const itemTag = this.tag(p);
          const itemLen = dv.getUint32(p + 4, true);
          p += 8;
          if (itemTag === SEQUENCE_END) break;
          if (itemTag !== ITEM) throw new IoError(DAMAGED);
          const item: DataSet = new Map();
          if (itemLen === UNDEFINED_LENGTH) p = this.parse(p, seqEnd, item, false);
          else {
            if (p + itemLen > seqEnd) throw new IoError(DAMAGED);
            this.parse(p, p + itemLen, item, false);
            p += itemLen;
          }
          items.push(item);
        }
        if (kept) out.set(tag, { off, len: 0, items });
        pos = len === UNDEFINED_LENGTH ? p : seqEnd;
        continue;
      }
      if (off + len > end) throw new IoError(DAMAGED);
      out.set(tag, { off, len });
      pos = off + len;
    }
    return end;
  }

  text(e: Element | undefined): string {
    return e ? latin1(this.b, e.off, e.off + e.len).replace(/[\0\s]+$/, '').trim() : '';
  }

  /** A backslash-separated list of decimal strings (VR DS or IS). */
  numbers(e: Element | undefined, count: number): number[] | undefined {
    if (!e) return undefined;
    const v = this.text(e).split('\\').map(Number);
    return v.length >= count && v.every(Number.isFinite) ? v : undefined;
  }

  number(e: Element | undefined): number | undefined {
    return this.numbers(e, 1)?.[0];
  }

  u16(e: Element | undefined): number | undefined {
    return e && e.len >= 2 ? this.dv.getUint16(e.off, true) : undefined;
  }
}

interface Slice {
  /** Little-endian pixel bytes. Empty until decoded when `encoded` is set. */
  pixels: Uint8Array;
  /** The compressed frame, for encapsulated transfer syntaxes. */
  encoded?: Uint8Array;
  sopClass: string;
  sopInstance: string;
  /** 1-based frame number inside a multi-frame file. */
  frame?: number;
  position: number[] | null;
  /** Instance number, then frame number: the order used when positions are missing. */
  order: number;
  slope: number;
  intercept: number;
}

interface Image {
  rows: number;
  cols: number;
  bits: number;
  bitsStored: number;
  signed: boolean;
  /** Set when the pixel data is compressed. */
  transferSyntax?: string;
  source: Omit<DicomSourceInfo, 'instances'>;
  series: string;
  description: string;
  fileName: string;
  orientation: number[] | undefined;
  pixelSpacing: number[] | undefined;
  /** Distance between slices as stated in the header; used when positions cannot tell. */
  statedGap: number | undefined;
  slices: Slice[];
}

export const cross = (r: number[]) => [r[1] * r[5] - r[2] * r[4], r[2] * r[3] - r[0] * r[5], r[0] * r[4] - r[1] * r[3]];

function hasPreamble(b: Uint8Array): boolean {
  return b.length >= 132 && b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d;
}

/** Whether the bytes look like DICOM: the DICM marker, or a bare data set starting in group 2 or 8. */
export function isDicom(b: Uint8Array): boolean {
  if (hasPreamble(b)) return true;
  if (b.length < 16) return false;
  const group = b[0] | (b[1] << 8);
  return (group === 0x0002 || group === 0x0008) && b[3] === 0;
}

const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;

export interface OpenedDicom {
  p: Parser;
  ds: DataSet;
  /** From the file meta group; undefined for a bare data set. */
  transferSyntax: string | undefined;
  /** True when the pixel data is encapsulated in a syntax that can be decoded. */
  compressed: boolean;
}

/** Reads the file meta group. Returns where the data set starts. */
function readMeta(b: Uint8Array): { pos: number; transferSyntax?: string; sopClass?: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = hasPreamble(b) ? 132 : 0;
  let transferSyntax: string | undefined;
  let sopClass: string | undefined;
  // File meta group (0002): always explicit VR little endian.
  while (pos + 8 <= b.length && dv.getUint16(pos, true) === 0x0002) {
    const long = LONG_VRS.has(String.fromCharCode(b[pos + 4], b[pos + 5]));
    const len = long ? dv.getUint32(pos + 8, true) : dv.getUint16(pos + 6, true);
    const off = pos + (long ? 12 : 8);
    if (off + len > b.length) throw new IoError(DAMAGED);
    const element = dv.getUint16(pos + 2, true);
    if (element === 0x0010) transferSyntax = latin1(b, off, off + len).replace(/[\0\s]+$/, '');
    else if (element === 0x0002) sopClass = latin1(b, off, off + len).replace(/[\0\s]+$/, '');
    pos = off + len;
  }
  return { pos, transferSyntax, sopClass };
}

/** Parses the data set of one file. Returns null for a file that is not DICOM. */
export function openDicom(bytes: Uint8Array): OpenedDicom | null {
  let b = bytes;
  if (!isDicom(b)) return null;
  const meta = readMeta(b);
  const { transferSyntax } = meta;
  let { pos } = meta;

  let explicit: boolean;
  let compressed = false;
  if (transferSyntax === undefined) explicit = pos + 6 <= b.length && isUpper(b[pos + 4]) && isUpper(b[pos + 5]);
  else if (transferSyntax === '1.2.840.10008.1.2') explicit = false;
  else if (transferSyntax === '1.2.840.10008.1.2.1') explicit = true;
  else if (transferSyntax === '1.2.840.10008.1.2.1.99') {
    explicit = true;
    try {
      b = inflateSync(b.subarray(pos));
    } catch {
      throw new IoError(DAMAGED);
    }
    pos = 0;
  } else if (transferSyntax === '1.2.840.10008.1.2.2') {
    throw new IoError('Big-endian DICOM is not supported. Convert the series to NIfTI first.');
  } else if (COMPRESSED.has(transferSyntax)) {
    explicit = true;
    compressed = true;
  } else {
    throw new IoError(
      `This DICOM file uses a compression that cannot be opened (${transferSyntax}). Convert the series to NIfTI first.`,
    );
  }

  const p = new Parser(b, explicit);
  const ds: DataSet = new Map();
  try {
    p.parse(pos, b.length, ds, true);
  } catch (e) {
    if (e instanceof IoError) throw e;
    throw new IoError(DAMAGED);
  }
  return { p, ds, transferSyntax, compressed };
}

/** Whether the file is a DICOM Segmentation object, judged by its SOP class. */
export function hasSegSopClass(bytes: Uint8Array): boolean {
  if (!isDicom(bytes)) return false;
  try {
    const meta = readMeta(bytes);
    if (meta.sopClass !== undefined) return meta.sopClass === SEG_SOP_CLASS;
    const opened = openDicom(bytes);
    return opened !== null && opened.p.text(opened.ds.get(0x00080016)) === SEG_SOP_CLASS;
  } catch {
    return false;
  }
}

/**
 * Splits encapsulated pixel data, starting at its first item, into one byte
 * string per frame: the fragments of a frame are found through the basic
 * offset table, or by the end-of-image marker when the table is empty.
 */
function encapsulatedFrames(b: Uint8Array, start: number, frames: number): Uint8Array[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tagAt = (pos: number) => dv.getUint16(pos, true) * 0x10000 + dv.getUint16(pos + 2, true);
  if (start + 8 > b.length || tagAt(start) !== ITEM) throw new IoError(DAMAGED);
  const tableLength = dv.getUint32(start + 4, true);
  if (start + 8 + tableLength > b.length) throw new IoError(DAMAGED);
  const table: number[] = [];
  for (let o = 0; o + 4 <= tableLength; o += 4) table.push(dv.getUint32(start + 8 + o, true));

  const first = start + 8 + tableLength;
  const fragments: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = first;
  while (pos + 8 <= b.length) {
    const tag = tagAt(pos);
    if (tag === SEQUENCE_END) break;
    const len = dv.getUint32(pos + 4, true);
    if (tag !== ITEM || pos + 8 + len > b.length) throw new IoError(DAMAGED);
    offsets.push(pos - first);
    fragments.push(b.subarray(pos + 8, pos + 8 + len));
    pos += 8 + len;
  }

  const join = (from: number, to: number) => (to - from === 1 ? fragments[from] : concatBytes(fragments.slice(from, to)));
  if (fragments.length < frames) throw new IoError(DAMAGED);
  if (frames === 1) return [join(0, fragments.length)];
  if (fragments.length === frames) return fragments;

  if (table.length === frames) {
    // Each table entry is the offset of the item that starts a frame, counted from the first fragment's item.
    const starts = table.map((o) => offsets.indexOf(o));
    if (starts[0] === 0 && starts.every((s, f) => s >= 0 && (f === 0 || s > starts[f - 1]))) {
      return starts.map((s, f) => join(s, f + 1 < frames ? starts[f + 1] : fragments.length));
    }
  }
  // No usable table: a frame ends with the fragment that ends in an end-of-image marker (FF D9, perhaps padded).
  const out: Uint8Array[] = [];
  let from = 0;
  fragments.forEach((f, n) => {
    const e = f.length;
    const ends = e >= 2 && ((f[e - 2] === 0xff && f[e - 1] === 0xd9) || (e >= 3 && f[e - 3] === 0xff && f[e - 2] === 0xd9 && f[e - 1] === 0));
    if (ends) {
      out.push(join(from, n + 1));
      from = n + 1;
    }
  });
  if (out.length !== frames || from !== fragments.length) throw new IoError(DAMAGED);
  return out;
}

/** Parses one file. Returns null for a file that is not DICOM, 'no-image' for DICOM without an image to show. */
function parseFile(file: InputFile): Image | 'no-image' | null {
  const opened = openDicom(file.bytes);
  if (!opened) return null;
  const { p, ds } = opened;
  const b = p.b;
  const pixel = ds.get(PIXEL_DATA);
  const rows = p.u16(ds.get(0x00280010));
  const cols = p.u16(ds.get(0x00280011));
  if (!pixel || !rows || !cols) return 'no-image';
  const sopClass = p.text(ds.get(0x00080016));
  // A segmentation picked together with its image series is not one of the image's slices.
  if (sopClass === SEG_SOP_CLASS) return 'no-image';
  if ((p.u16(ds.get(0x00280002)) ?? 1) !== 1) throw new IoError('Colour DICOM images are not supported.');
  const bits = p.u16(ds.get(0x00280100)) ?? 16;
  if (bits !== 8 && bits !== 16 && bits !== 32) {
    throw new IoError(`DICOM images with ${bits} bits per pixel are not supported.`);
  }
  const frames = Math.max(1, Math.floor(p.number(ds.get(0x00280008)) ?? 1));
  const frameBytes = rows * cols * (bits / 8);
  let encoded: Uint8Array[] | undefined;
  if (opened.compressed) {
    // Encapsulated: items of undefined total length. A defined length can only be one whole frame.
    if (pixel.len === UNDEFINED_LENGTH) encoded = encapsulatedFrames(b, pixel.off, frames);
    else if (frames === 1) encoded = [b.subarray(pixel.off, pixel.off + pixel.len)];
    else throw new IoError(DAMAGED);
  } else if (pixel.len === UNDEFINED_LENGTH || pixel.len < frames * frameBytes) throw new IoError(DAMAGED);

  // Enhanced multi-frame images keep geometry in functional groups, per frame or shared by all frames.
  const shared = ds.get(SHARED_GROUPS)?.items?.[0];
  const perFrame = ds.get(PER_FRAME_GROUPS)?.items;
  const group = (frame: number, sequence: number, tag: number): Element | undefined =>
    perFrame?.[frame]?.get(sequence)?.items?.[0]?.get(tag) ?? shared?.get(sequence)?.items?.[0]?.get(tag);

  const orientation = p.numbers(group(0, PLANE_ORIENTATION, 0x00200037) ?? ds.get(0x00200037), 6);
  const pixelSpacing = p.numbers(group(0, PIXEL_MEASURES, 0x00280030) ?? ds.get(0x00280030) ?? ds.get(0x00181164), 2);
  const positive = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
  const statedGap =
    positive(p.number(group(0, PIXEL_MEASURES, 0x00180088) ?? ds.get(0x00180088))) ??
    positive(p.number(group(0, PIXEL_MEASURES, 0x00180050) ?? ds.get(0x00180050)));
  const topPosition = p.numbers(ds.get(0x00200032), 3);
  const frameOffsets = p.numbers(ds.get(0x3004000c), frames); // GridFrameOffsetVector
  const normal = orientation ? cross(orientation) : undefined;
  const instance = p.number(ds.get(0x00200013)) ?? 0;
  const sopInstance = p.text(ds.get(0x00080018));

  const slices: Slice[] = [];
  for (let f = 0; f < frames; f++) {
    let position = p.numbers(group(f, PLANE_POSITION, 0x00200032), 3) ?? null;
    if (!position && topPosition) {
      if (frames === 1) position = topPosition;
      else if (normal) {
        const d = frameOffsets ? frameOffsets[f] - frameOffsets[0] : f * (statedGap ?? 1);
        position = [topPosition[0] + normal[0] * d, topPosition[1] + normal[1] * d, topPosition[2] + normal[2] * d];
      }
    }
    const slice: Slice = {
      pixels: encoded ? EMPTY : b.subarray(pixel.off + f * frameBytes, pixel.off + (f + 1) * frameBytes),
      position,
      order: instance * 65536 + f,
      slope: p.number(group(f, PIXEL_TRANSFORM, 0x00281053) ?? ds.get(0x00281053)) ?? 1,
      intercept: p.number(group(f, PIXEL_TRANSFORM, 0x00281052) ?? ds.get(0x00281052)) ?? 0,
      sopClass,
      sopInstance,
    };
    if (encoded) slice.encoded = encoded[f];
    if (frames > 1) slice.frame = f + 1;
    slices.push(slice);
  }

  const source: Omit<DicomSourceInfo, 'instances'> = {
    studyInstanceUID: p.text(ds.get(0x0020000d)),
    seriesInstanceUID: p.text(ds.get(0x0020000e)),
  };
  for (const [key, tag] of SOURCE_ATTRIBUTES) {
    const e = ds.get(tag);
    if (e) source[key] = p.text(e);
  }
  const image: Image = {
    rows,
    cols,
    bits,
    bitsStored: Math.min(bits, p.u16(ds.get(0x00280101)) || bits),
    signed: p.u16(ds.get(0x00280103)) === 1,
    source,
    series: source.seriesInstanceUID,
    description: p.text(ds.get(0x0008103e)),
    fileName: file.name,
    orientation,
    pixelSpacing,
    statedGap,
    slices,
  };
  if (encoded) image.transferSyntax = opened.transferSyntax;
  return image;
}

const EMPTY = new Uint8Array(0);

/** Patient and study attributes copied from a source series into objects derived from it. */
const SOURCE_ATTRIBUTES: [Exclude<keyof DicomSourceInfo, 'studyInstanceUID' | 'seriesInstanceUID' | 'instances'>, number][] = [
  ['specificCharacterSet', 0x00080005],
  ['studyDate', 0x00080020],
  ['studyTime', 0x00080030],
  ['accessionNumber', 0x00080050],
  ['referringPhysicianName', 0x00080090],
  ['studyDescription', 0x00081030],
  ['patientName', 0x00100010],
  ['patientID', 0x00100020],
  ['patientBirthDate', 0x00100030],
  ['patientSex', 0x00100040],
  ['studyID', 0x00200010],
  ['frameOfReferenceUID', 0x00200052],
];

/** Copies the slices into one array of the stored pixel type and applies the rescale. */
function assemble(first: Image, slices: Slice[]): ScalarArray {
  const frame = first.rows * first.cols;
  const count = voxelCount([first.cols, first.rows, slices.length]);
  const size = first.bits / 8;
  const stored: ScalarArray =
    first.bits === 8 ? (first.signed ? new Int8Array(count) : new Uint8Array(count))
    : first.bits === 16 ? (first.signed ? new Int16Array(count) : new Uint16Array(count))
    : first.signed ? new Int32Array(count) : new Uint32Array(count);
  const bytes = new Uint8Array(stored.buffer);
  slices.forEach((s, z) => bytes.set(s.pixels, z * frame * size));
  if (!HOST_LE) swapBytes(bytes, size);

  if (slices.every((s) => s.slope === 1 && s.intercept === 0)) return stored;

  let out: ScalarArray;
  if (slices.every((s) => Number.isInteger(s.slope) && Number.isInteger(s.intercept))) {
    // Integer rescale (CT): stay integer, in the narrowest type the rescaled range fits.
    let lo = Infinity;
    let hi = -Infinity;
    slices.forEach((s, z) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = z * frame, end = i + frame; i < end; i++) {
        const v = stored[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const a = min * s.slope + s.intercept;
      const c = max * s.slope + s.intercept;
      lo = Math.min(lo, a, c);
      hi = Math.max(hi, a, c);
    });
    // Reuse the buffer when the element size allows: each value is read before it is overwritten.
    if (lo >= -32768 && hi <= 32767) out = size === 2 ? new Int16Array(stored.buffer) : new Int16Array(count);
    else if (lo >= -2147483648 && hi <= 2147483647) out = size === 4 ? new Int32Array(stored.buffer) : new Int32Array(count);
    else out = new Float32Array(count);
  } else out = new Float32Array(count);

  slices.forEach((s, z) => {
    const { slope, intercept } = s;
    for (let i = z * frame, end = i + frame; i < end; i++) out[i] = stored[i] * slope + intercept;
  });
  return out;
}

/** Parses every file and keeps the images of the series to open. Null when none of the files is DICOM. */
function collect(files: InputFile[]): Image[] | null {
  const images: Image[] = [];
  let sawDicom = false;
  for (const f of files) {
    const parsed = parseFile(f);
    if (parsed === null) continue;
    sawDicom = true;
    if (parsed !== 'no-image') images.push(parsed);
  }
  if (!sawDicom) return null;
  if (images.length === 0) throw new IoError('These DICOM files have no image in them.');

  // Keep the series with the most slices: a selection often includes a scout or a dose report.
  const bySeries = new Map<string, Image[]>();
  for (const im of images) {
    const list = bySeries.get(im.series);
    if (list) list.push(im);
    else bySeries.set(im.series, [im]);
  }
  let series: Image[] = [];
  let most = 0;
  for (const list of bySeries.values()) {
    const n = list.reduce((sum, im) => sum + im.slices.length, 0);
    if (n > most) {
      most = n;
      series = list;
    }
  }
  const first = series[0];
  for (const im of series) {
    if (im.rows !== first.rows || im.cols !== first.cols || im.bits !== first.bits || im.signed !== first.signed) {
      throw new IoError('The slices of this DICOM series have different sizes and cannot be opened as one volume.');
    }
  }
  return series;
}

/** Sorts the slices of a series, works out the geometry and assembles the volume. All frames must be decoded. */
function build(series: Image[]): VolumeData {
  const first = series[0];
  const slices = series.flatMap((im) => im.slices);
  const n = slices.length;

  // In-plane axes: i runs along a row (first three orientation numbers), j down a column.
  const o = first.orientation;
  const rowGap = first.pixelSpacing?.[0] || 1;
  const colGap = first.pixelSpacing?.[1] || 1;
  const gap = first.statedGap ?? 1;
  let steps = [colGap, 0, 0, 0, rowGap, 0, 0, 0, gap];
  let origin = [0, 0, 0];
  if (o && slices.every((s) => s.position)) {
    const normal = cross(o);
    const along = (s: Slice) => {
      const q = s.position as number[];
      return q[0] * normal[0] + q[1] * normal[1] + q[2] * normal[2];
    };
    slices.sort((a, b) => along(a) - along(b));
    const p0 = slices[0].position as number[];
    let k = [normal[0] * gap, normal[1] * gap, normal[2] * gap];
    if (n > 1) {
      const mean = (along(slices[n - 1]) - along(slices[0])) / (n - 1);
      const tolerance = Math.max(0.01, 0.01 * mean);
      for (let z = 1; z < n; z++) {
        if (!(Math.abs(along(slices[z]) - along(slices[z - 1]) - mean) <= tolerance) || !(mean > 0)) {
          throw new IoError('This DICOM series has missing or unevenly spaced slices and cannot be opened as one volume.');
        }
      }
      // First-to-last vector rather than the normal, so a tilted gantry still lands every slice where it was taken.
      const pn = slices[n - 1].position as number[];
      k = [(pn[0] - p0[0]) / (n - 1), (pn[1] - p0[1]) / (n - 1), (pn[2] - p0[2]) / (n - 1)];
    }
    steps = [o[0] * colGap, o[1] * colGap, o[2] * colGap, o[3] * rowGap, o[4] * rowGap, o[5] * rowGap, k[0], k[1], k[2]];
    origin = p0;
  } else {
    slices.sort((a, b) => a.order - b.order);
  }

  const vol: VolumeData = {
    name: first.description || baseName(first.fileName),
    dims: [first.cols, first.rows, n],
    ...geometryFromSteps(steps, origin),
    data: assemble(first, slices),
  };
  // What a DICOM SEG must reference: only when every slice can be identified.
  const { source } = first;
  if (source.studyInstanceUID && source.seriesInstanceUID && slices.every((s) => s.sopClass && s.sopInstance)) {
    vol.dicom = {
      ...source,
      instances: slices.map((s) => {
        const ref: DicomSourceInfo['instances'][number] = { sopClassUID: s.sopClass, sopInstanceUID: s.sopInstance };
        if (s.frame !== undefined) ref.frame = s.frame;
        return ref;
      }),
    };
  }
  return vol;
}

/** Sign-extends, in place, values that use fewer bits than their element has. */
function signExtend(pixels: Uint8Array, bits: number, bitsStored: number): void {
  const shift = 32 - bitsStored;
  const values =
    bits === 8 ? new Int8Array(pixels.buffer, pixels.byteOffset, pixels.length)
    : bits === 16 ? new Int16Array(pixels.buffer, pixels.byteOffset, pixels.length >> 1)
    : new Int32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2);
  for (let i = 0; i < values.length; i++) values[i] = (values[i] << shift) >> shift;
}

/** Checks what a decoder returned and brings it to the stored pixel layout. */
function decodedPixels(out: Uint8Array, im: Image): Uint8Array {
  const count = im.rows * im.cols;
  const size = im.bits / 8;
  let pixels = out;
  if (out.length === count && im.bits === 16) {
    // An 8-bit code stream in a 16-bit image.
    pixels = new Uint8Array(count * 2);
    for (let i = 0; i < count; i++) pixels[i * 2] = out[i];
  } else if (out.length !== count * size) throw new IoError(DAMAGED);
  if (im.signed && im.bitsStored < im.bits) {
    if (pixels === out || pixels.byteOffset % size !== 0) pixels = pixels.slice();
    if (!HOST_LE) swapBytes(pixels, size);
    signExtend(pixels, im.bits, im.bitsStored);
    if (!HOST_LE) swapBytes(pixels, size);
  }
  return pixels;
}

const NEEDS_ASYNC = 'Compressed DICOM cannot be read synchronously. Use readVolumeAsync.';

/**
 * Builds one volume from the files of an uncompressed DICOM series (or one
 * multi-frame file). Returns null when none of the files is DICOM.
 */
export function readDicom(files: InputFile[]): VolumeData | null {
  const series = collect(files);
  if (!series) return null;
  if (series.some((im) => im.transferSyntax)) throw new IoError(NEEDS_ASYNC);
  return build(series);
}

/**
 * Like `readDicom`, and also decodes compressed pixel data with the decoders
 * that `loadCodec` supplies. Only the series that is opened is decoded.
 */
export async function readDicomAsync(files: InputFile[], loadCodec: CodecLoader): Promise<VolumeData | null> {
  const series = collect(files);
  if (!series) return null;
  for (const im of series) {
    if (!im.transferSyntax) continue;
    let decode: FrameDecoder;
    try {
      decode = await loadCodec(im.transferSyntax);
    } catch (e) {
      if (e instanceof IoError) throw e;
      throw new IoError('The decoder for this compressed DICOM series could not be loaded. Convert the series to NIfTI first.');
    }
    const spec: FrameSpec = {
      rows: im.rows,
      cols: im.cols,
      bitsAllocated: im.bits,
      bitsStored: im.bitsStored,
      signed: im.signed,
      transferSyntax: im.transferSyntax,
    };
    for (const s of im.slices) {
      let out: Uint8Array;
      try {
        out = await decode(s.encoded as Uint8Array, spec);
      } catch (e) {
        if (e instanceof IoError) throw e;
        throw new IoError(DAMAGED);
      }
      s.pixels = decodedPixels(out, im);
      s.encoded = undefined;
    }
  }
  return build(series);
}
