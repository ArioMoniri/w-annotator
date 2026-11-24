import type { StartFrom } from './layout';

/** What is needed to open the same dataset again after a reload. */
export interface Resume {
  /** The dataset's name, to say which one to open again. */
  name: string;
  /** The dataset folder on this computer; null in a browser, which cannot open it again by itself. */
  root: string | null;
  /** The Save to folder on this computer, if one was chosen. */
  output: string | null;
  /** The case on screen. */
  case: string | null;
  start: StartFrom;
}

const OPEN_KEY = 'w-annotator:dataset';
const OUTPUTS_KEY = 'w-annotator:dataset-outputs';
/** Datasets whose Save to folder is remembered; the oldest is forgotten first. */
const OUTPUTS_MAX = 20;

function session(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const SEP = /[\\/]/;

/** The deepest folder that holds every path, written as they are. Null without paths. */
export function commonFolder(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const sep = paths[0].includes('\\') ? '\\' : '/';
  const split = paths.map((p) => p.split(SEP).slice(0, -1));
  const first = split[0];
  let n = 0;
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n++;
  return n === 0 ? null : first.slice(0, n).join(sep) || sep;
}

/** Remembers the open dataset for this window (it survives a reload, not a restart); null forgets it. */
export function saveResume(r: Resume | null, store: Storage | null = session()): void {
  try {
    if (r) store?.setItem(OPEN_KEY, JSON.stringify(r));
    else store?.removeItem(OPEN_KEY);
  } catch {
    // Without storage there is nothing to come back to; the dataset still works.
  }
}

export function loadResume(store: Storage | null = session()): Resume | null {
  try {
    const r = JSON.parse(store?.getItem(OPEN_KEY) ?? 'null') as Partial<Resume> | null;
    if (!r || typeof r.name !== 'string' || (r.start !== 'own' && r.start !== 'first')) return null;
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    return { name: r.name, root: text(r.root), output: text(r.output), case: text(r.case), start: r.start };
  } catch {
    return null;
  }
}

function outputs(store: Storage | null): [string, string][] {
  try {
    const list = JSON.parse(store?.getItem(OUTPUTS_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
  } catch {
    return [];
  }
}

/** The Save to folder last used for a dataset folder on this computer. */
export function outputFor(root: string, store: Storage | null = local()): string | null {
  return outputs(store).find(([r]) => r === root)?.[1] ?? null;
}

export function rememberOutputFor(root: string, output: string, store: Storage | null = local()): void {
  const list = [[root, output] as [string, string], ...outputs(store).filter(([r]) => r !== root)].slice(0, OUTPUTS_MAX);
  try {
    store?.setItem(OUTPUTS_KEY, JSON.stringify(list));
  } catch {
    // Only a convenience: the folder is asked for again.
  }
}

/**
 * After a reload, opens the dataset that was open, with its Save to folder and
 * case. Only folders picked earlier in this run of the desktop app can be
 * reopened; otherwise it says to open the folder again.
 */
export async function resumeDataset<F, O>(deps: {
  store?: Storage | null;
  reopenFolder: (path: string) => Promise<F[] | null>;
  reopenOutput: (path: string) => Promise<O | null>;
  open: (files: F[], r: { output: O | null; case: string | null; start: StartFrom }) => Promise<void>;
  say: (text: string) => void;
}): Promise<void> {
  const store = deps.store === undefined ? session() : deps.store;
  const r = loadResume(store);
  if (!r) return;
  const files = r.root ? await deps.reopenFolder(r.root) : null;
  if (!files) {
    saveResume(null, store);
    deps.say(`Open the dataset folder again to carry on with ${r.name}.`);
    return;
  }
  const output = r.output ? await deps.reopenOutput(r.output) : null;
  await deps.open(files, { output, case: r.case, start: r.start });
}
