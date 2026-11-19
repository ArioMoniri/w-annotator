import factory from '@cornerstonejs/codec-openjph/wasmjs';
import wasmUrl from '@cornerstonejs/codec-openjph/wasm?url';
import type { FrameDecoder } from '../dicom';
import { frameDecoder, instantiate } from './wasm';

/** High-throughput JPEG 2000 through OpenJPH. */
export async function load(): Promise<FrameDecoder> {
  return frameDecoder((await instantiate(factory, wasmUrl)).HTJ2KDecoder);
}
