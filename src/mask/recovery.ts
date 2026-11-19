/**
 * Recovery copies of unsaved mask edits: what goes in one, which image it
 * belongs to, when to write it and when to throw it away. Nothing here touches
 * the DOM, the disk or the viewer, so all of it is unit-tested.
 */

/* ───────────────────────── image fingerprint ───────────────────────── */

export interface FingerprintSource {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: ArrayLike<number>;
  data: ArrayLike<number>;
}

/** How many voxels the fingerprint reads, spread evenly through the image. */
const SAMPLES = 4096;

const KEY_PATTERN = /^[a-f0-9]{16,64}$/;

export function isRecoveryKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function hashBytes(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  // A final mix, so nearby inputs do not give nearby hashes.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A key for "this image": its grid, voxel type and a hash of a sample of its
 * voxels. It holds no voxel values, name or path, and cannot be turned back
 * into the image.
 */
export function fingerprint(image: FingerprintSource): string {
  const { data } = image;
  const count = Math.min(SAMPLES, data.length);
  const geometry = [...image.dims, ...image.spacing, ...image.origin, ...Array.from(image.direction), data.length];
  const values = new Float64Array(geometry.length + count);
  values.set(geometry);
  // One voxel from each of `count` equal stretches, at a position that shifts from
  // stretch to stretch, so the sample is not one column of a 512-wide image.
  const step = data.length / Math.max(1, count);
  for (let i = 0; i < count; i++) values[geometry.length + i] = data[Math.floor((i + ((i * 0.6180339887) % 1)) * step)];
  const type = new TextEncoder().encode((data as object).constructor.name);
  const bytes = new Uint8Array(values.byteLength + type.length);
  bytes.set(new Uint8Array(values.buffer));
  bytes.set(type, values.byteLength);
  return [0x811c9dc5, 0x9e3779b9, 0x7f4a7c15, 0x1b873593].map((seed) => hashBytes(bytes, seed).toString(16).padStart(8, '0')).join('');
}

/* ───────────────────────── the copy itself ───────────────────────── */

export interface SavedSegment {
  index: number;
  name: string;
  color: string;
  locked: boolean;
}

export interface RecoveryHeader {
  v: 1;
  /** Fingerprint of the image the mask belongs to. */
  key: string;
  savedAt: number;
  maskName: string | null;
  dims: [number, number, number];
  segments: SavedSegment[];
}

const MAGIC = [0x57, 0x52, 0x45, 0x43]; // "WREC"
const UNREADABLE = 'This recovery copy cannot be read.';

/** Magic, header length, header as JSON, then the gzip-compressed labelmap. */
export function encodeRecovery(header: RecoveryHeader, gz: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + gz.length);
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(gz, 8 + json.length);
  return out;
}

export function decodeRecovery(bytes: Uint8Array): { header: RecoveryHeader; gz: Uint8Array } {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error(UNREADABLE);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + length > bytes.length) throw new Error(UNREADABLE);
  let header: RecoveryHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as RecoveryHeader;
  } catch {
    throw new Error(UNREADABLE);
  }
  if (header?.v !== 1 || !Array.isArray(header.segments) || !Array.isArray(header.dims)) throw new Error(UNREADABLE);
  return { header, gz: bytes.subarray(8 + length) };
}

/** True when restoring the copy would change the voxels or the segment list on screen. */
export function differsFromMask(
  copy: { data: Uint8Array; segments: SavedSegment[] },
  shown: { data: Uint8Array; segments: SavedSegment[] },
): boolean {
  if (copy.data.length !== shown.data.length) return true;
  for (let i = 0; i < copy.data.length; i++) if (copy.data[i] !== shown.data[i]) return true;
  if (copy.segments.length !== shown.segments.length) return true;
  const byIndex = new Map(shown.segments.map((s) => [s.index, s]));
  return copy.segments.some((s) => {
    const other = byIndex.get(s.index);
    return !other || other.name !== s.name || other.color.toLowerCase() !== s.color.toLowerCase() || other.locked !== s.locked;
  });
}

/* ───────────────────────── storage ───────────────────────── */

export interface StoredCopy {
  key: string;
  savedAt: number;
  bytes: number;
  /** Desktop app only: the file name of the image, when its path is known and the file still exists. */
  imageName?: string;
}

/** Where recovery copies live: IndexedDB in a browser, the app's data folder on the desktop. */
export interface RecoveryStore {
  /** Replaces the copy for this key. `imagePath` is kept on this device only, and only by the desktop app. */
  put(key: string, bytes: Uint8Array, info: { savedAt: number; imagePath?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(): Promise<StoredCopy[]>;
  delete(key: string): Promise<void>;
}

export const KEEP_MS = 14 * 24 * 3600 * 1000;
export const KEEP_COPIES = 5;

/** Keys of the copies that are older than 14 days or beyond the 5 newest. */
export function copiesToPrune(list: StoredCopy[], now: number): string[] {
  const newestFirst = [...list].sort((a, b) => b.savedAt - a.savedAt);
  return newestFirst.filter((c, i) => i >= KEEP_COPIES || now - c.savedAt > KEEP_MS).map((c) => c.key);
}

export async function pruneStore(store: RecoveryStore, now: number): Promise<void> {
  for (const key of copiesToPrune(await store.list(), now)) await store.delete(key);
}

/* ───────────────────────── when to write ───────────────────────── */

/** A copy is written this long after edits stop. */
export const IDLE_MS = 3000;
/** While editing does not stop, a copy is written this often. */
export const MAX_WAIT_MS = 30_000;
/** How soon to look again when a copy was due during a stroke. */
const RETRY_MS = 500;

/** When the edits made since the last copy should be written, or null when there are none. */
export function saveDueAt(edits: { firstEditAt: number | null; lastEditAt: number | null }): number | null {
  if (edits.firstEditAt === null || edits.lastEditAt === null) return null;
  return Math.min(edits.lastEditAt + IDLE_MS, edits.firstEditAt + MAX_WAIT_MS);
}

export interface RecoverySnapshot {
  key: string;
  /** A copy of the labelmap that the saver may hand to a worker. */
  mask: Uint8Array;
  dims: [number, number, number];
  maskName: string | null;
  segments: SavedSegment[];
  imagePath?: string;
}

export interface AutosaveDeps {
  store: RecoveryStore;
  /** The unsaved work right now, or null when nothing is open or nothing is unsaved. */
  snapshot(): RecoverySnapshot | null;
  /** True during a stroke. Nothing is copied or written then. */
  busy(): boolean;
  compress(data: Uint8Array): Promise<Uint8Array>;
  onSaved(at: number): void;
  onError(err: unknown): void;
}

/** Decides when recovery copies are written, and writes them. */
export class Autosaver {
  private firstEditAt: number | null = null;
  private lastEditAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private on = true;
  private paused = false;
  /** Goes up whenever copies are forgotten, so a write already under way knows to give up. */
  private epoch = 0;

  constructor(private deps: AutosaveDeps) {}

  /** The mask or its segments changed. */
  noteEdit(): void {
    if (!this.on) return;
    const now = Date.now();
    this.firstEditAt ??= now;
    this.lastEditAt = now;
    this.schedule();
  }

  /** Write now if edits are waiting (the window lost focus or is closing). */
  async flush(compress?: (data: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    if (this.firstEditAt === null || this.deps.busy()) return;
    await this.save(compress);
  }

  /** The mask was saved to a file, or its changes were thrown away: the copy is no longer wanted. */
  async forget(key: string): Promise<void> {
    this.epoch++;
    this.clearEdits();
    await this.deps.store.delete(key);
  }

  /** Stop writing for now, without losing track of edits (a found copy is waiting for an answer). */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    this.paused = false;
    this.schedule();
  }

  /** Autosave was switched off: stop, and remove every copy. */
  async turnOff(): Promise<void> {
    this.on = false;
    this.epoch++;
    this.clearEdits();
    for (const copy of await this.deps.store.list()) await this.deps.store.delete(copy.key);
  }

  turnOn(): void {
    this.on = true;
  }

  /** Nothing is open any more. */
  stop(): void {
    this.clearEdits();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearEdits(): void {
    this.firstEditAt = this.lastEditAt = null;
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    const due = saveDueAt({ firstEditAt: this.firstEditAt, lastEditAt: this.lastEditAt });
    if (due === null || !this.on || this.paused || this.saving) return;
    this.arm(Math.max(0, due - Date.now()));
  }

  private arm(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, delay);
  }

  private async save(compress = this.deps.compress): Promise<void> {
    if (!this.on || this.paused || this.saving || this.firstEditAt === null) return;
    if (this.deps.busy()) return this.arm(RETRY_MS);
    this.clearEdits();
    const snap = this.deps.snapshot();
    if (!snap) return;
    const epoch = this.epoch;
    this.saving = true;
    try {
      const gz = await compress(snap.mask);
      if (epoch !== this.epoch) return;
      const savedAt = Date.now();
      const header: RecoveryHeader = { v: 1, key: snap.key, savedAt, maskName: snap.maskName, dims: snap.dims, segments: snap.segments };
      await this.deps.store.put(snap.key, encodeRecovery(header, gz), { savedAt, imagePath: snap.imagePath });
      if (epoch !== this.epoch) {
        await this.deps.store.delete(snap.key);
        return;
      }
      this.deps.onSaved(savedAt);
      await pruneStore(this.deps.store, savedAt);
    } catch (err) {
      this.deps.onError(err);
    } finally {
      this.saving = false;
      this.schedule();
    }
  }
}

/* ───────────────────────── words shown to the user ───────────────────────── */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function foundText(savedAt: number): string {
  const d = new Date(savedAt);
  return `Unsaved edits from ${clock(savedAt)} on ${d.getDate()} ${MONTHS[d.getMonth()]} were found for this image.`;
}

/** Shown beside "Unsaved changes". It names the recovery copy, never the mask file. */
export function statusText(savedAt: number): string {
  return `recovery copy ${clock(savedAt)}`;
}

export function waitingText(count: number): string {
  return count === 1
    ? 'Recovered work is available for 1 image. Open the image to restore it.'
    : `Recovered work is available for ${count} images. Open an image to restore it.`;
}
