import factory from '@cornerstonejs/codec-charls/decodewasmjs';
import wasmUrl from '@cornerstonejs/codec-charls/decodewasm?url';
import type { FrameDecoder } from '../dicom';
import { frameDecoder, instantiate } from './wasm';

/** JPEG-LS through CharLS. */
export async function load(): Promise<FrameDecoder> {
  return frameDecoder((await instantiate(factory, wasmUrl)).JpegLSDecoder);
}
