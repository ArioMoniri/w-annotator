import { gzipSync } from 'fflate';
import { baseName } from './names';
import type { InputFile, ScalarArray, VolumeData } from './types';
import {
  BYTES,
  IoError,
  asciiBytes,
  concatBytes,
  decodeScalars,
  findDataFile,
  geometryFromSteps,
  gunzip,
  latin1,
  littleEndianBytes,
  parseNumbers,
  typeOf,
  voxelCount,
  type ScalarType,
  type WritableType,
} from './util';

const NOT_NRRD = 'This is not a valid NRRD file.';

const TYPE_GROUPS: [ScalarType, string[]][] = [
  ['int8', ['signed char', 'int8', 'int8_t']],
  ['uint8', ['uchar', 'unsigned char', 'uint8', 'uint8_t']],
  ['int16', ['short', 'short int', 'signed short', 'signed short int', 'int16', 'int16_t']],
  ['uint16', ['ushort', 'unsigned short', 'unsigned short int', 'uint16', 'uint16_t']],
  ['int32', ['int', 'signed int', 'int32', 'int32_t']],
  ['uint32', ['uint', 'unsigned int', 'uint32', 'uint32_t']],
  ['int64', ['longlong', 'long long', 'long long int', 'signed long long', 'signed long long int', 'int64', 'int64_t']],
  ['uint64', ['ulonglong', 'unsigned long long', 'unsigned long long int', 'uint64', 'uint64_t']],
  ['float32', ['float']],
  ['float64', ['double']],
];
const TYPES = new Map<string, ScalarType>();
for (const [type, names] of TYPE_GROUPS) for (const n of names) TYPES.set(n, type);

const TYPE_NAMES: Record<WritableType, string> = {
  int8: 'signed char',
  uint8: 'unsigned char',
  int16: 'short',
  uint16: 'unsigned short',
  int32: 'int',
  uint32: 'unsigned int',
  float32: 'float',
  float64: 'double',
};

/** Sign applied to the world x, y, z components to get from a NRRD space to LPS. */
function lpsSigns(space: string | undefined): [number, number, number] {
  const s = (space ?? '').toLowerCase().replace(/-time$/, '');
  if (s === 'right-anterior-superior' || s === 'ras' || s === 'rast') return [-1, -1, 1];
  if (s === 'left-anterior-superior' || s === 'las' || s === 'last') return [1, -1, 1];
  return [1, 1, 1];
}

export function isNrrd(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && latin1(bytes, 0, 7) === 'NRRD000';
}

interface Header {
  /** Standard fields, keyed by lower-cased name without spaces ("spacedirections"). */
  fields: Map<string, string>;
  /** "key:=value" pairs with their original key. */
  pairs: Map<string, string>;
  dataStart: number;
}

function parseHeader(bytes: Uint8Array): Header {
  if (!isNrrd(bytes)) throw new IoError(NOT_NRRD);
  // The header ends at the first empty line (or at the end of a detached header).
  let end = bytes.length;
  let dataStart = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (bytes[i + 1] === 0x0a) {
      end = i;
      dataStart = i + 2;
      break;
    }
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
      end = i;
      dataStart = i + 3;
      break;
    }
  }
  const fields = new Map<string, string>();
  const pairs = new Map<string, string>();
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split(/\r?\n/);
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line[colon + 1] === '=') pairs.set(line.slice(0, colon), line.slice(colon + 2));
    else fields.set(line.slice(0, colon).toLowerCase().replace(/\s+/g, ''), line.slice(colon + 1).trim());
  }
  return { fields, pairs, dataStart };
}

function parseAscii(text: string, type: ScalarType, count: number): ScalarArray {
  const out: ScalarArray =
    type === 'uint8' ? new Uint8Array(count)
    : type === 'int8' ? new Int8Array(count)
    : type === 'uint16' ? new Uint16Array(count)
    : type === 'int16' ? new Int16Array(count)
    : type === 'uint32' ? new Uint32Array(count)
    : type === 'int32' ? new Int32Array(count)
    : type === 'float32' ? new Float32Array(count)
    : new Float64Array(count);
  const tokens = text.match(/\S+/g) ?? [];
  if (tokens.length < count) {
    throw new IoError(
      `This file is incomplete or damaged: it should hold ${count} values but has ${tokens.length}.`,
    );
  }
  for (let i = 0; i < count; i++) out[i] = Number(tokens[i]);
  return out;
}

function segmentLabels(pairs: Map<string, string>): Record<number, string> | undefined {
  const values = new Map<string, number>();
  const names = new Map<string, string>();
  for (const [key, value] of pairs) {
    const m = /^Segment(\d+)_(LabelValue|Name)$/.exec(key);
    if (!m) continue;
    if (m[2] === 'Name') names.set(m[1], value.trim());
    else values.set(m[1], Number(value));
  }
  if (names.size === 0 && values.size === 0) return undefined;
  const labels: Record<number, string> = {};
  for (const index of new Set([...names.keys(), ...values.keys()])) {
    // Without an explicit label value, segment N is drawn with value N + 1.
    const value = values.get(index) ?? Number(index) + 1;
    if (Number.isFinite(value)) labels[value] = names.get(index) ?? `Segment ${value}`;
  }
  return labels;
}

export function readNrrd(file: InputFile, files: InputFile[]): VolumeData {
  const { fields, pairs, dataStart } = parseHeader(file.bytes);
  const typeName = fields.get('type');
  const dimension = Number(fields.get('dimension'));
  const sizes = parseNumbers(fields.get('sizes') ?? '');
  if (typeName === undefined || !Number.isInteger(dimension) || dimension < 1 || sizes.length !== dimension) {
    throw new IoError(NOT_NRRD);
  }
  const type = TYPES.get(typeName.toLowerCase().replace(/\s+/g, ' '));
  if (!type) throw new IoError(`NRRD files with "${typeName}" data are not supported.`);
  if (dimension > 4) throw new IoError('NRRD files with more than 4 dimensions are not supported.');
  const total = voxelCount(sizes);

  // Which axes are spatial? "none" in space directions marks a list or component axis.
  const vectors = (fields.get('spacedirections')?.match(/none|\([^)]*\)/gi) ?? []).map((t) =>
    /^none$/i.test(t) ? null : parseNumbers(t.slice(1, -1)),
  );
  const hasVectors = vectors.length === dimension;
  let spatial: number[];
  if (hasVectors) spatial = vectors.flatMap((v, a) => (v ? [a] : []));
  else {
    const kinds = (fields.get('kinds') ?? '').split(/\s+/).filter(Boolean);
    spatial =
      kinds.length === dimension
        ? kinds.flatMap((k, a) => (/^(domain|space)$/i.test(k) ? [a] : []))
        : Array.from({ length: Math.min(dimension, 3) }, (_, a) => a);
  }
  const extra = Array.from({ length: dimension }, (_, a) => a).filter((a) => !spatial.includes(a));
  if (spatial.length < 1 || spatial.length > 3 || extra.length > 1) {
    throw new IoError('This NRRD file does not hold a 2D or 3D image and cannot be opened.');
  }
  if (extra.length === 1 && dimension < 4 && sizes[extra[0]] > 1) {
    throw new IoError('Colour and multi-component 2D NRRD files are not supported.');
  }

  const steps = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const spacings = parseNumbers(fields.get('spacings') ?? '');
  const signs = lpsSigns(fields.get('space'));
  const dims: [number, number, number] = [1, 1, 1];
  spatial.forEach((axis, a) => {
    dims[a] = sizes[axis];
    const v = hasVectors ? vectors[axis] : null;
    if (v) for (let c = 0; c < 3; c++) steps[a * 3 + c] = (v[c] ?? 0) * signs[c];
    else if (spacings.length === dimension && Number.isFinite(spacings[axis])) steps[a * 3 + a] = Math.abs(spacings[axis]);
  });
  const o = parseNumbers((fields.get('spaceorigin') ?? '').replace(/[()]/g, ' '));
  const origin = [(o[0] ?? 0) * signs[0], (o[1] ?? 0) * signs[1], (o[2] ?? 0) * signs[2]];

  // Locate and decode the data.
  const dataFile = fields.get('datafile');
  let raw: Uint8Array;
  if (dataFile === undefined) raw = file.bytes.subarray(dataStart);
  else if (/^list\b/i.test(dataFile) || dataFile.includes('%')) {
    throw new IoError('NRRD files that keep each slice in its own file are not supported.');
  } else raw = findDataFile(files, file, dataFile).bytes;

  const encoding = (fields.get('encoding') ?? 'raw').toLowerCase();
  const lineSkip = Number(fields.get('lineskip') ?? 0);
  for (let n = 0; n < lineSkip; n++) {
    const nl = raw.indexOf(0x0a);
    raw = raw.subarray(nl < 0 ? raw.length : nl + 1);
  }
  const byteSkip = Number(fields.get('byteskip') ?? 0);
  const need = total * BYTES[type];
  let all: ScalarArray;
  if (encoding === 'ascii' || encoding === 'text' || encoding === 'txt') {
    all = parseAscii(latin1(raw), type, total);
  } else {
    if (encoding === 'gzip' || encoding === 'gz') raw = gunzip(raw);
    else if (encoding !== 'raw') throw new IoError(`NRRD files with "${encoding}" encoding are not supported.`);
    if (byteSkip > 0) raw = raw.subarray(Math.min(byteSkip, raw.length));
    else if (byteSkip === -1 && raw.length > need) raw = raw.subarray(raw.length - need);
    all = decodeScalars(raw, type, total, (fields.get('endian') ?? 'little').toLowerCase() !== 'big');
  }

  // Keep only the first component of a list axis.
  let data = all;
  const components = extra.length ? sizes[extra[0]] : 1;
  if (components > 1) {
    const p = extra[0];
    const count = total / components;
    let chunk = 1;
    for (let a = 0; a < p; a++) chunk *= sizes[a];
    if (chunk === count) data = all.subarray(0, count);
    else {
      data = new (all.constructor as new (n: number) => ScalarArray)(count);
      if (p === 0) for (let i = 0; i < count; i++) data[i] = all[i * components];
      else for (let m = 0, n = count / chunk; m < n; m++) data.set(all.subarray(m * chunk * components, m * chunk * components + chunk), m * chunk);
    }
  }

  const vol: VolumeData = { name: baseName(file.name), dims, ...geometryFromSteps(steps, origin), data };
  const labels = segmentLabels(pairs);
  if (labels) vol.labels = labels;
  return vol;
}

/** A single-file gzip NRRD in LPS space. Labels are written as 3D Slicer segment fields. */
export function writeNrrd(vol: VolumeData): Uint8Array {
  const d = vol.direction;
  const s = vol.spacing;
  const vec = (a: number) => `(${d[a * 3] * s[a]},${d[a * 3 + 1] * s[a]},${d[a * 3 + 2] * s[a]})`;
  const lines = [
    'NRRD0004',
    `type: ${TYPE_NAMES[typeOf(vol.data)]}`,
    'dimension: 3',
    'space: left-posterior-superior',
    `sizes: ${vol.dims.join(' ')}`,
    `space directions: ${vec(0)} ${vec(1)} ${vec(2)}`,
    'kinds: domain domain domain',
    'endian: little',
    'encoding: gzip',
    `space origin: (${vol.origin.join(',')})`,
  ];
  if (vol.labels) {
    Object.keys(vol.labels)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((value, n) => {
        lines.push(
          `Segment${n}_ID:=Segment_${value}`,
          `Segment${n}_LabelValue:=${value}`,
          `Segment${n}_Layer:=0`,
          `Segment${n}_Name:=${vol.labels?.[value]}`,
        );
      });
  }
  const header = asciiBytes(lines.join('\n') + '\n\n');
  return concatBytes([header, gzipSync(littleEndianBytes(vol.data), { level: 4, mtime: 0 })]);
}
