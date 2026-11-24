/**
 * Which cases of a dataset have been handled, kept as a small JSON file in the
 * output folder next to the saved masks, so work can stop and start again and
 * whoever receives the folder sees what was looked at.
 */

import type { Dataset, StartFrom } from './layout';

export const PROGRESS_FILE = 'w-annotator-progress.json';

export type CaseStatus = 'done' | 'skipped';

export interface CaseProgress {
  status: CaseStatus;
  /** When it was marked, as an ISO 8601 time. */
  at: string;
  /** Done only: the saved mask differs from the one the case started from. */
  changed?: boolean;
  /** Done only: what the case started from. */
  start?: StartFrom | 'empty';
}

export interface Progress {
  version: 1;
  /** The dataset folder's name. */
  dataset: string;
  cases: Record<string, CaseProgress>;
}

export function emptyProgress(dataset: string): Progress {
  return { version: 1, dataset, cases: {} };
}

const STATUSES = new Set(['done', 'skipped']);
const STARTS = new Set(['own', 'first', 'empty']);

/** Reads the file's text. Anything damaged or not ours reads as no progress; entries not understood are dropped. */
export function parseProgress(text: string): Progress {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return emptyProgress('');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return emptyProgress('');
  const top = doc as Record<string, unknown>;
  if (top.version !== 1 || typeof top.cases !== 'object' || top.cases === null) return emptyProgress('');
  const out = emptyProgress(typeof top.dataset === 'string' ? top.dataset : '');
  for (const [id, raw] of Object.entries(top.cases as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.status !== 'string' || !STATUSES.has(e.status) || typeof e.at !== 'string') continue;
    const entry: CaseProgress = { status: e.status as CaseStatus, at: e.at };
    if (typeof e.changed === 'boolean') entry.changed = e.changed;
    if (typeof e.start === 'string' && STARTS.has(e.start)) entry.start = e.start as CaseProgress['start'];
    out.cases[id] = entry;
  }
  return out;
}

/** The file's text: cases sorted by name, two-space indent, a final newline. */
export function serialiseProgress(p: Progress): string {
  const cases: Record<string, CaseProgress> = {};
  for (const id of Object.keys(p.cases).sort()) cases[id] = p.cases[id];
  return `${JSON.stringify({ version: p.version, dataset: p.dataset, cases }, null, 2)}\n`;
}

/** A copy of `p` with `id` marked. */
export function mark(p: Progress, id: string, entry: CaseProgress): Progress {
  return { ...p, cases: { ...p.cases, [id]: entry } };
}

/** The first case without a status after `from` in list order, going round to the start; null when all are handled. */
export function nextToDo(ds: Dataset, p: Progress, from: string | null): string | null {
  const n = ds.cases.length;
  const at = from === null ? -1 : ds.cases.findIndex((c) => c.id === from);
  for (let k = 1; k <= n; k++) {
    const c = ds.cases[(at + k + n) % n];
    if (!p.cases[c.id]) return c.id;
  }
  return null;
}

export function tally(ds: Dataset, p: Progress): { done: number; skipped: number; left: number } {
  let done = 0;
  let skipped = 0;
  for (const c of ds.cases) {
    const s = p.cases[c.id]?.status;
    if (s === 'done') done++;
    else if (s === 'skipped') skipped++;
  }
  return { done, skipped, left: ds.cases.length - done - skipped };
}
