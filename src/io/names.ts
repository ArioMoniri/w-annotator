export type FileKind = 'nifti' | 'metaimage' | 'nrrd' | 'dicom' | 'unknown';

/** Known extensions, longest first so that `.seg.nrrd` wins over `.nrrd`. */
const EXTENSIONS: [string, FileKind][] = [
  ['.seg.nrrd', 'nrrd'],
  ['.nii.gz', 'nifti'],
  ['.img.gz', 'nifti'],
  ['.dicom', 'dicom'],
  ['.nrrd', 'nrrd'],
  ['.nhdr', 'nrrd'],
  ['.zraw', 'metaimage'],
  ['.nii', 'nifti'],
  ['.hdr', 'nifti'],
  ['.img', 'nifti'],
  ['.mha', 'metaimage'],
  ['.mhd', 'metaimage'],
  ['.dcm', 'dicom'],
  ['.ima', 'dicom'],
];

function knownExtension(name: string): [string, FileKind] | undefined {
  const lower = name.toLowerCase();
  return EXTENSIONS.find(([ext]) => lower.endsWith(ext));
}

/** The image format a file name suggests. Data-only files (`.img`, `.zraw`) count as their format. */
export function fileKind(name: string): FileKind {
  return knownExtension(name)?.[1] ?? 'unknown';
}

/** File name without its folder and without a known image extension. */
export function baseName(name: string): string {
  const file = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const ext = knownExtension(file);
  return ext ? file.slice(0, file.length - ext[0].length) : file;
}

/** Last path component, lower-cased: used to match a header's data file reference. */
export function leafName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
}
