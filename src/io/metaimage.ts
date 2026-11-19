import { zlibSync } from 'fflate';
import { labelsLine, parseLabels } from './labels';
import { baseName } from './names';
import type { InputFile, VolumeData } from './types';
import {
  BYTES,
  IoError,
  asciiBytes,
  concatBytes,
  decodeScalars,
  findDataFile,
  inflateAny,
  latin1,
  littleEndianBytes,
  parseNumbers,
  typeOf,
  voxelCount,
  type ScalarType,
  type WritableType,
} from './util';

const NOT_META = 'This is not a valid MetaImage file.';

const MET_TYPES: Record<string, ScalarType> = {
  MET_CHAR: 'int8',
  MET_UCHAR: 'uint8',
  MET_SHORT: 'int16',
  MET_USHORT: 'uint16',
  MET_INT: 'int32',
  MET_UINT: 'uint32',
  MET_LONG: 'int32',
  MET_ULONG: 'uint32',
  MET_LONG_LONG: 'int64',
  MET_ULONG_LONG: 'uint64',
  MET_FLOAT: 'float32',
  MET_DOUBLE: 'float64',
};

const MET_NAMES: Record<WritableType, string> = {
  int8: 'MET_CHAR',
  uint8: 'MET_UCHAR',
  int16: 'MET_SHORT',
  uint16: 'MET_USHORT',
  int32: 'MET_INT',
  uint32: 'MET_UINT',
  float32: 'MET_FLOAT',
  float64: 'MET_DOUBLE',
};

/** True when the bytes start like a MetaImage text header. */
export function isMetaImage(bytes: Uint8Array): boolean {
  return /^\s*(ObjectType|NDims)\s*=/.test(latin1(bytes, 0, Math.min(bytes.length, 64)));
}

/** Reads "Key = Value" lines up to and including ElementDataFile; returns the fields and where the data starts. */
function parseHeader(bytes: Uint8Array): { fields: Map<string, string>; dataStart: number } {
  const fields = new Map<string, string>();
  const limit = Math.min(bytes.length, 1 << 20);
  let pos = 0;
  while (pos < limit) {
    let end = pos;
    while (end < limit && bytes[end] !== 0x0a) end++;
    const line = latin1(bytes, pos, end);
    pos = end + 1;
    const eq = line.indexOf('=');
    if (eq < 0) {
      if (line.trim() === '') continue;
      break;
    }
    const key = line.slice(0, eq).trim().toLowerCase();
    fields.set(key, line.slice(eq + 1).trim());
    if (key === 'elementdatafile') return { fields, dataStart: Math.min(pos, bytes.length) };
  }
  throw new IoError(NOT_META);
}

/** Our own header key for segment names; MetaImage readers skip keys they do not know. */
const LABELS_KEY = 'WAnnotatorLabels';

const isTrue = (v: string | undefined) => v !== undefined && /^true$/i.test(v);

export function readMetaImage(file: InputFile, files: InputFile[]): VolumeData {
  const { fields, dataStart } = parseHeader(file.bytes);
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = fields.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const ndims = Number(get('ndims'));
  const dimSize = parseNumbers(get('dimsize') ?? '');
  const typeName = get('elementtype');
  if (!Number.isInteger(ndims) || typeName === undefined || dimSize.length < ndims) throw new IoError(NOT_META);
  if (ndims !== 2 && ndims !== 3) throw new IoError('Only 2D and 3D MetaImage files are supported.');
  const type = MET_TYPES[typeName.toUpperCase()];
  if (!type) throw new IoError(`MetaImage files with ${typeName} data are not supported.`);
  if (Number(get('elementnumberofchannels') ?? 1) !== 1) {
    throw new IoError('Colour and multi-channel MetaImage files are not supported.');
  }
  const dims: [number, number, number] = [dimSize[0], dimSize[1], ndims === 3 ? dimSize[2] : 1];
  const count = voxelCount(dims);

  const numbers = (text: string | undefined, n: number) => {
    const v = parseNumbers(text ?? '');
    return v.length >= n && v.every(Number.isFinite) ? v : undefined;
  };
  const sp = numbers(get('elementspacing', 'elementsize'), ndims);
  const off = numbers(get('offset', 'position', 'origin'), ndims);
  const m = numbers(get('transformmatrix', 'rotation', 'orientation'), ndims * ndims);
  const spacing: [number, number, number] = [1, 1, 1];
  const origin: [number, number, number] = [0, 0, 0];
  const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let a = 0; a < ndims; a++) {
    if (sp && sp[a] !== 0) spacing[a] = Math.abs(sp[a]);
    if (off) origin[a] = off[a] + 0;
    // The matrix lists the world direction of each voxel axis in turn, as VolumeData does.
    if (m) for (let c = 0; c < ndims; c++) direction[a * 3 + c] = m[a * ndims + c] + 0;
  }

  const dataFile = get('elementdatafile') ?? '';
  let raw: Uint8Array;
  if (/^local$/i.test(dataFile)) raw = file.bytes.subarray(dataStart);
  else if (/^list\b/i.test(dataFile) || dataFile.includes('%')) {
    throw new IoError('MetaImage files that keep each slice in its own file are not supported.');
  } else raw = findDataFile(files, file, dataFile).bytes;

  const need = count * BYTES[type];
  const compressed = isTrue(get('compresseddata'));
  const headerSize = Number(get('headersize') ?? 0);
  if (headerSize > 0) raw = raw.subarray(Math.min(headerSize, raw.length));
  if (compressed) {
    const size = Number(get('compresseddatasize'));
    raw = inflateAny(size > 0 && size <= raw.length ? raw.subarray(0, size) : raw);
  } else if (headerSize === -1 && raw.length > need) {
    raw = raw.subarray(raw.length - need);
  }
  const msb = isTrue(get('binarydatabyteordermsb', 'elementbyteordermsb'));
  const vol: VolumeData = {
    name: baseName(file.name),
    dims,
    spacing,
    origin,
    direction,
    data: decodeScalars(raw, type, count, !msb),
  };
  const labels = parseLabels(get(LABELS_KEY.toLowerCase()) ?? '');
  if (labels) vol.labels = labels;
  return vol;
}

/** A single-file .mha with zlib-compressed little-endian data. Segment names go in a WAnnotatorLabels line. */
export function writeMetaImage(vol: VolumeData): Uint8Array {
  const data = zlibSync(littleEndianBytes(vol.data), { level: 4 });
  const labels = labelsLine(vol.labels);
  const header =
    [
      'ObjectType = Image',
      'NDims = 3',
      'BinaryData = True',
      'BinaryDataByteOrderMSB = False',
      'CompressedData = True',
      `CompressedDataSize = ${data.length}`,
      `TransformMatrix = ${vol.direction.join(' ')}`,
      `Offset = ${vol.origin.join(' ')}`,
      'CenterOfRotation = 0 0 0',
      `ElementSpacing = ${vol.spacing.join(' ')}`,
      `DimSize = ${vol.dims.join(' ')}`,
      `ElementType = ${MET_NAMES[typeOf(vol.data)]}`,
      ...(labels === undefined ? [] : [`${LABELS_KEY} = ${labels}`]),
      'ElementDataFile = LOCAL',
    ].join('\n') + '\n';
  return concatBytes([asciiBytes(header), data]);
}
