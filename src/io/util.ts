import { decompressSync, gunzipSync } from 'fflate';
import { leafName } from './names';
import type { InputFile, ScalarArray } from './types';

/** An error whose message is safe to show to the user as is. */
export class IoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IoError';
  }
}

/** Element types found in files. 64-bit integers are read into Float64Array. */
export type ScalarType =
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float32'
  | 'float64'
  | 'int64'
  | 'uint64';

export const BYTES: Record<ScalarType, number> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
  int64: 8,
  uint64: 8,
};

export const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Reverses the byte order of every `size`-byte element in place. `bytes` must be aligned to `size`. */
export function swapBytes(bytes: Uint8Array, size: number): void {
  if (size === 2) {
    const a = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      a[i] = ((v & 0xff) << 8) | (v >> 8);
    }
  } else if (size === 4) {
    const a = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      a[i] = (v << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
    }
  } else if (size === 8) {
    const a = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let i = 0; i + 1 < a.length; i += 2) {
      const lo = a[i];
      const hi = a[i + 1];
      a[i] = (hi << 24) | ((hi & 0xff00) << 8) | ((hi >>> 8) & 0xff00) | (hi >>> 24);
      a[i + 1] = (lo << 24) | ((lo & 0xff00) << 8) | ((lo >>> 8) & 0xff00) | (lo >>> 24);
    }
  }
}

/**
 * Interprets `bytes` as `count` elements of `type`. Zero-copy (a view on the
 * same buffer) when the byte order matches the host and the offset is aligned;
 * otherwise one copy.
 */
export function decodeScalars(bytes: Uint8Array, type: ScalarType, count: number, littleEndian: boolean): ScalarArray {
  const size = BYTES[type];
  const need = count * size;
  if (bytes.byteLength < need) {
    throw new IoError(
      `This file is incomplete or damaged: it should hold ${need} bytes of image data but has ${bytes.byteLength}.`,
    );
  }
  if (type === 'uint8') return bytes.subarray(0, count);
  if (type === 'int8') return new Int8Array(bytes.buffer, bytes.byteOffset, count);
  const swap = littleEndian !== HOST_LE;
  let src = bytes;
  if (swap || bytes.byteOffset % size !== 0) {
    src = bytes.slice(0, need);
    if (swap) swapBytes(src, size);
  }
  const { buffer, byteOffset } = src;
  switch (type) {
    case 'uint16':
      return new Uint16Array(buffer, byteOffset, count);
    case 'int16':
      return new Int16Array(buffer, byteOffset, count);
    case 'uint32':
      return new Uint32Array(buffer, byteOffset, count);
    case 'int32':
      return new Int32Array(buffer, byteOffset, count);
    case 'float32':
      return new Float32Array(buffer, byteOffset, count);
    case 'float64':
      return new Float64Array(buffer, byteOffset, count);
    case 'int64':
    case 'uint64': {
      const big =
        type === 'int64' ? new BigInt64Array(buffer, byteOffset, count) : new BigUint64Array(buffer, byteOffset, count);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = Number(big[i]);
      return out;
    }
  }
}

export type WritableType = Exclude<ScalarType, 'int64' | 'uint64'>;

export function typeOf(data: ScalarArray): WritableType {
  if (data instanceof Uint8Array) return 'uint8';
  if (data instanceof Int8Array) return 'int8';
  if (data instanceof Uint16Array) return 'uint16';
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Uint32Array) return 'uint32';
  if (data instanceof Int32Array) return 'int32';
  if (data instanceof Float32Array) return 'float32';
  return 'float64';
}

/** The voxel values as little-endian bytes. A view, not a copy, on little-endian hosts. */
export function littleEndianBytes(data: ScalarArray): Uint8Array {
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (HOST_LE || data.BYTES_PER_ELEMENT === 1) return view;
  const copy = view.slice();
  swapBytes(copy, data.BYTES_PER_ELEMENT);
  return copy;
}

const DAMAGED = 'This file could not be unpacked. It may be damaged or incomplete.';

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return gunzipSync(bytes);
  } catch {
    throw new IoError(DAMAGED);
  }
}

/** Inflates zlib, gzip or raw deflate data. */
export function inflateAny(bytes: Uint8Array): Uint8Array {
  try {
    return decompressSync(bytes);
  } catch {
    throw new IoError(DAMAGED);
  }
}

export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  }
  return s;
}

export function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Geometry {
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
}

/**
 * Splits three voxel-step vectors (world displacement for one step along i, j
 * and k, laid out one after the other) into unit directions and spacings.
 * A zero or invalid step becomes spacing 1 along that axis' own world axis.
 */
export function geometryFromSteps(steps: ArrayLike<number>, origin: ArrayLike<number>): Geometry {
  const spacing: [number, number, number] = [1, 1, 1];
  const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let a = 0; a < 3; a++) {
    const x = steps[a * 3];
    const y = steps[a * 3 + 1];
    const z = steps[a * 3 + 2];
    const norm = Math.sqrt(x * x + y * y + z * z);
    if (!(norm > 0) || !Number.isFinite(norm)) continue;
    spacing[a] = norm;
    // "+ 0" turns -0 into 0 so that geometry compares cleanly.
    direction[a * 3] = x / norm + 0;
    direction[a * 3 + 1] = y / norm + 0;
    direction[a * 3 + 2] = z / norm + 0;
  }
  return {
    spacing,
    origin: [finite(origin[0]) + 0, finite(origin[1]) + 0, finite(origin[2]) + 0],
    direction,
  };
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Checks dims are positive integers and the voxel count is sane; returns the count. */
export function voxelCount(dims: number[]): number {
  let n = 1;
  for (const d of dims) {
    if (!Number.isInteger(d) || d < 1) throw new IoError('This file has an invalid image size and cannot be read.');
    n *= d;
  }
  if (n > 2 ** 32) throw new IoError('This image is too large to open.');
  return n;
}

export function parseNumbers(text: string): number[] {
  const parts = text.trim().split(/[\s,]+/);
  const out: number[] = [];
  for (const p of parts) if (p !== '') out.push(Number(p));
  return out;
}

/** Finds the separate data file a header refers to among the files the user picked. */
export function findDataFile(files: InputFile[], header: InputFile, reference: string): InputFile {
  const wanted = leafName(reference.trim());
  const others = files.filter((f) => f !== header);
  const match = others.find((f) => leafName(f.name) === wanted) ?? (others.length === 1 ? others[0] : undefined);
  if (!match) {
    throw new IoError(
      `The data file "${reference.trim()}" that this header points to is missing. Select it together with the header.`,
    );
  }
  return match;
}
