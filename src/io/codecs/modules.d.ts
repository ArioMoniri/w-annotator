// The codec packages ship no type declarations.
declare module '@cornerstonejs/codec-charls/decodewasmjs' {
  const factory: import('./wasm').WasmFactory<'JpegLSDecoder'>;
  export default factory;
}
declare module '@cornerstonejs/codec-openjpeg/decodewasmjs' {
  const factory: import('./wasm').WasmFactory<'J2KDecoder'>;
  export default factory;
}
declare module '@cornerstonejs/codec-openjph/wasmjs' {
  const factory: import('./wasm').WasmFactory<'HTJ2KDecoder'>;
  export default factory;
}
declare module '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs' {
  const factory: import('./wasm').WasmFactory<'JPEGDecoder'>;
  export default factory;
}
// Full builds with the encoders: used by the tests only.
declare module '@cornerstonejs/codec-charls/wasmjs' {
  const factory: () => Promise<unknown>;
  export default factory;
}
declare module '@cornerstonejs/codec-openjpeg/wasmjs' {
  const factory: () => Promise<unknown>;
  export default factory;
}
declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    decode(buffer: ArrayBuffer, offset: number, length: number, bytesPerComponent?: number): Uint8Array | Uint16Array;
  }
}
