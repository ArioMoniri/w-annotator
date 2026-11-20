/**
 * A small synthetic image and mask, written by hand so the tests do not lean
 * on the app's own writers: a MetaImage volume (.mha, int16) and a gzipped
 * NIfTI-1 mask (.nii.gz, uint8) with two labels on the same grid.
 * Also a minimal NIfTI-1 reader to check what the app saved.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const N = 48;

/** The same phantom as e2e/helpers.ts: a bright ball with two small labelled balls inside. */
export function phantom() {
  const image = new Int16Array(N * N * N);
  const mask = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = z * N * N + y * N + x;
        const r = Math.hypot(x - 24, y - 24, z - 24);
        image[i] = r < 20 ? Math.round(300 - r * 8) : -1000;
        if (Math.hypot(x - 30, y - 22, z - 24) < 5) mask[i] = 1;
        if (Math.hypot(x - 17, y - 27, z - 23) < 4) mask[i] = 2;
      }
  return { image, mask };
}

export function count(data, label) {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (label === undefined ? data[i] !== 0 : data[i] === label) n++;
  return n;
}

function mha(image) {
  const header = [
    'ObjectType = Image',
    'NDims = 3',
    'BinaryData = True',
    'BinaryDataByteOrderMSB = False',
    'CompressedData = False',
    'TransformMatrix = 1 0 0 0 1 0 0 0 1',
    'Offset = 0 0 0',
    'CenterOfRotation = 0 0 0',
    'AnatomicalOrientation = RAI',
    'ElementSpacing = 1 1 1',
    `DimSize = ${N} ${N} ${N}`,
    'ElementType = MET_SHORT',
    'ElementDataFile = LOCAL',
    '',
  ].join('\n');
  const data = Buffer.alloc(image.length * 2);
  for (let i = 0; i < image.length; i++) data.writeInt16LE(image[i], i * 2);
  return Buffer.concat([Buffer.from(header, 'latin1'), data]);
}

function nifti(mask) {
  const buf = Buffer.alloc(352 + mask.length);
  buf.writeInt32LE(348, 0);
  buf.writeInt16LE(3, 40);
  [N, N, N].forEach((d, i) => buf.writeInt16LE(d, 42 + i * 2));
  buf.writeInt16LE(2, 70); // uint8
  buf.writeInt16LE(8, 72);
  buf.writeFloatLE(1, 76);
  [1, 1, 1].forEach((s, i) => buf.writeFloatLE(s, 80 + i * 4));
  buf.writeFloatLE(352, 108);
  buf.writeFloatLE(1, 112);
  buf.writeInt16LE(1, 254); // sform_code
  // MetaImage is LPS and NIfTI is RAS, so the same grid has x and y negated here.
  [
    [-1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, 1, 0],
  ].forEach((row, r) => row.forEach((v, c) => buf.writeFloatLE(v, 280 + r * 16 + c * 4)));
  buf.write('n+1\0', 344, 'latin1');
  Buffer.from(mask.buffer, mask.byteOffset, mask.length).copy(buf, 352);
  return gzipSync(buf);
}

/** Writes the image and the mask into `dir` and returns their paths and contents. */
export function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const { image, mask } = phantom();
  const imagePath = join(dir, 'phantom_ct.mha');
  const maskPath = join(dir, 'phantom_seg.nii.gz');
  writeFileSync(imagePath, mha(image));
  writeFileSync(maskPath, nifti(mask));
  return { imagePath, maskPath, image, mask };
}

/** Reads a NIfTI-1 file (gzipped or not) far enough to check a saved mask. */
export function readNifti(path) {
  let buf = readFileSync(path);
  const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
  if (gzipped) buf = gunzipSync(buf);
  const voxOffset = buf.readFloatLE(108);
  const dims = [buf.readInt16LE(42), buf.readInt16LE(44), buf.readInt16LE(46)];
  const total = dims[0] * dims[1] * dims[2];
  return {
    gzipped,
    headerSize: buf.readInt32LE(0),
    magic: buf.toString('latin1', 344, 347),
    ndim: buf.readInt16LE(40),
    dims,
    datatype: buf.readInt16LE(70),
    bitpix: buf.readInt16LE(72),
    spacing: [buf.readFloatLE(80), buf.readFloatLE(84), buf.readFloatLE(88)],
    voxOffset,
    data: new Uint8Array(buf.buffer, buf.byteOffset + voxOffset, total),
    bytesAfterHeader: buf.length - voxOffset,
  };
}
