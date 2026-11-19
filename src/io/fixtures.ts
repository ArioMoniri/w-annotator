/** Builders for small synthetic files, used by the tests only. */
import { BYTES, type ScalarType } from './util';

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Encodes numbers byte by byte through a DataView, independent of the code under test. */
export function encode(values: ArrayLike<number>, type: ScalarType, le = true): Uint8Array {
  const size = BYTES[type];
  const out = new Uint8Array(values.length * size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const o = i * size;
    if (type === 'uint8') dv.setUint8(o, v);
    else if (type === 'int8') dv.setInt8(o, v);
    else if (type === 'uint16') dv.setUint16(o, v, le);
    else if (type === 'int16') dv.setInt16(o, v, le);
    else if (type === 'uint32') dv.setUint32(o, v, le);
    else if (type === 'int32') dv.setInt32(o, v, le);
    else if (type === 'float32') dv.setFloat32(o, v, le);
    else if (type === 'float64') dv.setFloat64(o, v, le);
    else if (type === 'int64') dv.setBigInt64(o, BigInt(v), le);
    else dv.setBigUint64(o, BigInt(v), le);
  }
  return out;
}

export const ramp = (n: number, start = 0): number[] => Array.from({ length: n }, (_, i) => start + i);

export interface NiiOpts {
  /** Image size, e.g. [3, 2, 2] or [3, 2, 2, 5] for 4D. */
  dim: number[];
  datatype: number;
  bitpix: number;
  /** Voxel bytes, already in the file's byte order. */
  data: Uint8Array;
  le?: boolean;
  version?: 1 | 2;
  /** [qfac, dx, dy, dz, ...] */
  pixdim?: number[];
  qformCode?: number;
  /** [b, c, d, x, y, z] */
  quatern?: number[];
  sformCode?: number;
  /** srow_x, srow_y, srow_z: 12 numbers. */
  srow?: number[];
  slope?: number;
  inter?: number;
  /** 'n+1' (single file, default) or 'ni1' (header for a separate .img). */
  magic?: string;
}

/** A NIfTI-1 or NIfTI-2 file written field by field at the offsets given in the standard. */
export function niftiBytes(o: NiiOpts): Uint8Array {
  const le = o.le ?? true;
  const v2 = o.version === 2;
  const magic = o.magic ?? (v2 ? 'n+2' : 'n+1');
  const single = magic[1] === '+';
  const hdrSize = v2 ? 540 : 348;
  const voxOffset = single ? hdrSize + 4 : 0;
  const out = new Uint8Array(single ? voxOffset + o.data.length : hdrSize);
  const dv = new DataView(out.buffer);
  const dim = [o.dim.length, ...o.dim];
  while (dim.length < 8) dim.push(1);
  const pixdim = (o.pixdim ?? [1, 1, 1, 1]).slice();
  while (pixdim.length < 8) pixdim.push(0);
  const q = o.quatern ?? [0, 0, 0, 0, 0, 0];
  const srow = o.srow ?? new Array<number>(12).fill(0);
  dv.setInt32(0, hdrSize, le);
  if (!v2) {
    dim.forEach((d, i) => dv.setInt16(40 + i * 2, d, le));
    dv.setInt16(70, o.datatype, le);
    dv.setInt16(72, o.bitpix, le);
    pixdim.forEach((p, i) => dv.setFloat32(76 + i * 4, p, le));
    dv.setFloat32(108, voxOffset, le);
    dv.setFloat32(112, o.slope ?? 0, le);
    dv.setFloat32(116, o.inter ?? 0, le);
    dv.setInt16(252, o.qformCode ?? 0, le);
    dv.setInt16(254, o.sformCode ?? 0, le);
    q.forEach((v, i) => dv.setFloat32(256 + i * 4, v, le));
    srow.forEach((v, i) => dv.setFloat32(280 + i * 4, v, le));
    out.set(ascii(magic), 344);
  } else {
    out.set(ascii(magic), 4);
    out.set([0x0d, 0x0a, 0x1a, 0x0a], 8);
    dv.setInt16(12, o.datatype, le);
    dv.setInt16(14, o.bitpix, le);
    dim.forEach((d, i) => dv.setBigInt64(16 + i * 8, BigInt(d), le));
    pixdim.forEach((p, i) => dv.setFloat64(104 + i * 8, p, le));
    dv.setBigInt64(168, BigInt(voxOffset), le);
    dv.setFloat64(176, o.slope ?? 0, le);
    dv.setFloat64(184, o.inter ?? 0, le);
    dv.setInt32(344, o.qformCode ?? 0, le);
    dv.setInt32(348, o.sformCode ?? 0, le);
    q.forEach((v, i) => dv.setFloat64(352 + i * 8, v, le));
    srow.forEach((v, i) => dv.setFloat64(400 + i * 8, v, le));
  }
  if (single) out.set(o.data, voxOffset);
  return out;
}

// ---- DICOM ----

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UN', 'UT']);

export const us = (...v: number[]): Uint8Array => encode(v, 'uint16');

/** One data element. `tag` is 0xGGGGEEEE. Strings are padded to an even length. */
export function dcmEl(tag: number, vr: string, value: Uint8Array | string, explicit = true): Uint8Array {
  let bytes = typeof value === 'string' ? ascii(value) : value;
  if (bytes.length % 2) bytes = concat(bytes, Uint8Array.of(vr === 'UI' ? 0 : 0x20));
  return concat(elHeader(tag, vr, bytes.length, explicit), bytes);
}

function elHeader(tag: number, vr: string, length: number, explicit: boolean): Uint8Array {
  const long = explicit && LONG_VRS.has(vr);
  const head = new Uint8Array(explicit ? (long ? 12 : 8) : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, tag >>> 16, true);
  dv.setUint16(2, tag & 0xffff, true);
  if (!explicit) dv.setUint32(4, length, true);
  else {
    head.set(ascii(vr), 4);
    if (long) dv.setUint32(8, length, true);
    else dv.setUint16(6, length, true);
  }
  return head;
}

/** A sequence element. Each item is the concatenated elements of that item. */
export function dcmSeq(tag: number, items: Uint8Array[], explicit = true, undefinedLength = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const item of items) {
    if (undefinedLength) {
      parts.push(elHeader(0xfffee000, '', 0xffffffff, false), item, elHeader(0xfffee00d, '', 0, false));
    } else {
      parts.push(elHeader(0xfffee000, '', item.length, false), item);
    }
  }
  if (undefinedLength) parts.push(elHeader(0xfffee0dd, '', 0, false));
  const body = concat(...parts);
  return concat(elHeader(tag, 'SQ', undefinedLength ? 0xffffffff : body.length, explicit), body);
}

export const TS_IMPLICIT = '1.2.840.10008.1.2';
export const TS_EXPLICIT = '1.2.840.10008.1.2.1';

/** Wraps a data set in the 128-byte preamble, the DICM marker and the file meta group. */
export function dcmFile(transferSyntax: string, dataset: Uint8Array): Uint8Array {
  const meta = dcmEl(0x00020010, 'UI', transferSyntax);
  const groupLength = dcmEl(0x00020000, 'UL', encode([meta.length], 'uint32'));
  return concat(new Uint8Array(128), ascii('DICM'), groupLength, meta, dataset);
}

export interface SliceOpts {
  rows: number;
  cols: number;
  /** Pixel bytes, little endian. */
  pixels: Uint8Array;
  explicit?: boolean;
  bits?: number;
  signed?: boolean;
  position?: number[];
  orientation?: number[];
  /** [row spacing, column spacing] as stored in PixelSpacing. */
  pixelSpacing?: number[];
  slope?: number;
  intercept?: number;
  instance?: number;
  series?: string;
  description?: string;
  transferSyntax?: string;
  /** Extra elements placed before the pixel data. */
  extra?: Uint8Array[];
}

/** A single-frame image file with the handful of elements a volume needs. */
export function dcmSlice(o: SliceOpts): Uint8Array {
  const ex = o.explicit ?? true;
  const bits = o.bits ?? 16;
  const parts: Uint8Array[] = [dcmEl(0x00080060, 'CS', 'CT', ex)];
  if (o.description) parts.push(dcmEl(0x0008103e, 'LO', o.description, ex));
  parts.push(dcmEl(0x0020000e, 'UI', o.series ?? '1.2.3', ex));
  if (o.instance !== undefined) parts.push(dcmEl(0x00200013, 'IS', String(o.instance), ex));
  if (o.position) parts.push(dcmEl(0x00200032, 'DS', o.position.join('\\'), ex));
  if (o.orientation) parts.push(dcmEl(0x00200037, 'DS', o.orientation.join('\\'), ex));
  parts.push(
    dcmEl(0x00280002, 'US', us(1), ex),
    dcmEl(0x00280004, 'CS', 'MONOCHROME2', ex),
    dcmEl(0x00280010, 'US', us(o.rows), ex),
    dcmEl(0x00280011, 'US', us(o.cols), ex),
  );
  if (o.pixelSpacing) parts.push(dcmEl(0x00280030, 'DS', o.pixelSpacing.join('\\'), ex));
  parts.push(
    dcmEl(0x00280100, 'US', us(bits), ex),
    dcmEl(0x00280101, 'US', us(bits), ex),
    dcmEl(0x00280102, 'US', us(bits - 1), ex),
    dcmEl(0x00280103, 'US', us(o.signed ? 1 : 0), ex),
  );
  if (o.intercept !== undefined) parts.push(dcmEl(0x00281052, 'DS', String(o.intercept), ex));
  if (o.slope !== undefined) parts.push(dcmEl(0x00281053, 'DS', String(o.slope), ex));
  if (o.extra) parts.push(...o.extra);
  parts.push(dcmEl(0x7fe00010, 'OW', o.pixels, ex));
  return dcmFile(o.transferSyntax ?? (ex ? TS_EXPLICIT : TS_IMPLICIT), concat(...parts));
}
