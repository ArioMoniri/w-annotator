import type { FrameDecoder } from '../dicom';

/**
 * DICOM RLE Lossless (PS3.5 annex G): a 64-byte header with the offsets of up
 * to 15 segments, each the PackBits-compressed plane of one byte of the pixel,
 * most significant byte first.
 */
export const decodeRle: FrameDecoder = (encoded, frame) => {
  const size = frame.bitsAllocated / 8;
  const count = frame.rows * frame.cols;
  if (encoded.length < 64) throw new Error('RLE header is cut off');
  const dv = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  if (dv.getUint32(0, true) !== size) throw new Error('RLE segment count does not match the pixel size');
  const out = new Uint8Array(count * size);
  for (let s = 0; s < size; s++) {
    let pos = dv.getUint32(4 + 4 * s, true);
    const end = s + 1 < size ? dv.getUint32(8 + 4 * s, true) : encoded.length;
    if (pos < 64 || end > encoded.length || pos > end) throw new Error('RLE segment lies outside the frame');
    // Little-endian output: the most significant plane lands on the last byte of each pixel.
    let o = size - 1 - s;
    const stop = out.length;
    while (o < stop) {
      if (pos >= end) throw new Error('RLE segment ends early');
      const n = encoded[pos++];
      if (n < 128) {
        // Literal run of n + 1 bytes.
        if (pos + n + 1 > end) throw new Error('RLE segment ends early');
        for (let i = 0; i <= n && o < stop; i++, o += size) out[o] = encoded[pos + i];
        pos += n + 1;
      } else if (n > 128) {
        // The next byte repeated 257 - n times.
        if (pos >= end) throw new Error('RLE segment ends early');
        const v = encoded[pos++];
        for (let i = 257 - n; i > 0 && o < stop; i--, o += size) out[o] = v;
      }
      // n === 128 does nothing.
    }
  }
  return out;
};
