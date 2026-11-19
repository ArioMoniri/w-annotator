export type ScalarArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

/**
 * A 3D volume in LPS world space (the DICOM / ITK convention).
 * `direction` holds the world direction of the i, j and k voxel axes,
 * one after the other: [ix,iy,iz, jx,jy,jz, kx,ky,kz].
 */
export interface VolumeData {
  name: string;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[];
  data: ScalarArray;
  /** Segment names keyed by label value, when the file carries them. */
  labels?: Record<number, string>;
  /** Segment display colours (sRGB, 0-255) keyed by label value, when the file carries them (DICOM SEG). */
  colors?: Record<number, [number, number, number]>;
  /** For a volume read from a DICOM series: what a DICOM SEG saved for it must copy and reference. */
  dicom?: DicomSourceInfo;
  /** Things the reader had to decide that the user may want to know, in plain sentences. */
  warnings?: string[];
}

/**
 * Identity of the DICOM series a volume was read from. Text values are the
 * file's bytes read as Latin-1, to be written back unchanged together with
 * `specificCharacterSet`. It holds patient details: keep it on this machine.
 */
export interface DicomSourceInfo {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameOfReferenceUID?: string;
  specificCharacterSet?: string;
  patientName?: string;
  patientID?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyTime?: string;
  studyID?: string;
  studyDescription?: string;
  accessionNumber?: string;
  referringPhysicianName?: string;
  /** One entry per slice, in the order of the volume's k axis. `frame` (1-based) is set for multi-frame files. */
  instances: { sopClassUID: string; sopInstanceUID: string; frame?: number }[];
}

/** A file picked by the user: its name (a path is fine) and its content. */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
  /** Where the file is on disk, when the desktop app was given its path. Never leaves this machine. */
  path?: string;
}
