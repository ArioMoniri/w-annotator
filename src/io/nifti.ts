import { labelsDocument, parseLabels } from './labels';
import { baseName, leafName } from './names';
import type { InputFile, ScalarArray, VolumeData } from './types';
import {
  BYTES,
  IoError,
  decodeScalars,
  geometryFromSteps,
  gunzip,
  isGzip,
  littleEndianBytes,
  typeOf,
  voxelCount,
  type ScalarType,
  type WritableType,
} from './util';

const NOT_NIFTI = 'This is not a valid NIfTI file.';

const DATATYPES: Record<number, ScalarType> = {
  2: 'uint8',
  4: 'int16',
  8: 'int32',
  16: 'float32',
  64: 'float64',
  256: 'int8',
  512: 'uint16',
  768: 'uint32',
  1024: 'int64',
  1280: 'uint64',
};

const DATATYPE_CODES: Record<WritableType, number> = {
  uint8: 2,
  int16: 4,
  int32: 8,
  float32: 16,
  float64: 64,
  int8: 256,
  uint16: 512,
  uint32: 768,
};

/** True when the (already gunzipped) bytes start with a NIfTI-1 or NIfTI-2 header. */
export function isNifti(bytes: Uint8Array): boolean {
  if (bytes.length < 348) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = dv.getInt32(0, true);
  const be = dv.getInt32(0, false);
  if (le === 540 || be === 540) return bytes[4] === 0x6e && bytes[6] === 0x32; // "n?2"
  if (le === 348 || be === 348) return bytes[344] === 0x6e && bytes[346] === 0x31; // "n?1"
  return false;
}

interface Header {
  le: boolean;
  dim: number[];
  datatype: number;
  pixdim: number[];
  voxOffset: number;
  slope: number;
  inter: number;
  qformCode: number;
  sformCode: number;
  quatern: number[];
  srow: number[];
  /** True when the voxels are in the same file as the header. */
  single: boolean;
  /** Size of the header itself: 348 (NIfTI-1) or 540 (NIfTI-2). */
  size: number;
}

function parseHeader(b: Uint8Array): Header {
  if (b.length < 348) throw new IoError(NOT_NIFTI);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let le = true;
  let size = dv.getInt32(0, true);
  if (size !== 348 && size !== 540) {
    le = false;
    size = dv.getInt32(0, false);
  }
  if ((size !== 348 && size !== 540) || b.length < size) throw new IoError(NOT_NIFTI);
  const f32 = (o: number, n: number) => Array.from({ length: n }, (_, i) => dv.getFloat32(o + i * 4, le));
  const f64 = (o: number, n: number) => Array.from({ length: n }, (_, i) => dv.getFloat64(o + i * 8, le));
  if (size === 348) {
    return {
      le,
      dim: Array.from({ length: 8 }, (_, i) => dv.getInt16(40 + i * 2, le)),
      datatype: dv.getInt16(70, le),
      pixdim: f32(76, 8),
      voxOffset: dv.getFloat32(108, le),
      slope: dv.getFloat32(112, le),
      inter: dv.getFloat32(116, le),
      qformCode: dv.getInt16(252, le),
      sformCode: dv.getInt16(254, le),
      quatern: f32(256, 6),
      srow: f32(280, 12),
      // "n+1" means one file; "ni1" or no magic (Analyze 7.5) means a separate .img.
      single: b[344] === 0x6e && b[345] === 0x2b,
      size,
    };
  }
  return {
    le,
    dim: Array.from({ length: 8 }, (_, i) => Number(dv.getBigInt64(16 + i * 8, le))),
    datatype: dv.getInt16(12, le),
    pixdim: f64(104, 8),
    voxOffset: Number(dv.getBigInt64(168, le)),
    slope: dv.getFloat64(176, le),
    inter: dv.getFloat64(184, le),
    qformCode: dv.getInt32(344, le),
    sformCode: dv.getInt32(348, le),
    quatern: f64(352, 6),
    srow: f64(400, 12),
    single: b[5] === 0x2b,
    size,
  };
}

/** Voxel steps (i, j, k one after the other) and origin in RAS, from sform, qform or pixdim. */
function rasAffine(h: Header): { steps: number[]; origin: number[] } {
  const s = h.srow;
  const sformSteps = [s[0], s[4], s[8], s[1], s[5], s[9], s[2], s[6], s[10]];
  const usable = (v: number[]) =>
    v.every(Number.isFinite) && [0, 3, 6].every((o) => v[o] !== 0 || v[o + 1] !== 0 || v[o + 2] !== 0);
  if (h.sformCode > 0 && (usable(sformSteps) || h.qformCode <= 0)) {
    return { steps: sformSteps, origin: [s[3], s[7], s[11]] };
  }
  const size = [1, 2, 3].map((i) => {
    const p = Math.abs(h.pixdim[i]);
    return p > 0 && Number.isFinite(p) ? p : 1;
  });
  if (h.qformCode > 0) {
    let [b, c, d] = h.quatern;
    let a = 1 - (b * b + c * c + d * d);
    if (a < 1e-7) {
      const n = 1 / Math.sqrt(b * b + c * c + d * d);
      b *= n;
      c *= n;
      d *= n;
      a = 0;
    } else a = Math.sqrt(a);
    const qfac = h.pixdim[0] < 0 ? -1 : 1;
    const [dx, dy, dz] = [size[0], size[1], size[2] * qfac];
    return {
      steps: [
        (a * a + b * b - c * c - d * d) * dx, 2 * (b * c + a * d) * dx, 2 * (b * d - a * c) * dx,
        2 * (b * c - a * d) * dy, (a * a + c * c - b * b - d * d) * dy, 2 * (c * d + a * b) * dy,
        2 * (b * d + a * c) * dz, 2 * (c * d - a * b) * dz, (a * a + d * d - c * c - b * b) * dz,
      ],
      origin: [h.quatern[3], h.quatern[4], h.quatern[5]],
    };
  }
  return { steps: [size[0], 0, 0, 0, size[1], 0, 0, 0, size[2]], origin: [0, 0, 0] };
}

function findImg(header: InputFile, files: InputFile[]): Uint8Array {
  const stem = leafName(header.name).replace(/\.hdr$/, '');
  const others = files.filter((f) => f !== header);
  const img =
    others.find((f) => leafName(f.name) === `${stem}.img` || leafName(f.name) === `${stem}.img.gz`) ??
    others.find((f) => /\.img(\.gz)?$/i.test(f.name));
  if (!img) {
    throw new IoError('The .img data file that belongs to this .hdr header is missing. Select both files together.');
  }
  return isGzip(img.bytes) ? gunzip(img.bytes) : img.bytes;
}

const ECODE_COMMENT = 6;

/**
 * Looks for our segment names among the header extensions, which sit between
 * the 4-byte extender after the header and `end`. Extensions written by other
 * software are skipped, and a damaged extension list just ends the search.
 */
function extensionLabels(b: Uint8Array, h: Header, end: number): Record<number, string> | undefined {
  try {
    const stop = Math.min(end, b.length);
    let pos = h.size + 4;
    if (!(pos <= stop) || b[h.size] === 0) return undefined;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let found: Record<number, string> | undefined;
    while (pos + 8 <= stop) {
      const esize = dv.getInt32(pos, h.le);
      if (esize < 8 || esize > stop - pos) break;
      if (dv.getInt32(pos + 4, h.le) === ECODE_COMMENT) {
        let last = pos + esize;
        while (last > pos + 8 && b[last - 1] === 0) last--;
        const text = new TextDecoder().decode(b.subarray(pos + 8, last));
        found = parseLabels(text, true) ?? found;
      }
      pos += esize;
    }
    return found;
  } catch {
    return undefined;
  }
}

export function readNifti(file: InputFile, files: InputFile[]): VolumeData {
  const bytes = isGzip(file.bytes) ? gunzip(file.bytes) : file.bytes;
  const h = parseHeader(bytes);
  const ndim = h.dim[0];
  if (!(ndim >= 1 && ndim <= 7)) throw new IoError(NOT_NIFTI);
  const dims: [number, number, number] = [h.dim[1], ndim >= 2 ? h.dim[2] : 1, ndim >= 3 ? h.dim[3] : 1];
  const count = voxelCount(dims);
  const type = DATATYPES[h.datatype];
  if (!type) {
    throw new IoError(
      `This NIfTI file holds colour, complex or other unusual data (type ${h.datatype}), which is not supported.`,
    );
  }
  const offset = Number.isFinite(h.voxOffset) && h.voxOffset > 0 ? Math.floor(h.voxOffset) : 0;
  const voxels = h.single ? bytes.subarray(Math.min(Math.max(offset, 348), bytes.length)) : findImg(file, files).subarray(offset);
  // A 4D (or higher) file: the first volume is simply the first nx*ny*nz elements.
  let data: ScalarArray = decodeScalars(voxels, type, count, h.le);

  const { slope, inter } = h;
  if (Number.isFinite(slope) && Number.isFinite(inter) && slope !== 0 && !(slope === 1 && inter === 0)) {
    const scaled = new Float32Array(count);
    for (let i = 0; i < count; i++) scaled[i] = data[i] * slope + inter;
    data = scaled;
  }

  // RAS -> LPS: negate the world x and y components.
  const { steps, origin } = rasAffine(h);
  for (let a = 0; a < 9; a += 3) {
    steps[a] = -steps[a];
    steps[a + 1] = -steps[a + 1];
  }
  const vol: VolumeData = {
    name: baseName(file.name),
    dims,
    ...geometryFromSteps(steps, [-origin[0], -origin[1], origin[2]]),
    data,
  };
  // With a separate .img the extensions run to the end of the header file.
  const labels = extensionLabels(bytes, h, h.single ? offset : bytes.length);
  if (labels) vol.labels = labels;
  return vol;
}

/** One comment extension (esize, ecode, body) holding the segment names; empty when there are none. */
function labelExtension(labels: Record<number, string> | undefined): Uint8Array {
  const doc = labelsDocument(labels);
  if (doc === undefined) return new Uint8Array(0);
  const body = new TextEncoder().encode(doc);
  const out = new Uint8Array(Math.ceil((8 + body.length) / 16) * 16);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, out.length, true);
  dv.setInt32(4, ECODE_COMMENT, true);
  out.set(body, 8);
  return out;
}

/**
 * An uncompressed single-file NIfTI-1 image with both sform and qform set.
 * Segment names, when there are any, go in a comment header extension.
 */
export function writeNifti(vol: VolumeData): Uint8Array {
  const [nx, ny, nz] = vol.dims;
  if (nx > 32767 || ny > 32767 || nz > 32767) throw new IoError('This image is too large to save as NIfTI-1.');
  const type = typeOf(vol.data);
  const voxels = littleEndianBytes(vol.data);
  const extension = labelExtension(vol.labels);
  const voxOffset = 352 + extension.length;
  const out = new Uint8Array(voxOffset + voxels.length);
  const dv = new DataView(out.buffer);
  const d = vol.direction;
  const sp = vol.spacing;
  // RAS rotation matrix, r[row][col]: column c is the direction of voxel axis c with x and y negated.
  const r = [
    [-d[0], -d[3], -d[6]],
    [-d[1], -d[4], -d[7]],
    [d[2], d[5], d[8]],
  ];
  const origin = [-vol.origin[0], -vol.origin[1], vol.origin[2]];

  dv.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((v, i) => dv.setInt16(40 + i * 2, v, true));
  dv.setInt16(70, DATATYPE_CODES[type], true);
  dv.setInt16(72, BYTES[type] * 8, true);
  dv.setFloat32(108, voxOffset, true);
  dv.setFloat32(112, 1, true); // scl_slope
  out[123] = 2; // xyzt_units: millimetres
  dv.setInt16(252, 1, true); // qform_code: scanner
  dv.setInt16(254, 1, true); // sform_code: scanner
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) dv.setFloat32(280 + row * 16 + col * 4, r[row][col] * sp[col], true);
    dv.setFloat32(280 + row * 16 + 12, origin[row], true);
    dv.setFloat32(268 + row * 4, origin[row], true);
  }

  // Quaternion from the rotation matrix (as in the NIfTI reference code).
  const det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  const qfac = det < 0 ? -1 : 1;
  const [r11, r12, r13] = [r[0][0], r[0][1], r[0][2] * qfac];
  const [r21, r22, r23] = [r[1][0], r[1][1], r[1][2] * qfac];
  const [r31, r32, r33] = [r[2][0], r[2][1], r[2][2] * qfac];
  let a = r11 + r22 + r33 + 1;
  let b: number;
  let c: number;
  let q: number;
  if (a > 0.5) {
    a = 0.5 * Math.sqrt(a);
    b = (0.25 * (r32 - r23)) / a;
    c = (0.25 * (r13 - r31)) / a;
    q = (0.25 * (r21 - r12)) / a;
  } else {
    const xd = 1 + r11 - (r22 + r33);
    const yd = 1 + r22 - (r11 + r33);
    const zd = 1 + r33 - (r11 + r22);
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = (0.25 * (r12 + r21)) / b;
      q = (0.25 * (r13 + r31)) / b;
      a = (0.25 * (r32 - r23)) / b;
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = (0.25 * (r12 + r21)) / c;
      q = (0.25 * (r23 + r32)) / c;
      a = (0.25 * (r13 - r31)) / c;
    } else {
      q = 0.5 * Math.sqrt(zd);
      b = (0.25 * (r13 + r31)) / q;
      c = (0.25 * (r23 + r32)) / q;
      a = (0.25 * (r12 - r21)) / q;
    }
    if (a < 0) {
      b = -b;
      c = -c;
      q = -q;
    }
  }
  [qfac, sp[0], sp[1], sp[2], 1, 1, 1, 1].forEach((v, i) => dv.setFloat32(76 + i * 4, v, true));
  dv.setFloat32(256, b, true);
  dv.setFloat32(260, c, true);
  dv.setFloat32(264, q, true);
  out.set([0x6e, 0x2b, 0x31, 0], 344); // "n+1\0"
  if (extension.length > 0) {
    out[348] = 1; // extender: extensions follow
    out.set(extension, 352);
  }
  out.set(voxels, voxOffset);
  return out;
}
