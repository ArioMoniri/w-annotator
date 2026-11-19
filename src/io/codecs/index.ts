import type { CodecLoader, FrameDecoder } from '../dicom';
import { IoError } from '../util';
import { decodeRle } from './rle';

type Family = 'jpegbaseline' | 'jpeglossless' | 'jpegls' | 'jpeg2000' | 'htj2k';

const FAMILIES: Record<string, Family> = {
  '1.2.840.10008.1.2.4.50': 'jpegbaseline',
  '1.2.840.10008.1.2.4.57': 'jpeglossless',
  '1.2.840.10008.1.2.4.70': 'jpeglossless',
  '1.2.840.10008.1.2.4.80': 'jpegls',
  '1.2.840.10008.1.2.4.81': 'jpegls',
  '1.2.840.10008.1.2.4.90': 'jpeg2000',
  '1.2.840.10008.1.2.4.91': 'jpeg2000',
  '1.2.840.10008.1.2.4.201': 'htj2k',
  '1.2.840.10008.1.2.4.202': 'htj2k',
  '1.2.840.10008.1.2.4.203': 'htj2k',
};

// Each codec is its own chunk of the build, fetched only when a file needs it.
const IMPORTS: Record<Family, () => Promise<{ load(): Promise<FrameDecoder> }>> = {
  jpegbaseline: () => import('./jpegbaseline'),
  jpeglossless: () => import('./jpeglossless'),
  jpegls: () => import('./jpegls'),
  jpeg2000: () => import('./jpeg2000'),
  htj2k: () => import('./htj2k'),
};

const started = new Map<Family, Promise<FrameDecoder>>();

function start(family: Family): Promise<FrameDecoder> {
  let codec = started.get(family);
  if (!codec) {
    codec = IMPORTS[family]().then((m) => m.load());
    started.set(family, codec);
    // A failed load (say, the file could not be fetched) may work when tried again.
    codec.catch(() => started.delete(family));
  }
  return codec;
}

/** The decoders built into the app. RLE is plain TypeScript; the others load on first use. */
export const loadCodec: CodecLoader = async (transferSyntax) => {
  if (transferSyntax === '1.2.840.10008.1.2.5') return decodeRle;
  const family = FAMILIES[transferSyntax];
  if (!family) {
    throw new IoError(`This DICOM file uses a compression that cannot be opened (${transferSyntax}). Convert the series to NIfTI first.`);
  }
  const decode = await start(family);
  return async (encoded, frame) => {
    try {
      return await decode(encoded, frame);
    } catch (e) {
      // A codec that aborted is unusable: start a fresh one for the next file.
      started.delete(family);
      throw e;
    }
  };
};
