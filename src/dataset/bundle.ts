/**
 * One zip of a dataset's output folder, to attach to an email: the mask of
 * every done case and the progress file, in a folder named like the output
 * folder. The app only makes the file; sending it is up to the person.
 */

import { deflateSync, zipSync, type Zippable } from 'fflate';
import { maskName, type Dataset } from './layout';
import type { CaseProgress } from './progress';

/** What most email services accept as attachments, with room for the encoding that mail adds. */
export const EMAIL_LIMIT = 14 * 1024 * 1024;

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `<folder>-<yyyy-mm-dd>.zip`, in local time. */
export function bundleName(folder: string, day: Date): string {
  return `${folder}-${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}.zip`;
}

/** File names of the masks saved for done cases, in case order. */
export function bundleMasks(ds: Dataset, progress: Record<string, CaseProgress>): string[] {
  return ds.cases.filter((c) => progress[c.id]?.status === 'done').map(maskName);
}

/**
 * Zips the files into `<folder>/`. A file that does not get smaller (most
 * masks are compressed already) is stored as it is.
 */
export function packBundle(folder: string, files: readonly BundleFile[]): Uint8Array {
  const entries: Zippable = {};
  for (const f of files) {
    const smaller = deflateSync(f.bytes, { level: 6 }).length < f.bytes.length * 0.95;
    entries[`${folder}/${f.name}`] = [f.bytes, { level: smaller ? 6 : 0 }];
  }
  return zipSync(entries);
}

/** Whole kilobytes below a megabyte, one decimal above. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const fitsEmail = (bytes: number): boolean => bytes <= EMAIL_LIMIT;
