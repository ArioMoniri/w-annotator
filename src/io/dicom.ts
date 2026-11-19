import { inflateSync } from 'fflate';
import { baseName } from './names';
import type { InputFile, ScalarArray, VolumeData } from './types';
import { HOST_LE, IoError, geometryFromSteps, latin1, swapBytes, voxelCount } from './util';

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
const KEPT_SEQUENCES = new Set([SHARED_GROUPS, PER_FRAME_GROUPS, PLANE_POSITION, PLANE_ORIENTATION, PIXEL_MEASURES, PIXEL_TRANSFORM]);

interface Element {
  off: number;
  len: number;
  items?: DataSet[];
}
type DataSet = Map<number, Element>;

class Parser {
  private readonly dv: DataView;

  constructor(
    private readonly b: Uint8Array,
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
  pixels: Uint8Array;
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
  signed: boolean;
  series: string;
  description: string;
  fileName: string;
  orientation: number[] | undefined;
  pixelSpacing: number[] | undefined;
  /** Distance between slices as stated in the header; used when positions cannot tell. */
  statedGap: number | undefined;
  slices: Slice[];
}

const cross = (r: number[]) => [r[1] * r[5] - r[2] * r[4], r[2] * r[3] - r[0] * r[5], r[0] * r[4] - r[1] * r[3]];

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

/** Parses one file. Returns null for a file that is not DICOM, 'no-image' for DICOM without pixel data. */
function parseFile(file: InputFile): Image | 'no-image' | null {
  let b = file.bytes;
  if (!isDicom(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = hasPreamble(b) ? 132 : 0;

  // File meta group (0002): always explicit VR little endian.
  let transferSyntax: string | undefined;
  while (pos + 8 <= b.length && dv.getUint16(pos, true) === 0x0002) {
    const long = LONG_VRS.has(String.fromCharCode(b[pos + 4], b[pos + 5]));
    const len = long ? dv.getUint32(pos + 8, true) : dv.getUint16(pos + 6, true);
    const off = pos + (long ? 12 : 8);
    if (off + len > b.length) throw new IoError(DAMAGED);
    if (dv.getUint16(pos + 2, true) === 0x0010) transferSyntax = latin1(b, off, off + len).replace(/[\0\s]+$/, '');
    pos = off + len;
  }

  let explicit: boolean;
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
  } else throw new IoError('Compressed DICOM is not supported yet. Convert the series to NIfTI first.');

  const p = new Parser(b, explicit);
  const ds: DataSet = new Map();
  try {
    p.parse(pos, b.length, ds, true);
  } catch (e) {
    if (e instanceof IoError) throw e;
    throw new IoError(DAMAGED);
  }
  const pixel = ds.get(PIXEL_DATA);
  const rows = p.u16(ds.get(0x00280010));
  const cols = p.u16(ds.get(0x00280011));
  if (!pixel || !rows || !cols) return 'no-image';
  if (pixel.len === UNDEFINED_LENGTH) {
    throw new IoError('Compressed DICOM is not supported yet. Convert the series to NIfTI first.');
  }
  if ((p.u16(ds.get(0x00280002)) ?? 1) !== 1) throw new IoError('Colour DICOM images are not supported.');
  const bits = p.u16(ds.get(0x00280100)) ?? 16;
  if (bits !== 8 && bits !== 16 && bits !== 32) {
    throw new IoError(`DICOM images with ${bits} bits per pixel are not supported.`);
  }
  const frames = Math.max(1, Math.floor(p.number(ds.get(0x00280008)) ?? 1));
  const frameBytes = rows * cols * (bits / 8);
  if (pixel.len < frames * frameBytes) throw new IoError(DAMAGED);

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
    slices.push({
      pixels: b.subarray(pixel.off + f * frameBytes, pixel.off + (f + 1) * frameBytes),
      position,
      order: instance * 65536 + f,
      slope: p.number(group(f, PIXEL_TRANSFORM, 0x00281053) ?? ds.get(0x00281053)) ?? 1,
      intercept: p.number(group(f, PIXEL_TRANSFORM, 0x00281052) ?? ds.get(0x00281052)) ?? 0,
    });
  }
  return {
    rows,
    cols,
    bits,
    signed: p.u16(ds.get(0x00280103)) === 1,
    series: p.text(ds.get(0x0020000e)),
    description: p.text(ds.get(0x0008103e)),
    fileName: file.name,
    orientation,
    pixelSpacing,
    statedGap,
    slices,
  };
}

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

/**
 * Builds one volume from the files of a DICOM series (or one multi-frame
 * file). Returns null when none of the files is DICOM.
 */
export function readDicom(files: InputFile[]): VolumeData | null {
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

  return {
    name: first.description || baseName(first.fileName),
    dims: [first.cols, first.rows, n],
    ...geometryFromSteps(steps, origin),
    data: assemble(first, slices),
  };
}
