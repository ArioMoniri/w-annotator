import { gzipSync } from 'fflate';
import { loadCodec } from './codecs';
import { readDicom, readDicomAsync, type CodecLoader } from './dicom';
import { isDicomSeg, readDicomSeg, writeDicomSeg, type DicomSegOptions } from './dicomseg';
import { isMetaImage, readMetaImage, writeMetaImage } from './metaimage';
import { fileKind } from './names';
import { isNifti, readNifti, writeNifti } from './nifti';
import { isNrrd, readNrrd, writeNrrd } from './nrrd';
import type { InputFile, VolumeData } from './types';
import { IoError, gunzip, isGzip } from './util';

export type { DicomSourceInfo, InputFile, ScalarArray, VolumeData } from './types';
export type { CodecLoader, FrameDecoder, FrameSpec } from './dicom';
export { isDicomSeg, readDicomSeg, writeDicomSeg, type DicomSegOptions, type SegSegment } from './dicomseg';
export { baseName, fileKind, type FileKind } from './names';
export { autoWindow, labelValues, resampleNearest, sameGrid, toLabelmap, toRenderable } from './ops';

const UNSUPPORTED = 'This file is not a supported image. Try NIfTI, MHA, NRRD or DICOM.';

/** Reads every format except DICOM. Undefined when the files are none of them. */
function readOther(files: InputFile[]): VolumeData | undefined {
  if (files.length === 0) throw new IoError('No file was given.');
  // 1. A header file recognised by its extension. Data-only files (.img, .raw, .zraw) never lead.
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (/\.(mha|mhd)$/.test(lower)) return readMetaImage(f, files);
    if (/\.(nrrd|nhdr)$/.test(lower)) return readNrrd(f, files);
    if (/\.(nii|nii\.gz|hdr)$/.test(lower)) return readNifti(f, files);
  }
  // 2. Otherwise look at the content.
  for (const f of files) {
    if (fileKind(f.name) === 'dicom') break;
    if (isNrrd(f.bytes)) return readNrrd(f, files);
    if (isMetaImage(f.bytes)) return readMetaImage(f, files);
    let bytes = f.bytes;
    if (isGzip(bytes)) {
      try {
        bytes = gunzip(bytes);
      } catch {
        continue;
      }
    }
    if (isNifti(bytes)) return readNifti({ name: f.name, bytes }, files);
  }
  // 3. A DICOM segmentation picked on its own is a labelmap. Next to an image series it is left aside.
  if (files.every(isDicomSeg)) return readDicomSeg(files[0]);
  return undefined;
}

function damaged(e: unknown): IoError {
  if (e instanceof IoError) return e;
  // Out-of-range reads and the like: the file ends early or its header lies.
  return new IoError('This file is incomplete or damaged and could not be read.');
}

/**
 * Reads one volume from the files the user picked: a single image file, a
 * header with its data file, the slices of one uncompressed DICOM series, or
 * a DICOM segmentation (as a labelmap on its own grid). Throws an Error whose
 * message can be shown to the user.
 */
export function readVolume(files: InputFile[]): VolumeData {
  try {
    // 4. Files that are nothing else may be the slices of a DICOM series (often without any extension).
    const vol = readOther(files) ?? readDicom(files);
    if (vol) return vol;
  } catch (e) {
    throw damaged(e);
  }
  throw new IoError(UNSUPPORTED);
}

export interface ReadOptions {
  /** Replaces the built-in decoders for compressed DICOM. Meant for tests. */
  loadCodec?: CodecLoader;
}

/**
 * Like `readVolume`, and also opens DICOM with compressed pixel data (RLE,
 * JPEG, JPEG-LS, JPEG 2000, HTJ2K). A decoder is loaded the first time a file
 * needs it, from the app's own files.
 */
export async function readVolumeAsync(files: InputFile[], options: ReadOptions = {}): Promise<VolumeData> {
  try {
    const vol = readOther(files) ?? (await readDicomAsync(files, options.loadCodec ?? loadCodec));
    if (vol) return vol;
  } catch (e) {
    throw damaged(e);
  }
  throw new IoError(UNSUPPORTED);
}

export type WriteFormat = 'nii.gz' | 'nii' | 'mha' | 'nrrd';

/** Encodes a volume. Geometry is converted from LPS to whatever the format expects. */
export function writeVolume(vol: VolumeData, format: WriteFormat): Uint8Array {
  switch (format) {
    case 'nii':
      return writeNifti(vol);
    case 'nii.gz':
      return gzipSync(writeNifti(vol), { level: 4, mtime: 0 });
    case 'mha':
      return writeMetaImage(vol);
    case 'nrrd':
      return writeNrrd(vol);
    default:
      throw new IoError(`Saving as "${String(format)}" is not supported.`);
  }
}

export type MaskFormat = WriteFormat | 'dcm';

/**
 * Encodes a mask like `writeVolume`, with one more format: 'dcm', a DICOM
 * Segmentation object. For 'dcm', `seg.segments` defaults to the mask's own
 * `labels` and `colors`; pass `seg.source` (the image's `dicom` field) when
 * the image came from DICOM so that the file references it.
 */
export function writeMask(mask: VolumeData, format: MaskFormat, seg: Partial<DicomSegOptions> = {}): Uint8Array {
  if (format !== 'dcm') return writeVolume(mask, format);
  const segments =
    seg.segments ??
    Object.entries(mask.labels ?? {}).map(([value, name]) => {
      const index = Number(value);
      const color = mask.colors?.[index];
      return color ? { index, name, color } : { index, name };
    });
  return writeDicomSeg(mask, { ...seg, segments });
}
