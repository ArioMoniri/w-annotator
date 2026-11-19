import type { FrameDecoder } from '../dicom';

/** The decoder classes the Cornerstone codec builds expose through embind. */
export interface WasmDecoder {
  getEncodedBuffer(length: number): Uint8Array;
  decode(): void;
  getDecodedBuffer(): Uint8Array;
  delete(): void;
}
export type WasmCodec<Name extends string> = Record<Name, new () => WasmDecoder>;
export type WasmFactory<Name extends string> = (options?: {
  locateFile?: (file: string) => string;
  print?: (text: string) => void;
}) => Promise<WasmCodec<Name>>;

interface NodeLike {
  versions?: { node?: string };
  type?: string;
}

/**
 * Starts an Emscripten codec. In the app the .wasm file is an asset of the
 * build, served from the app's own origin at `wasmUrl`. Under Node (the unit
 * tests) the codec reads the .wasm that sits next to its script instead.
 */
export function instantiate<Name extends string>(factory: WasmFactory<Name>, wasmUrl: string): Promise<WasmCodec<Name>> {
  const proc = (globalThis as { process?: NodeLike }).process;
  const node = typeof proc?.versions?.node === 'string' && proc.type !== 'renderer';
  // The codecs log their progress for every frame: keep that out of the console. Errors still show.
  const print = () => {};
  return factory(node ? { print } : { print, locateFile: (file) => (file.endsWith('.wasm') ? wasmUrl : file) });
}

/** Wraps a codec's decoder class: copy the frame in, decode, copy the pixels out, free the instance. */
export function frameDecoder(Decoder: new () => WasmDecoder): FrameDecoder {
  return (encoded) => {
    const decoder = new Decoder();
    try {
      decoder.getEncodedBuffer(encoded.length).set(encoded);
      decoder.decode();
      // The buffer lives in the codec's memory and dies with the instance: copy it.
      return decoder.getDecodedBuffer().slice();
    } finally {
      decoder.delete();
    }
  };
}
