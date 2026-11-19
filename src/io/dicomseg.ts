import { SEG_SOP_CLASS, cross, hasSegSopClass, openDicom, type DataSet, type Element, type Parser } from './dicom';
import { baseName } from './names';
import type { DicomSourceInfo, InputFile, VolumeData } from './types';
import { IoError, concatBytes, geometryFromSteps, voxelCount } from './util';

const EXPLICIT_LE = '1.2.840.10008.1.2.1';
/** Identifies this writer in the file meta group (a UUID-derived UID, like every UID made here). */
const IMPLEMENTATION_CLASS_UID = '2.25.207183654391825472396018374650129384756';
const IMPLEMENTATION_NAME = 'W_ANNOTATOR';

// The private block that keeps the mask's exact grid, so that a saved mask reopens voxel for voxel.
const PRIVATE_GROUP = 0x0099;
const PRIVATE_CREATOR = 'W ANNOTATOR';
const GRID_ORIGIN = 0x01; // FD x 3
const GRID_SPACING = 0x02; // FD x 3
const GRID_DIRECTION = 0x03; // FD x 9
const GRID_SLICES = 0x04; // UL

export interface SegSegment {
  /** The label value in the mask; becomes the segment number. */
  index: number;
  name: string;
  /** Display colour, sRGB 0-255. */
  color?: [number, number, number];
}

export interface DicomSegOptions {
  /** Label values present in the mask but not listed here are written as "Segment N". */
  segments: SegSegment[];
  /** The DICOM series the mask was drawn on (`VolumeData.dicom` of the image). Absent for NIfTI, MHA or NRRD images. */
  source?: DicomSourceInfo;
  /** Content date and time written into the file. Defaults to now. */
  date?: Date;
}

/** Whether the file is a DICOM Segmentation object (SOP class 1.2.840.10008.5.1.4.1.1.66.4). */
export function isDicomSeg(file: InputFile): boolean {
  return hasSegSopClass(file.bytes);
}

// ---- colour: sRGB <-> the CIELab encoding of RecommendedDisplayCIELabValue (D65, as dcmjs and OHIF do) ----

const WHITE = [0.95047, 1, 1.08883];

function rgbToCieLab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map((v) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const xyz = [0.4124564 * r + 0.3575761 * g + 0.1804375 * b, 0.2126729 * r + 0.7151522 * g + 0.072175 * b, 0.0193339 * r + 0.119192 * g + 0.9503041 * b];
  const [fx, fy, fz] = xyz.map((v, n) => {
    const t = v / WHITE[n];
    return t > 216 / 24389 ? Math.cbrt(t) : (t * (24389 / 27) + 16) / 116;
  });
  const lab = [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  const u16 = (v: number) => Math.min(65535, Math.max(0, Math.round(v)));
  return [u16((lab[0] * 65535) / 100), u16(((lab[1] + 128) * 65535) / 255), u16(((lab[2] + 128) * 65535) / 255)];
}

function cieLabToRgb(stored: number[]): [number, number, number] {
  const l = (stored[0] * 100) / 65535;
  const a = (stored[1] * 255) / 65535 - 128;
  const b = (stored[2] * 255) / 65535 - 128;
  const fy = (l + 16) / 116;
  const f = [fy + a / 500, fy, fy - b / 200];
  const [x, y, z] = f.map((v, n) => (v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27)) * WHITE[n]);
  const linear = [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
  const out = linear.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(c * 255)));
  });
  return [out[0], out[1], out[2]];
}

// ---- reading ----

const NOT_SEG = 'This file is not a DICOM segmentation.';
const NO_GEOMETRY = 'This DICOM segmentation does not say where its slices lie and cannot be opened.';
const UNEVEN = 'The slices of this DICOM segmentation are unevenly spaced and cannot be opened as one volume.';

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Grid {
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  slices: number;
  /** Slice index of every frame. */
  index: number[];
}

function doubles(p: Parser, e: Element | undefined, count: number): number[] | undefined {
  if (!e || e.len < count * 8) return undefined;
  const dv = new DataView(p.b.buffer, p.b.byteOffset + e.off, count * 8);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(dv.getFloat64(i * 8, true));
  return out.every(Number.isFinite) ? out : undefined;
}

/** The exact grid this app stored when it wrote the file, if it is there and agrees with the standard attributes. */
function privateGrid(p: Parser, ds: DataSet, orientation: number[], pixelSpacing: number[], positions: number[][]): Grid | undefined {
  let block = -1;
  for (let b = 0x10; b <= 0xff && block < 0; b++) {
    const creator = ds.get(PRIVATE_GROUP * 0x10000 + b);
    if (creator && p.text(creator) === PRIVATE_CREATOR) block = b;
  }
  if (block < 0) return undefined;
  const at = (element: number) => ds.get(PRIVATE_GROUP * 0x10000 + block * 0x100 + element);
  const origin = doubles(p, at(GRID_ORIGIN), 3);
  const spacing = doubles(p, at(GRID_SPACING), 3);
  const direction = doubles(p, at(GRID_DIRECTION), 9);
  const count = at(GRID_SLICES);
  if (!origin || !spacing || !direction || !count || count.len < 4) return undefined;
  const slices = new DataView(p.b.buffer, p.b.byteOffset + count.off, 4).getUint32(0, true);
  if (!(spacing[0] > 0 && spacing[1] > 0 && spacing[2] > 0) || slices < 1) return undefined;

  // Someone may have edited the standard attributes since: they win unless the two agree.
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  for (let n = 0; n < 6; n++) if (!near(direction[n], orientation[n], 1e-6)) return undefined;
  if (!near(spacing[0], pixelSpacing[1], 1e-6 * spacing[0]) || !near(spacing[1], pixelSpacing[0], 1e-6 * spacing[1])) return undefined;
  const k = direction.slice(6);
  const index: number[] = [];
  for (const pos of positions) {
    const z = Math.round(dot([pos[0] - origin[0], pos[1] - origin[1], pos[2] - origin[2]], k) / spacing[2]);
    if (z < 0 || z >= slices) return undefined;
    for (let n = 0; n < 3; n++) if (!near(origin[n] + z * spacing[2] * k[n], pos[n], 1e-3)) return undefined;
    index.push(z);
  }
  return { origin: [origin[0], origin[1], origin[2]], spacing: [spacing[0], spacing[1], spacing[2]], direction, slices, index };
}

/** The grid spanned by the frames that are present, from the standard attributes alone. */
function frameGrid(orientation: number[], pixelSpacing: number[], positions: number[][], gaps: (number | undefined)[]): Grid {
  const normal = cross(orientation);
  const along = positions.map((q) => dot(q, normal));
  let lowest = 0;
  let highest = 0;
  along.forEach((d, f) => {
    if (d < along[lowest]) lowest = f;
    if (d > along[highest]) highest = f;
  });
  const d0 = along[lowest];
  // Frames may be sparse, so the gap between neighbours can be a multiple of the slice spacing: prefer a stated one.
  const distinct = Array.from(new Set(along)).sort((a, b) => a - b);
  let smallest: number | undefined;
  for (let n = 1; n < distinct.length; n++) {
    const gap = distinct[n] - distinct[n - 1];
    if (gap > 0.001 && (smallest === undefined || gap < smallest)) smallest = gap;
  }
  const fits = (g: number) =>
    along.every((d) => {
      const steps = (d - d0) / g;
      return Math.abs(steps - Math.round(steps)) * g <= Math.max(0.01, 0.01 * g);
    });
  const candidates = [gaps[0], gaps[1], smallest, gaps[2], 1].filter((g): g is number => g !== undefined && g > 0);
  const gap = candidates.find(fits);
  if (gap === undefined) throw new IoError(UNEVEN);
  const index = along.map((d) => Math.round((d - d0) / gap));
  const last = index[highest];
  const p0 = positions[lowest];
  const pn = positions[highest];
  // First-to-last vector, as for an image series, so sheared stacks keep their slice positions.
  const k = last > 0 ? [(pn[0] - p0[0]) / last, (pn[1] - p0[1]) / last, (pn[2] - p0[2]) / last] : [normal[0] * gap, normal[1] * gap, normal[2] * gap];
  const o = orientation;
  const [rowGap, colGap] = pixelSpacing;
  const steps = [o[0] * colGap, o[1] * colGap, o[2] * colGap, o[3] * rowGap, o[4] * rowGap, o[5] * rowGap, k[0], k[1], k[2]];
  return { ...geometryFromSteps(steps, p0), slices: last + 1, index };
}

/**
 * Reads a DICOM Segmentation object into a labelmap on the segmentation's own
 * grid: each voxel holds the number of its segment, 0 where there is none.
 * Use `resampleNearest` to bring it onto an image's grid.
 *
 * `reference` (the image the mask belongs to) only helps when the file does
 * not state its slice spacing: with sparse frames the spacing cannot be told
 * from the frame positions alone.
 */
export function readDicomSeg(file: InputFile, reference?: VolumeData): VolumeData {
  const opened = openDicom(file.bytes);
  if (!opened) throw new IoError(NOT_SEG);
  const { p, ds } = opened;
  if (p.text(ds.get(0x00080016)) !== SEG_SOP_CLASS && !hasSegSopClass(file.bytes)) throw new IoError(NOT_SEG);
  if (opened.compressed) {
    throw new IoError('This DICOM segmentation is compressed and cannot be opened. Save it uncompressed and try again.');
  }
  const type = p.text(ds.get(0x00620001));
  if (type !== 'BINARY' && type !== 'FRACTIONAL') {
    throw new IoError(`DICOM segmentations of type "${type || 'unknown'}" are not supported.`);
  }
  const rows = p.u16(ds.get(0x00280010));
  const cols = p.u16(ds.get(0x00280011));
  const pixel = ds.get(0x7fe00010);
  if (!rows || !cols || !pixel) throw new IoError('This DICOM segmentation has no image in it.');
  const frames = Math.max(1, Math.floor(p.number(ds.get(0x00280008)) ?? 1));
  const bits = p.u16(ds.get(0x00280100)) ?? (type === 'BINARY' ? 1 : 8);
  if (bits !== 1 && bits !== 8) throw new IoError(`DICOM segmentations with ${bits} bits per pixel are not supported.`);
  const frameSize = rows * cols;
  const needed = bits === 1 ? Math.ceil((frames * frameSize) / 8) : frames * frameSize;
  if (pixel.len === 0xffffffff || pixel.len < needed) throw new IoError('This DICOM file is incomplete or damaged.');

  // Segments.
  const labels: Record<number, string> = {};
  const colors: Record<number, [number, number, number]> = {};
  const utf8 = p.text(ds.get(0x00080005)).includes('ISO_IR 192');
  const text = (e: Element | undefined) => {
    if (!e || !utf8) return p.text(e);
    return new TextDecoder().decode(p.b.subarray(e.off, e.off + e.len)).replace(/[\0\s]+$/, '').trim();
  };
  const segmentNumbers: number[] = [];
  for (const item of ds.get(0x00620002)?.items ?? []) {
    const number = p.u16(item.get(0x00620004));
    if (!number) continue;
    segmentNumbers.push(number);
    const label = text(item.get(0x00620005));
    if (label) labels[number] = label;
    const lab = item.get(0x0062000d);
    if (lab && lab.len >= 6) {
      const dv = new DataView(p.b.buffer, p.b.byteOffset + lab.off, 6);
      colors[number] = cieLabToRgb([dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true)]);
    }
  }

  // Functional groups: per frame first, then shared by all frames.
  const shared = ds.get(0x52009229)?.items?.[0];
  const perFrame = ds.get(0x52009230)?.items;
  const group = (frame: number, sequence: number, tag: number): Element | undefined =>
    perFrame?.[frame]?.get(sequence)?.items?.[0]?.get(tag) ?? shared?.get(sequence)?.items?.[0]?.get(tag);

  const orientation = p.numbers(group(0, 0x00209116, 0x00200037), 6);
  const pixelSpacing = p.numbers(group(0, 0x00289110, 0x00280030), 2);
  if (!orientation || !pixelSpacing || !(pixelSpacing[0] > 0) || !(pixelSpacing[1] > 0)) throw new IoError(NO_GEOMETRY);
  const positions: number[][] = [];
  const frameSegment: number[] = [];
  for (let f = 0; f < frames; f++) {
    const position = p.numbers(group(f, 0x00209113, 0x00200032), 3);
    if (!position) throw new IoError(NO_GEOMETRY);
    positions.push(position);
    const o = p.numbers(group(f, 0x00209116, 0x00200037), 6);
    if (o && o.some((v, n) => Math.abs(v - orientation[n]) > 1e-4)) {
      throw new IoError('The frames of this DICOM segmentation have different orientations and cannot be opened as one volume.');
    }
    const segment = p.u16(group(f, 0x0062000a, 0x0062000b)) ?? (segmentNumbers.length === 1 ? segmentNumbers[0] : undefined);
    if (!segment) throw new IoError('This DICOM segmentation does not say which segment its frames belong to.');
    frameSegment.push(segment);
  }

  let referenceGap: number | undefined;
  if (reference) {
    const parallel = Math.abs(dot(reference.direction.slice(6), cross(orientation)));
    if (parallel > 0.999) referenceGap = reference.spacing[2] * parallel;
  }
  const stated = (tag: number) => p.number(group(0, 0x00289110, tag));
  const grid =
    privateGrid(p, ds, orientation, pixelSpacing, positions) ??
    frameGrid(orientation, pixelSpacing, positions, [stated(0x00180088), referenceGap, stated(0x00180050)]);

  const highestNumber = frameSegment.reduce((a, b) => Math.max(a, b), 0);
  const count = voxelCount([cols, rows, grid.slices]);
  const data = highestNumber > 255 ? new Uint16Array(count) : new Uint8Array(count);
  const packed = p.b.subarray(pixel.off, pixel.off + pixel.len);
  // Lower segment numbers first, so that where segments overlap the higher number is what remains.
  const order = frameSegment.map((_, f) => f).sort((a, b) => frameSegment[a] - frameSegment[b] || a - b);
  let overlap = false;
  for (const f of order) {
    const segment = frameSegment[f];
    const out = grid.index[f] * frameSize;
    const start = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      // Binary frames are packed one bit per pixel, least significant bit first, with no padding between frames.
      const bit = start + i;
      const on = bits === 1 ? (packed[bit >> 3] >> (bit & 7)) & 1 : packed[bit] > 0 ? 1 : 0;
      if (!on) continue;
      const before = data[out + i];
      if (before !== 0 && before !== segment) overlap = true;
      data[out + i] = segment;
    }
  }

  const warnings: string[] = [];
  if (type === 'FRACTIONAL') {
    warnings.push('This segmentation stores fractional values. Every voxel above zero was taken as part of its segment.');
  }
  if (overlap) warnings.push('Some segments overlap. Where they do, the segment with the higher number was kept.');

  const vol: VolumeData = {
    name: p.text(ds.get(0x0008103e)) || baseName(file.name),
    dims: [cols, rows, grid.slices],
    spacing: grid.spacing,
    origin: grid.origin,
    direction: grid.direction,
    data,
  };
  if (Object.keys(labels).length > 0) vol.labels = labels;
  if (Object.keys(colors).length > 0) vol.colors = colors;
  if (warnings.length > 0) vol.warnings = warnings;
  return vol;
}

// ---- writing ----

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UC', 'UN', 'UR', 'UT']);
type Entry = [tag: number, bytes: Uint8Array];

function header(tag: number, vr: string, length: number): Uint8Array {
  const long = LONG_VRS.has(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, tag >>> 16, true);
  dv.setUint16(2, tag & 0xffff, true);
  head[4] = vr.charCodeAt(0);
  head[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, length, true);
  else dv.setUint16(6, length, true);
  return head;
}

/** One explicit-VR element, padded to an even length. */
function el(tag: number, vr: string, value: Uint8Array): Entry {
  const pad = value.length % 2;
  const out = new Uint8Array((LONG_VRS.has(vr) ? 12 : 8) + value.length + pad);
  const head = header(tag, vr, value.length + pad);
  out.set(head);
  out.set(value, head.length);
  if (pad) out[out.length - 1] = vr === 'UI' || vr === 'OB' ? 0 : 0x20;
  return [tag, out];
}

/** The elements of a data set or item in ascending tag order, as the standard requires. */
function dataset(entries: (Entry | undefined)[]): Uint8Array {
  const present = entries.filter((e): e is Entry => e !== undefined);
  return concatBytes(present.sort((a, b) => a[0] - b[0]).map((e) => e[1]));
}

/** A sequence of defined length; each item is a `dataset`. */
function seq(tag: number, items: Uint8Array[]): Entry {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const item of items) {
    const head = new Uint8Array(8);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, 0xfffe, true);
    dv.setUint16(2, 0xe000, true);
    dv.setUint32(4, item.length, true);
    parts.push(head, item);
    length += 8 + item.length;
  }
  return [tag, concatBytes([header(tag, 'SQ', length), ...parts])];
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const us = (tag: number, ...values: number[]) => el(tag, 'US', new Uint8Array(Uint16Array.from(values).buffer));
const ul = (tag: number, ...values: number[]) => el(tag, 'UL', new Uint8Array(Uint32Array.from(values).buffer));
const fd = (tag: number, values: ArrayLike<number>) => el(tag, 'FD', new Uint8Array(Float64Array.from(values).buffer));
const str = (tag: number, vr: string, value: string) => el(tag, vr, ascii(value));
/** An attribute tag as a value (VR AT). */
const at = (tag: number, pointer: number) => el(tag, 'AT', new Uint8Array(Uint16Array.from([pointer >>> 16, pointer & 0xffff]).buffer));

/** A decimal string of at most 16 characters, as VR DS allows. */
function dsNumber(v: number): string {
  let s = String(v + 0);
  for (let digits = 15; s.length > 16 && digits > 0; digits--) s = String(Number(v.toPrecision(digits)));
  return s;
}
const dsList = (tag: number, values: ArrayLike<number>) => str(tag, 'DS', Array.from(values, dsNumber).join('\\'));

/** A new UID under the UUID root: "2.25." and the UUID as one decimal number. */
function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return `2.25.${n.toString()}`;
}

const code = (value: string, scheme: string, meaning: string) =>
  dataset([str(0x00080100, 'SH', value), str(0x00080102, 'SH', scheme), str(0x00080104, 'LO', meaning)]);

/** Decides how text is encoded: UTF-8 when the source series allows it, else the source's own character set. */
function textEncoding(source: DicomSourceInfo | undefined) {
  const sourceSet = source?.specificCharacterSet ?? '';
  const toUtf8 = ['', 'ISO_IR 6', 'ISO_IR 100', 'ISO_IR 192'].includes(sourceSet);
  const encoder = new TextEncoder();
  return {
    characterSet: toUtf8 ? 'ISO_IR 192' : sourceSet,
    /** Text typed in this app. */
    own: (s: string) => (toUtf8 ? encoder.encode(s) : ascii(s.replace(/[^\x20-\x7e]/g, '?'))),
    /** Text read from the source series, held as its bytes in Latin-1. */
    copied: (s: string) => (toUtf8 && sourceSet !== 'ISO_IR 192' ? encoder.encode(s) : ascii(s)),
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Writes a labelmap as a BINARY DICOM Segmentation object (explicit VR little
 * endian): one frame for each segment on each slice where it has voxels.
 * Give `source` when the image came from DICOM, so that the file joins the
 * image's study and references its slices.
 */
export function writeDicomSeg(mask: VolumeData, options: DicomSegOptions): Uint8Array {
  const [cols, rows, slices] = mask.dims;
  const frameSize = rows * cols;
  if (cols > 65535 || rows > 65535) throw new IoError('This mask is too large to save as a DICOM segmentation.');
  const { data } = mask;
  const { source } = options;

  // Which segments have voxels on which slices.
  const present = new Map<number, number[]>();
  for (let k = 0; k < slices; k++) {
    const seen = new Set<number>();
    for (let i = k * frameSize, end = i + frameSize; i < end; i++) {
      const v = data[i];
      if (v !== 0) seen.add(v);
    }
    for (const v of seen) {
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        throw new IoError('This mask holds values that are not label numbers, so it cannot be saved as a DICOM segmentation.');
      }
      const list = present.get(v);
      if (list) list.push(k);
      else present.set(v, [k]);
    }
  }
  const segments = new Map<number, SegSegment>();
  for (const s of options.segments) {
    if (!Number.isInteger(s.index) || s.index < 1 || s.index > 65535) throw new IoError(`"${s.index}" cannot be used as a segment number.`);
    segments.set(s.index, s);
  }
  for (const v of present.keys()) if (!segments.has(v)) segments.set(v, { index: v, name: `Segment ${v}` });
  const ordered = Array.from(segments.values()).sort((a, b) => a.index - b.index);
  if (ordered.length === 0) throw new IoError('There is no segment to save.');

  // One frame per segment and slice. A segmentation must hold at least one frame, even if it is empty.
  const frames: { segment: number; k: number }[] = [];
  for (const s of ordered) for (const k of present.get(s.index) ?? []) frames.push({ segment: s.index, k });
  if (frames.length === 0) frames.push({ segment: ordered[0].index, k: 0 });

  const packed = new Uint8Array(Math.ceil((frames.length * frameSize) / 8));
  frames.forEach(({ segment, k }, f) => {
    const from = k * frameSize;
    const start = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      if (data[from + i] === segment) {
        const bit = start + i;
        packed[bit >> 3] |= 1 << (bit & 7);
      }
    }
  });

  // Geometry.
  const d = mask.direction;
  const sp = mask.spacing;
  const normal = cross(d);
  const kDir = d.slice(6);
  const position = (k: number) => [0, 1, 2].map((n) => mask.origin[n] + k * sp[2] * kDir[n] + 0);
  const sliceGap = Math.abs(dot(kDir, normal)) * sp[2] || sp[2];
  // Position index of the dimension organisation: slices ranked along the plane normal.
  const used = Array.from(new Set(frames.map((f) => f.k))).sort((a, b) => dot(position(a), normal) - dot(position(b), normal));
  const rank = new Map(used.map((k, n) => [k, n + 1]));

  const enc = textEncoding(source);
  const now = options.date ?? new Date();
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const sopInstance = newUid();
  const dimensionOrganization = newUid();
  const copied = (tag: number, vr: string, value: string | undefined) => el(tag, vr, enc.copied(value ?? ''));
  const label = (s: string, max: number) => Array.from(s.replace(/[\\\x00-\x1f]/g, ' ').trim()).slice(0, max).join('');

  const tissue = code('T-D0050', 'SRT', 'Tissue');
  const segmentItems = ordered.map((s) =>
    dataset([
      seq(0x00620003, [tissue]), // SegmentedPropertyCategoryCodeSequence
      us(0x00620004, s.index),
      el(0x00620005, 'LO', enc.own(label(s.name, 64) || `Segment ${s.index}`)),
      str(0x00620008, 'CS', 'MANUAL'),
      s.color ? us(0x0062000d, ...rgbToCieLab(s.color)) : undefined,
      seq(0x0062000f, [tissue]), // SegmentedPropertyTypeCodeSequence
    ]),
  );

  const references = source && source.instances.length === slices ? source.instances : undefined;
  const sourceImage = code('121322', 'DCM', 'Source image for image processing operation');
  const derivation = code('113076', 'DCM', 'Segmentation');
  const frameItems = frames.map(({ segment, k }) => {
    const ref = references?.[k];
    return dataset([
      ref
        ? seq(0x00089124, [
            dataset([
              seq(0x00082112, [
                dataset([
                  str(0x00081150, 'UI', ref.sopClassUID),
                  str(0x00081155, 'UI', ref.sopInstanceUID),
                  ref.frame !== undefined ? str(0x00081160, 'IS', String(ref.frame)) : undefined,
                  seq(0x0040a170, [sourceImage]),
                ]),
              ]),
              seq(0x00089215, [derivation]),
            ]),
          ])
        : undefined,
      seq(0x00209111, [dataset([ul(0x00209157, segment, rank.get(k) as number)])]),
      seq(0x00209113, [dataset([dsList(0x00200032, position(k))])]),
      seq(0x0062000a, [dataset([us(0x0062000b, segment)])]),
    ]);
  });

  let referencedSeries: Entry | undefined;
  if (source) {
    const unique = new Map(source.instances.map((r) => [r.sopInstanceUID, r.sopClassUID]));
    referencedSeries = seq(0x00081115, [
      dataset([
        seq(0x0008114a, Array.from(unique, ([instance, cls]) => dataset([str(0x00081150, 'UI', cls), str(0x00081155, 'UI', instance)]))),
        str(0x0020000e, 'UI', source.seriesInstanceUID),
      ]),
    ]);
  }

  const body = dataset([
    str(0x00080005, 'CS', enc.characterSet),
    str(0x00080008, 'CS', 'DERIVED\\PRIMARY'),
    str(0x00080012, 'DA', date),
    str(0x00080013, 'TM', time),
    str(0x00080016, 'UI', SEG_SOP_CLASS),
    str(0x00080018, 'UI', sopInstance),
    copied(0x00080020, 'DA', source?.studyDate),
    str(0x00080023, 'DA', date),
    copied(0x00080030, 'TM', source?.studyTime),
    str(0x00080033, 'TM', time),
    copied(0x00080050, 'SH', source?.accessionNumber),
    str(0x00080060, 'CS', 'SEG'),
    str(0x00080070, 'LO', 'W Annotator'),
    copied(0x00080090, 'PN', source?.referringPhysicianName),
    source?.studyDescription ? copied(0x00081030, 'LO', source.studyDescription) : undefined,
    el(0x0008103e, 'LO', enc.own(label(mask.name, 64) || 'Segmentation')),
    str(0x00081090, 'LO', 'W Annotator'),
    referencedSeries,
    copied(0x00100010, 'PN', source?.patientName),
    copied(0x00100020, 'LO', source?.patientID),
    copied(0x00100030, 'DA', source?.patientBirthDate),
    copied(0x00100040, 'CS', source?.patientSex),
    str(0x00181000, 'LO', '1'),
    str(0x00181020, 'LO', '1'),
    str(0x0020000d, 'UI', source?.studyInstanceUID || newUid()),
    str(0x0020000e, 'UI', newUid()),
    copied(0x00200010, 'SH', source?.studyID),
    str(0x00200011, 'IS', '300'),
    str(0x00200013, 'IS', '1'),
    str(0x00200052, 'UI', source?.frameOfReferenceUID || newUid()),
    str(0x00201040, 'LO', ''),
    seq(0x00209221, [dataset([str(0x00209164, 'UI', dimensionOrganization)])]),
    seq(0x00209222, [
      dataset([
        str(0x00209164, 'UI', dimensionOrganization),
        at(0x00209165, 0x0062000b),
        at(0x00209167, 0x0062000a),
        str(0x00209421, 'LO', 'ReferencedSegmentNumber'),
      ]),
      dataset([
        str(0x00209164, 'UI', dimensionOrganization),
        at(0x00209165, 0x00200032),
        at(0x00209167, 0x00209113),
        str(0x00209421, 'LO', 'ImagePositionPatient'),
      ]),
    ]),
    us(0x00280002, 1),
    str(0x00280004, 'CS', 'MONOCHROME2'),
    str(0x00280008, 'IS', String(frames.length)),
    us(0x00280010, rows),
    us(0x00280011, cols),
    us(0x00280100, 1),
    us(0x00280101, 1),
    us(0x00280102, 0),
    us(0x00280103, 0),
    str(0x00282110, 'CS', '00'),
    str(0x00620001, 'CS', 'BINARY'),
    seq(0x00620002, segmentItems),
    str(0x00700080, 'CS', 'SEGMENTATION'),
    str(0x00700081, 'LO', 'Segmentation'),
    str(0x00700084, 'PN', ''),
    str(PRIVATE_GROUP * 0x10000 + 0x10, 'LO', PRIVATE_CREATOR),
    fd(PRIVATE_GROUP * 0x10000 + 0x1000 + GRID_ORIGIN, mask.origin),
    fd(PRIVATE_GROUP * 0x10000 + 0x1000 + GRID_SPACING, sp),
    fd(PRIVATE_GROUP * 0x10000 + 0x1000 + GRID_DIRECTION, d),
    ul(PRIVATE_GROUP * 0x10000 + 0x1000 + GRID_SLICES, slices),
    seq(0x52009229, [
      dataset([
        seq(0x00209116, [dataset([dsList(0x00200037, d.slice(0, 6))])]),
        seq(0x00289110, [dataset([dsList(0x00180050, [sliceGap]), dsList(0x00180088, [sliceGap]), dsList(0x00280030, [sp[1], sp[0]])])]),
      ]),
    ]),
    seq(0x52009230, frameItems),
    el(0x7fe00010, 'OB', packed),
  ]);

  const meta = dataset([
    el(0x00020001, 'OB', Uint8Array.of(0, 1)),
    str(0x00020002, 'UI', SEG_SOP_CLASS),
    str(0x00020003, 'UI', sopInstance),
    str(0x00020010, 'UI', EXPLICIT_LE),
    str(0x00020012, 'UI', IMPLEMENTATION_CLASS_UID),
    str(0x00020013, 'SH', IMPLEMENTATION_NAME),
  ]);
  const preamble = new Uint8Array(132);
  preamble.set(ascii('DICM'), 128);
  return concatBytes([preamble, ul(0x00020000, meta.length)[1], meta, body]);
}
