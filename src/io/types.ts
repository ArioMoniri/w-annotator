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
}

/** A file picked by the user: its name (a path is fine) and its content. */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
}
