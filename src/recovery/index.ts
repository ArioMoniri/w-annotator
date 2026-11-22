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
import { decodeConflicts, encodeConflicts } from '../mask/review';
import { isTauri } from '../platform';
import * as session from '../session';
import { getSettings, useSettings } from '../state/settings';
import { get, toast } from '../state/store';
import { IdbRecoveryStore } from './idb';
import {
  decodeRoomCopy,
  encodeRoomCopy,
  isRoomCopyKey,
  maskHash,
  roomCopyExpired,
  roomCopyFits,
  roomCopyKey,
  shouldKeepRoomCopy,
  type RoomCopyHeader,
  ROOM_COPY_KEEP_MS,
} from './roomcopy';
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

/** Everything kept on this device: recovery copies, and what shared-copy rooms left (`roomcopy.ts`). */
const all: RecoveryStore = isTauri ? new TauriRecoveryStore() : new IdbRecoveryStore();

/** The recovery copies alone: listing, pruning and "recovered work is available" never count a room copy. */
const store: RecoveryStore = {
  put: (key, bytes, info) => all.put(key, bytes, info),
  get: (key) => all.get(key),
  delete: (key) => all.delete(key),
  list: async () => (await all.list()).filter((copy) => !isRoomCopyKey(copy.key)),
};

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
  // A guest of a view-through-host room keeps nothing on this device.
  if (!mask || !key || !s.dirty || session.isGuestView()) return null;
  const started = performance.now();
  const copy = (mask.data as Uint8Array).slice();
  lastTiming.copy = performance.now() - started;
  // What a room left to merge against is only right for this exact mask, so it is taken at the same moment.
  withMask = { key, room: captureRoomCopy(key, copy) };
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
      const taken = withMask;
      withMask = null;
      // Both are started at once: when the page is going away there may be no later.
      const room = taken?.key === key ? storeRoomCopy(key, taken.room) : null;
      await store.put(key, bytes, info);
      lastTiming.write = performance.now() - started;
      lastTiming.bytes = bytes.length;
      await room;
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

/* ───────────────────────── what a shared-copy room leaves to come back to ───────────────────────── */

interface Captured {
  header: Omit<RoomCopyHeader, 'base' | 'review'>;
  base: Uint8Array | null;
  review: { at: number; bytes: Uint8Array } | null;
}

/** What the room copy taken with a recovery copy of the mask is, until that copy is written. */
let withMask: { key: string; room: Captured | null } | null = null;

const mayKeepRoomCopy = () => shouldKeepRoomCopy({ autosave: getSettings().autosave, guestView: session.isGuestView() });

/** The room copy for the mask as it is in `data`, which is the mask on screen or a copy just made of it. */
function captureRoomCopy(key: string, data: Uint8Array): Captured | null {
  const mask = session.getMask();
  const copy = mayKeepRoomCopy() ? session.roomCopy() : null;
  if (!mask || !copy) return null;
  return {
    header: { v: 1, key, room: copy.room, session: copy.session, head: copy.head, dims: mask.dims, mine: maskHash(data), offlineSegs: copy.offlineSegs, guard: copy.guard, savedAt: Date.now() },
    base: copy.base,
    review: copy.review ? { at: copy.review.at, bytes: encodeConflicts(copy.review.conflicts) } : null,
  };
}

/** Writes it, or removes the one that is there when there is nothing to keep any more. */
async function storeRoomCopy(imageKey: string, captured: Captured | null): Promise<void> {
  const key = roomCopyKey(imageKey);
  try {
    if (!captured) return await all.delete(key);
    // The page may be gone before a worker answers, so on the way out it is compressed here and now.
    const pack = leaving ? async (data: Uint8Array) => gzipSync(data, { level: 1 }) : gzipOffThread;
    const base = captured.base ? await pack(captured.base) : null;
    const review = captured.review ? await pack(captured.review.bytes) : null;
    const header: RoomCopyHeader = { ...captured.header, base: base?.length ?? 0, review: captured.review && review ? { at: captured.review.at, bytes: review.length } : null };
    await all.put(key, encodeRoomCopy(header, base, review), { savedAt: header.savedAt });
  } catch {
    /* without it, coming back is merged two-way, as before */
  }
}

/** For the mask on screen as it is now: when it was just saved to a file, or has no unsaved edits. */
function keepRoomCopyNow(): void {
  const key = imageKey();
  const mask = session.getMask();
  if (!key || !mask) return;
  const captured = captureRoomCopy(key, mask.data as Uint8Array);
  void queue(() => storeRoomCopy(key, captured));
}

/** True from the moment the page starts to go away. */
let leaving = false;

let roomChecks = 0;

/** Takes up a room copy written for exactly the mask on screen. Any other is left where it is. */
async function lookForRoomCopy(): Promise<void> {
  const check = ++roomChecks;
  const key = imageKey();
  const mask = session.getMask();
  if (!key || !mask || !mayKeepRoomCopy()) return;
  try {
    const bytes = await all.get(roomCopyKey(key));
    const found = bytes && decodeRoomCopy(bytes);
    if (!found || check !== roomChecks || session.getMask() !== mask) return;
    if (roomCopyExpired(found.header, Date.now())) return void queue(() => all.delete(roomCopyKey(key)));
    const data = mask.data as Uint8Array;
    if (!roomCopyFits(found.header, key, mask.dims, data)) return;
    const base = found.base ? await gunzipOffThread(found.base.slice()) : null;
    const review = found.review ? await gunzipOffThread(found.review.slice()) : null;
    // The mask may have been edited while this was being unpacked: then it is no longer the one.
    if (check !== roomChecks || session.getMask() !== mask || !roomCopyFits(found.header, key, mask.dims, data)) return;
    const conflicts = review ? decodeConflicts(review, data.length) : null;
    session.adoptRoomCopy({
      room: found.header.room,
      session: found.header.session,
      head: found.header.head,
      base: base && base.length === data.length ? base : null,
      offlineSegs: found.header.offlineSegs,
      guard: found.header.guard,
      review: conflicts && found.header.review ? { at: found.header.review.at, conflicts } : null,
    });
  } catch {
    /* an unreadable copy is not taken */
  }
}

/** Removes every room copy: autosave is off, so no copy of a mask stays on this device. */
async function dropRoomCopies(): Promise<void> {
  for (const copy of await all.list()) if (isRoomCopyKey(copy.key)) await all.delete(copy.key);
}

/** Room copies older than a membership lasts are of no use. */
async function pruneRoomCopies(now: number): Promise<void> {
  for (const copy of await all.list()) if (isRoomCopyKey(copy.key) && now - copy.savedAt >= ROOM_COPY_KEEP_MS) await all.delete(copy.key);
}

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
  await pruneRoomCopies(Date.now());
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
    // The mask is now the one the copy held: what a room left for exactly that mask comes back with it.
    void lookForRoomCopy();
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
  if (!getSettings().autosave) {
    wait(saver.turnOff());
    void queue(dropRoomCopies);
  }
  void queue(refreshWaiting);

  const offSession = session.onSessionEvent((event) => {
    switch (event) {
      case 'edit':
        saver.noteEdit();
        break;
      case 'opened':
        useRecovery.setState({ savedAt: null });
        void lookForCopy();
        void lookForRoomCopy();
        break;
      case 'saved':
        forgetCurrent();
        // The file now holds this mask, so what the room left is kept for it.
        keepRoomCopyNow();
        break;
      case 'discarded':
        forgetCurrent();
        break;
      case 'room':
        // With unsaved edits it is written with the next recovery copy of the mask; without, now.
        if (get().dirty) saver.noteEdit();
        else keepRoomCopyNow();
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
    void queue(dropRoomCopies);
    toast('info', 'Autosave is off. Recovery copies were removed.');
  });

  const flush = () => void saver.flush();
  const hidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  // The page may be gone before a worker answers, so compress here and now.
  const onLeaving = () => {
    leaving = true;
    void saver.flush(async (data) => gzipSync(data, { level: 1 }));
    // A page that stays after all (the user cancelled closing it) goes back to the worker.
    setTimeout(() => (leaving = false), 1000);
  };
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', onLeaving);
  window.addEventListener('beforeunload', onLeaving);

  return () => {
    offSession();
    offSettings();
    saver.stop();
    window.removeEventListener('blur', flush);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', onLeaving);
    window.removeEventListener('beforeunload', onLeaving);
  };
}
