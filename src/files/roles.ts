/**
 * Which of the files being opened is the image and which are masks, and what
 * the drop overlay should say before they are let go. Pure decisions: reading
 * and showing the files happens in `session.ts`.
 */

import { fileKind } from '../io/names';

/** A file name that says "this is a mask". */
const MASK_NAME = /seg|mask|label/i;
/** Data files that belong to a header (`.mhd` + `.raw`); they never decide anything. */
const COMPANION = /\.(raw|zraw|img|img\.gz|raw\.gz)$/i;

const leaf = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);

export function namedLikeMask(name: string): boolean {
  return MASK_NAME.test(leaf(name));
}

/** How far the voxel values of a volume look like labels. */
export type LabelLook =
  /** Whole numbers from 0 to 255, and only a few different ones: almost surely a mask. */
  | 'labels'
  /** Whole numbers from 0 to 255, many different ones: a mask with many segments, or an 8-bit image. */
  | 'maybe'
  /** Anything else: an image. */
  | 'image';

/** Looks at a sample of the voxels, so it is quick on any size. */
export function labelLook(data: ArrayLike<number>): LabelLook {
  const step = Math.max(1, Math.floor(data.length / 50000));
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v < 0 || v > 255 || !Number.isInteger(v)) return 'image';
    seen.add(v);
  }
  return seen.size <= 64 ? 'labels' : 'maybe';
}

export type DropHint = 'open' | 'mask' | 'replace' | 'add';

/** What the overlay says while files are held over the window (DESIGN.md 6.7). */
export const DROP_TEXT: Record<DropHint, string> = {
  open: 'Drop to open',
  mask: 'Drop to add as mask',
  replace: 'Drop to replace image',
  add: 'Drop to add',
};

/**
 * What a drop will do, from the file names alone. A browser does not tell the
 * names before the drop (`names` is null), and a folder or a DICOM file may be
 * either an image or a mask, so those get the neutral "add".
 */
export function dropHint(names: readonly string[] | null, hasImage: boolean): DropHint {
  if (!hasImage) return 'open';
  const files = (names ?? []).filter((n) => !COMPANION.test(n));
  if (files.length === 0) return 'add';
  const known = files.every((n) => {
    const kind = fileKind(n);
    return kind === 'nifti' || kind === 'metaimage' || kind === 'nrrd';
  });
  if (!known) return files.every(namedLikeMask) ? 'mask' : 'add';
  return files.every(namedLikeMask) ? 'mask' : 'replace';
}

/** One volume that has been read, as far as choosing its role needs to know. */
export interface Candidate {
  name: string;
  look: LabelLook;
}

export interface Roles {
  /** Index of the volume to show as the image, if any. */
  image: number | null;
  /** Indices of the volumes to add as masks, in the order given. */
  masks: number[];
  /** Indices left out: more than one image was given. */
  extra: number[];
}

/** A volume that is surely a mask: its values are labels, or its name says so and its values allow it. */
const isMask = (c: Candidate) => c.look === 'labels' || (c.look === 'maybe' && namedLikeMask(c.name));

/**
 * Sorts volumes opened together into one image and any number of masks.
 *
 * - `role` is set when the user said what they are opening (Open image, Open mask).
 * - With several volumes, the ones named like a mask are masks; without such
 *   names, the ones whose values are labels. The first of the rest is the image.
 * - A single volume is a mask when an image is open and it looks like one.
 */
export function assignRoles(list: readonly Candidate[], opts: { role?: 'image' | 'mask'; hasImage: boolean }): Roles {
  const all = list.map((_, i) => i);
  if (list.length === 0) return { image: null, masks: [], extra: [] };
  if (opts.role === 'mask') return { image: null, masks: all, extra: [] };
  if (list.length === 1) {
    if (opts.role !== 'image' && opts.hasImage && isMask(list[0])) return { image: null, masks: [0], extra: [] };
    return { image: 0, masks: [], extra: [] };
  }

  const named = all.filter((i) => namedLikeMask(list[i].name) && list[i].look !== 'image');
  let masks = named.length > 0 ? named : all.filter((i) => list[i].look === 'labels');
  let images = all.filter((i) => !masks.includes(i));
  if (images.length === 0 && !opts.hasImage) {
    // Nothing is open and everything looks like labels: one of them has to be the image.
    const pick = [...masks].reverse().find((i) => !namedLikeMask(list[i].name));
    if (pick !== undefined) {
      images = [pick];
      masks = masks.filter((i) => i !== pick);
    }
  }
  return { image: images[0] ?? null, masks, extra: images.slice(1) };
}
