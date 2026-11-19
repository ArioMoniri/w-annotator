/**
 * Autosave and crash recovery, wired to the session. The rules live in
 * `../mask/recovery.ts`; this file connects them to the mask on screen, the
 * `autosave` setting, the window and the place copies are kept.
 */

import { gunzip, gzip, gzipSync } from 'fflate';
import { create } from 'zustand';
import {
  Autosaver,
  decodeRecovery,
  differsFromMask,
  fingerprint,
  pruneStore,
  type RecoveryHeader,
  type RecoverySnapshot,
  type RecoveryStore,
  type StoredCopy,
} from '../mask/recovery';
import { isTauri } from '../platform';
import * as session from '../session';
import { getSettings, useSettings } from '../state/settings';
import { get, toast } from '../state/store';
import { IdbRecoveryStore } from './idb';
import { TauriRecoveryStore } from './tauri';

interface RecoveryState {
  /** When the last recovery copy of the mask on screen was written. */
  savedAt: number | null;
  /** A copy found for the image on screen, waiting for Restore or Discard. */
  offer: { savedAt: number } | null;
  /** Copies on this device, shown when nothing is open. */
  waiting: StoredCopy[];
}

export const useRecovery = create<RecoveryState>(() => ({ savedAt: null, offer: null, waiting: [] }));

const store: RecoveryStore = isTauri ? new TauriRecoveryStore() : new IdbRecoveryStore();

/** How long the last copy took, for measuring. Times in milliseconds, size in bytes. */
export const lastTiming = { copy: 0, compress: 0, write: 0, bytes: 0 };

const gzipOffThread = (data: Uint8Array) =>
  // `consume` hands the buffer to the worker instead of copying it a second time.
  new Promise<Uint8Array>((resolve, reject) => gzip(data, { level: 1, consume: true }, (err, out) => (err ? reject(err) : resolve(out))));
const gunzipOffThread = (data: Uint8Array) =>
  new Promise<Uint8Array>((resolve, reject) => gunzip(data, (err, out) => (err ? reject(err) : resolve(out))));

/* Fingerprinting reads a few thousand voxels; still, once per image is enough. */
const keys = new WeakMap<object, string>();
function imageKey(): string | null {
  const image = session.getImage();
  if (!image) return null;
  let key = keys.get(image);
  if (!key) keys.set(image, (key = fingerprint(image)));
  return key;
}

/* Desktop app: where files opened with the app came from, so a copy can offer to reopen its image. */
const imagePaths = new Map<string, string>();
export function noteImagePaths(files: { name: string; path?: string }[]): void {
  for (const f of files) if (f.path) imagePaths.set(f.name, f.path);
}

function snapshot(): RecoverySnapshot | null {
  const s = get();
  const mask = session.getMask();
  const key = imageKey();
  if (!mask || !key || !s.dirty) return null;
  const started = performance.now();
  const copy = (mask.data as Uint8Array).slice();
  lastTiming.copy = performance.now() - started;
  return {
    key,
    mask: copy,
    dims: mask.dims,
    maskName: s.maskName,
    segments: s.segments.map(({ index, name, color, locked }) => ({ index, name, color, locked })),
    imagePath: s.image ? imagePaths.get(s.image.name) : undefined,
  };
}

let warned = false;

const saver = new Autosaver({
  store: {
    get:(key) => store.get(key),
    list: () => store.list(),
    delete: (key) => store.delete(key),
    put: async (key, bytes, info) => {
      const started = performance.now();
      await store.put(key, bytes, info);
      lastTiming.write = performance.now() - started;
      lastTiming.bytes = bytes.length;
    },
  },
  snapshot,
  busy: session.isPointerDown,
  compress: async (data) => {
    const started = performance.now();
    const out = await gzipOffThread(data);
    lastTiming.compress = performance.now() - started;
    return out;
  },
  onSaved: (at) => {
    // Only for the image still on screen, and only while its edits are unsaved.
    if (get().dirty) useRecovery.setState({ savedAt: at });
  },
  onError: () => {
    if (warned) return;
    warned = true;
    toast('warning', "Couldn't keep a recovery copy on this device. Save the mask to a file to keep your edits.");
  },
});

/* Store work runs one after another, so a delete never overtakes the write before it. */
let chain: Promise<unknown> = Promise.resolve();
function queue<T>(work: () => Promise<T>): Promise<T | undefined> {
  const next = chain.then(work).catch(() => undefined);
  chain = next;
  return next;
}

/** Resolves when every write and delete asked for so far has finished. */
export const settled = (): Promise<unknown> => chain;

/** The copies on this device. */
export const copies = (): Promise<StoredCopy[]> => store.list();

async function refreshWaiting(): Promise<void> {
  if (!getSettings().autosave) return void useRecovery.setState({ waiting: [] });
  await pruneStore(store, Date.now());
  useRecovery.setState({ waiting: await store.list() });
}

/* ───────────────────────── a copy found for the image on screen ───────────────────────── */

let found: { key: string; header: RecoveryHeader; gz: Uint8Array } | null = null;
let checks = 0;

function clearOffer(): void {
  checks++;
  found = null;
  useRecovery.setState({ offer: null });
  saver.resume();
}

async function lookForCopy(): Promise<void> {
  clearOffer();
  const check = checks;
  const key = imageKey();
  const mask = session.getMask();
  if (!key || !mask || !getSettings().autosave) return;
  try {
    const bytes = await store.get(key);
    if (!bytes || check !== checks) return;
    const { header, gz } = decodeRecovery(bytes);
    if (!header.dims.every((n, i) => n === mask.dims[i])) return;
    const data = await gunzipOffThread(gz.slice());
    if (check !== checks || session.getMask() !== mask) return;
    if (!differsFromMask({ data, segments: header.segments }, { data: mask.data as Uint8Array, segments: get().segments })) return;
    found = { key, header, gz };
    // Until the user answers, nothing is written over the copy that was found.
    saver.pause();
    useRecovery.setState({ offer: { savedAt: header.savedAt } });
  } catch {
    /* an unreadable copy is not offered */
  }
}

export async function restore(): Promise<void> {
  const copy = found;
  if (!copy) return;
  try {
    const data = await gunzipOffThread(copy.gz.slice());
    if (found !== copy) return;
    if (!session.restoreMask(data, copy.header.segments, copy.header.maskName)) throw new Error('size');
    clearOffer();
    // The restored edits are unsaved again, and are kept as a fresh copy.
    saver.noteEdit();
  } catch {
    toast('error', "Couldn't restore the recovered edits. The recovery copy may be damaged.");
  }
}

export function discard(): void {
  const copy = found;
  if (!copy) return;
  clearOffer();
  void queue(() => store.delete(copy.key));
  if (get().dirty) saver.noteEdit();
}

/** Desktop app: open the image a waiting copy belongs to. */
export async function openWaitingImage(copy: StoredCopy): Promise<void> {
  if (!(store instanceof TauriRecoveryStore) || !copy.imageName) return;
  try {
    const bytes = await store.image(copy.key);
    await session.openFiles([{ name: copy.imageName, bytes }], 'image');
  } catch (err) {
    toast('error', typeof err === 'string' ? err : `Can't open ${copy.imageName}. Open it from where it is now.`);
    void queue(refreshWaiting);
  }
}

/* ───────────────────────── wiring ───────────────────────── */

function forgetCurrent(): void {
  useRecovery.setState({ savedAt: null });
  const key = imageKey();
  // A found copy that is still waiting for an answer is not ours to remove.
  if (key && !found) wait(saver.forget(key));
}

/** The saver stops at once; later store work waits until its deletes are done. */
function wait(work: Promise<void>): void {
  void queue(() => work);
}

/** Start autosave. Returns a function that stops it. */
export function startRecovery(): () => void {
  // Off means no copies on this device, also when it was switched off elsewhere.
  if (!getSettings().autosave) wait(saver.turnOff());
  void queue(refreshWaiting);

  const offSession = session.onSessionEvent((event) => {
    switch (event) {
      case 'edit':
        saver.noteEdit();
        break;
      case 'opened':
        useRecovery.setState({ savedAt: null });
        void lookForCopy();
        break;
      case 'saved':
      case 'discarded':
        forgetCurrent();
        break;
      case 'closed':
        saver.stop();
        clearOffer();
        useRecovery.setState({ savedAt: null });
        void queue(refreshWaiting);
        break;
    }
  });

  const offSettings = useSettings.subscribe((now, before) => {
    if (now.autosave === before.autosave) return;
    if (now.autosave) {
      saver.turnOn();
      if (get().dirty) saver.noteEdit();
      void queue(refreshWaiting);
      return;
    }
    clearOffer();
    useRecovery.setState({ savedAt: null, waiting: [] });
    wait(saver.turnOff());
    toast('info', 'Autosave is off. Recovery copies were removed.');
  });

  const flush = () => void saver.flush();
  const hidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  // The page may be gone before a worker answers, so compress here and now.
  const leaving = () => void saver.flush(async (data) => gzipSync(data, { level: 1 }));
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leaving);
  window.addEventListener('beforeunload', leaving);

  return () => {
    offSession();
    offSettings();
    saver.stop();
    window.removeEventListener('blur', flush);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', leaving);
    window.removeEventListener('beforeunload', leaving);
  };
}
