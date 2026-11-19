import { gzipSync } from 'fflate';
import { readDicom } from './dicom';
import { isMetaImage, readMetaImage, writeMetaImage } from './metaimage';
import { fileKind } from './names';
import { isNifti, readNifti, writeNifti } from './nifti';
import { isNrrd, readNrrd, writeNrrd } from './nrrd';
import type { InputFile, VolumeData } from './types';
import { IoError, gunzip, isGzip } from './util';

export type { InputFile, ScalarArray, VolumeData } from './types';
export { baseName, fileKind, type FileKind } from './names';
export { autoWindow, labelValues, resampleNearest, sameGrid, toLabelmap, toRenderable } from './ops';

const UNSUPPORTED = 'This file is not a supported image. Try NIfTI, MHA, NRRD or DICOM.';

function read(files: InputFile[]): VolumeData {
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
  // 3. Otherwise the files may be the slices of a DICOM series (often without any extension).
  const vol = readDicom(files);
  if (vol) return vol;
  throw new IoError(UNSUPPORTED);
}

/**
 * Reads one volume from the files the user picked: a single image file, a
 * header with its data file, or the slices of one DICOM series. Throws an
 * Error whose message can be shown to the user.
 */
export function readVolume(files: InputFile[]): VolumeData {
  try {
    return read(files);
  } catch (e) {
    if (e instanceof IoError) throw e;
    // Out-of-range reads and the like: the file ends early or its header lies.
    throw new IoError('This file is incomplete or damaged and could not be read.');
  }
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
