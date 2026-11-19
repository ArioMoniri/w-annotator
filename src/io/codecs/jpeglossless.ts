import { Decoder } from 'jpeg-lossless-decoder-js';
import type { FrameDecoder } from '../dicom';

/** JPEG Lossless (process 14) through the pure-JavaScript decoder Cornerstone uses. */
export async function load(): Promise<FrameDecoder> {
  return (encoded, frame) => {
    const out = new Decoder().decode(encoded.buffer as ArrayBuffer, encoded.byteOffset, encoded.byteLength, frame.bitsAllocated / 8);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength).slice();
  };
}
