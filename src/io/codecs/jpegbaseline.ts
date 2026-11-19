import factory from '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs';
import wasmUrl from '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm?url';
import type { FrameDecoder } from '../dicom';
import { frameDecoder, instantiate } from './wasm';

/** JPEG Baseline (8-bit, lossy) through libjpeg-turbo. */
export async function load(): Promise<FrameDecoder> {
  return frameDecoder((await instantiate(factory, wasmUrl)).JPEGDecoder);
}
