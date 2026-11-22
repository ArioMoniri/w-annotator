/**
 * A dataset folder in the nnU-Net layout: images named `<case>_<channel>.ext`
 * (channel is four digits) in one or more image folders, and labels named
 * `<case>.ext` in a folder whose name starts with "labels". A case named
 * `<patient>_<scan>` is listed under its patient. Pure decisions on paths;
 * reading the files happens in `session.ts`.
 */

import { baseName, fileKind } from '../io/names';

export interface DatasetCase {
  /** The case name, e.g. `10000_0002`. */
  id: string;
  /** The part before the last `_<number>`, or the whole id when there is none. */
  patient: string;
  /** The number after the last `_`, or '' when there is none. */
  scan: string;
  /** Path of the first channel's image. */
  image: string;
  /** Path of the case's own label, when the labels folder has one. */
  label?: string;
  /** How many channels the case has; only the first is opened. */
  channels: number;
}

export interface DatasetPatient {
  id: string;
  /** Case ids in list order. */
  cases: string[];
}

export interface Dataset {
  /** The folder that holds the image and label folders. */
  name: string;
  cases: DatasetCase[];
  patients: DatasetPatient[];
}

/** Where a case starts: its own label, or the label of its patient's first scan that has one. */
export type StartFrom = 'own' | 'first';

const NO_CASES = 'No images named like nnU-Net cases (case_0000.nii.gz) were found in this folder.';
const CHANNEL = /^(.+)_(\d{4})$/;
const SCAN = /^(.+)_(\d+)$/;
const LABELS_DIR = /^labels/i;

const parts = (path: string) => path.split(/[\\/]/);
const isVolume = (path: string) => {
  const kind = fileKind(path);
  // `.img` and `.zraw` are data files of a header; the header stands for the volume.
  return (kind === 'nifti' || kind === 'metaimage' || kind === 'nrrd') && !/\.(img|img\.gz|zraw|raw)$/i.test(path);
};

/** Numbers compare by value, the rest as text, ignoring case. */
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

/** Reads the layout from the paths of every file in the folder. */
export function readLayout(paths: readonly string[]): Dataset | { error: string } {
  const images = new Map<string, { path: string; channel: string; channels: number; dir: string[] }>();
  const labels = new Map<string, string>();
  for (const path of paths) {
    if (!isVolume(path)) continue;
    const dirs = parts(path).slice(0, -1);
    const base = baseName(path);
    if (dirs.some((d) => LABELS_DIR.test(d))) {
      labels.set(base.toLowerCase(), path);
      continue;
    }
    const m = CHANNEL.exec(base);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const seen = images.get(key);
    if (!seen) images.set(key, { path, channel: m[2], channels: 1, dir: dirs });
    else {
      seen.channels++;
      if (m[2] < seen.channel) Object.assign(seen, { path, channel: m[2] });
    }
  }
  if (images.size === 0) return { error: NO_CASES };

  const cases: DatasetCase[] = [];
  for (const { path, channels } of images.values()) {
    const id = CHANNEL.exec(baseName(path))![1];
    const scan = SCAN.exec(id);
    const label = labels.get(id.toLowerCase());
    cases.push({ id, patient: scan ? scan[1] : id, scan: scan ? scan[2] : '', image: path, ...(label ? { label } : {}), channels });
  }
  cases.sort((a, b) => natural(a.patient, b.patient) || natural(a.scan, b.scan) || natural(a.id, b.id));

  const patients: DatasetPatient[] = [];
  for (const c of cases) {
    const last = patients[patients.length - 1];
    if (last && last.id === c.patient) last.cases.push(c.id);
    else patients.push({ id: c.patient, cases: [c.id] });
  }

  // The folder above the image folder, or the image folder itself at the top.
  const dir = images.values().next().value!.dir;
  const name = dir.length >= 2 ? dir[dir.length - 2] : (dir[0] ?? '');
  return { name, cases, patients };
}

/** The label a case starts from, or undefined for an empty mask. */
export function startLabel(ds: Dataset, c: DatasetCase, from: StartFrom): string | undefined {
  if (from === 'first') {
    const patient = ds.patients.find((p) => p.id === c.patient);
    for (const id of patient?.cases ?? []) {
      const label = ds.cases.find((x) => x.id === id)?.label;
      if (label) return label;
    }
  }
  return c.label;
}

/** The case `step` places after `id` in list order (the first one when `id` is null), or null past either end. */
export function caseAfter(ds: Dataset, id: string | null, step: 1 | -1): string | null {
  if (id === null) return ds.cases[0]?.id ?? null;
  const at = ds.cases.findIndex((c) => c.id === id);
  return ds.cases[at + step]?.id ?? null;
}
