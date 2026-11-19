import factory from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import wasmUrl from '@cornerstonejs/codec-openjpeg/decodewasm?url';
import type { FrameDecoder } from '../dicom';
import { frameDecoder, instantiate } from './wasm';

/** JPEG 2000 through OpenJPEG. */
export async function load(): Promise<FrameDecoder> {
  return frameDecoder((await instantiate(factory, wasmUrl)).J2KDecoder);
}
