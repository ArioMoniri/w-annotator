import { gunzipSync, gzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Autosaver,
  IDLE_MS,
  KEEP_COPIES,
  KEEP_MS,
  MAX_WAIT_MS,
  copiesToPrune,
  decodeRecovery,
  differsFromMask,
  encodeRecovery,
  fingerprint,
  foundText,
  isRecoveryKey,
  pruneStore,
  saveDueAt,
  statusText,
  waitingText,
  type RecoveryHeader,
  type RecoverySnapshot,
  type RecoveryStore,
  type SavedSegment,
  type StoredCopy,
} from './recovery';

/** A small asymmetric volume, so a flipped axis changes the sampled voxels. */
function phantom(n = 12) {
  const data = new Int16Array(n * n * n);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i % n) * 13) % 2000;
  return {
    dims: [n, n, n] as [number, number, number],
    spacing: [0.7, 0.7, 5] as [number, number, number],
    origin: [-120, 80.5, 12] as [number, number, number],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    data,
  };
}

const SEGMENTS: SavedSegment[] = [
  { index: 1, name: 'Liver', color: '#E69F00', locked: false },
  { index: 2, name: 'Tumour', color: '#56B4E9', locked: true },
];

/** The fake store: what IndexedDB and the desktop folder do, kept in memory. */
class MemoryStore implements RecoveryStore {
  copies = new Map<string, { bytes: Uint8Array; savedAt: number; imagePath?: string }>();
  failNext = false;
  async put(key: string, bytes: Uint8Array, info: { savedAt: number; imagePath?: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk full');
    }
    this.copies.set(key, { bytes, ...info });
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.copies.get(key)?.bytes ?? null;
  }
  async list(): Promise<StoredCopy[]> {
    return [...this.copies].map(([key, c]) => ({ key, savedAt: c.savedAt, bytes: c.bytes.length }));
  }
  async delete(key: string): Promise<void> {
    this.copies.delete(key);
  }
}

describe('image fingerprint', () => {
  it('is the same for the same image, also when the voxels are copied', () => {
    const a = phantom();
    const b = { ...phantom(), data: phantom().data.slice() };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('is a key the stores accept', () => {
    expect(isRecoveryKey(fingerprint(phantom()))).toBe(true);
    expect(fingerprint(phantom())).toMatch(/^[a-f0-9]{32}$/);
  });

  it('changes with dimensions, spacing, origin, direction and voxel type', () => {
    const base = fingerprint(phantom());
    const other = phantom();
    expect(fingerprint({ ...other, dims: [12, 6, 24] })).not.toBe(base);
    expect(fingerprint({ ...other, spacing: [0.7, 0.7, 5.5] })).not.toBe(base);
    expect(fingerprint({ ...other, origin: [-120, 80.5, 12.5] })).not.toBe(base);
    expect(fingerprint({ ...other, direction: [-1, 0, 0, 0, 1, 0, 0, 0, 1] })).not.toBe(base);
    expect(fingerprint({ ...other, data: new Uint16Array(other.data) })).not.toBe(base);
  });

  it('changes when the voxels change', () => {
    const base = fingerprint(phantom());
    const brighter = phantom();
    for (let i = 0; i < brighter.data.length; i++) brighter.data[i] += 1;
    expect(fingerprint(brighter)).not.toBe(base);
    const flipped = phantom();
    flipped.data.reverse();
    expect(fingerprint(flipped)).not.toBe(base);
  });

  it('reads only a sample of a large image', () => {
    const n = 64;
    const big = { ...phantom(), dims: [n, n, n] as [number, number, number], data: new Int16Array(n * n * n) };
    let reads = 0;
    const counted = new Proxy(big.data, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' && prop !== 'constructor' ? value.bind(target) : value;
      },
    });
    fingerprint({ ...big, data: counted });
    expect(reads).toBeGreaterThan(1000);
    expect(reads).toBeLessThan(10000);
  });

  it('holds nothing that names the image', () => {
    const named = { ...phantom(), name: 'DOE_JOHN_1970.nii.gz' };
    expect(fingerprint(named)).toBe(fingerprint(phantom()));
  });
});

describe('recovery keys', () => {
  it('accepts 16 to 64 lowercase hex characters and nothing else', () => {
    expect(isRecoveryKey('0123456789abcdef')).toBe(true);
    expect(isRecoveryKey('a'.repeat(64))).toBe(true);
    expect(isRecoveryKey('a'.repeat(15))).toBe(false);
    expect(isRecoveryKey('a'.repeat(65))).toBe(false);
    expect(isRecoveryKey('0123456789ABCDEF')).toBe(false);
    expect(isRecoveryKey('../../etc/passwd00')).toBe(false);
    expect(isRecoveryKey('0123456789abcdef.gz')).toBe(false);
  });
});

describe('recovery copy encoding', () => {
  const header: RecoveryHeader = {
    v: 1,
    key: 'a'.repeat(32),
    savedAt: 1_780_000_000_000,
    maskName: 'liver é.nii.gz',
    dims: [4, 3, 2],
    segments: SEGMENTS,
  };

  it('round-trips the header and the compressed voxels', () => {
    const mask = new Uint8Array(24).map((_, i) => i % 3);
    const out = decodeRecovery(encodeRecovery(header, gzipSync(mask)));
    expect(out.header).toEqual(header);
    expect(gunzipSync(out.gz)).toEqual(mask);
  });

  it('rejects bytes that are not a recovery copy', () => {
    expect(() => decodeRecovery(new Uint8Array([1, 2, 3]))).toThrow(/cannot be read/);
    expect(() => decodeRecovery(gzipSync(new Uint8Array(40)))).toThrow(/cannot be read/);
  });

  it('rejects a truncated copy and a newer version', () => {
    const bytes = encodeRecovery(header, gzipSync(new Uint8Array(24)));
    expect(() => decodeRecovery(bytes.subarray(0, 20))).toThrow(/cannot be read/);
    const newer = encodeRecovery({ ...header, v: 2 as 1 }, new Uint8Array(4));
    expect(() => decodeRecovery(newer)).toThrow(/cannot be read/);
  });
});

describe('differs from the mask on screen', () => {
  const voxels = new Uint8Array([0, 1, 1, 2, 0, 0]);
  const shown = (data: Uint8Array, segments = SEGMENTS) => ({ data, segments });

  it('is false for the same voxels and segments', () => {
    expect(differsFromMask(shown(voxels), shown(voxels.slice()))).toBe(false);
  });

  it('is true when one voxel differs', () => {
    const other = voxels.slice();
    other[5] = 2;
    expect(differsFromMask(shown(other), shown(voxels))).toBe(true);
  });

  it('is true when the sizes differ', () => {
    expect(differsFromMask(shown(voxels.subarray(0, 4)), shown(voxels))).toBe(true);
  });

  it('is true when a name, colour or lock differs', () => {
    const renamed = SEGMENTS.map((s) => (s.index === 1 ? { ...s, name: 'Spleen' } : s));
    const recoloured = SEGMENTS.map((s) => (s.index === 1 ? { ...s, color: '#000000' } : s));
    const unlocked = SEGMENTS.map((s) => ({ ...s, locked: false }));
    expect(differsFromMask(shown(voxels, renamed), shown(voxels))).toBe(true);
    expect(differsFromMask(shown(voxels, recoloured), shown(voxels))).toBe(true);
    expect(differsFromMask(shown(voxels, unlocked), shown(voxels))).toBe(true);
  });

  it('ignores segment order and whether a segment is shown', () => {
    const reordered = [...SEGMENTS].reverse().map((s) => ({ ...s, visible: false }));
    expect(differsFromMask(shown(voxels, reordered), shown(voxels))).toBe(false);
  });
});

describe('pruning', () => {
  const now = 1_780_000_000_000;
  const day = 24 * 3600 * 1000;
  const copy = (key: string, ageDays: number): StoredCopy => ({ key, savedAt: now - ageDays * day, bytes: 10 });

  it('keeps copies for 14 days and for 5 images', () => {
    expect(KEEP_MS).toBe(14 * day);
    expect(KEEP_COPIES).toBe(5);
  });

  it('removes copies older than 14 days', () => {
    expect(copiesToPrune([copy('a', 1), copy('b', 13.9), copy('c', 14.1), copy('d', 40)], now)).toEqual(['c', 'd']);
  });

  it('keeps the 5 newest and removes the rest', () => {
    const list = [copy('g', 7), copy('a', 1), copy('c', 3), copy('f', 6), copy('b', 2), copy('e', 5), copy('d', 4)];
    expect(copiesToPrune(list, now).sort()).toEqual(['f', 'g']);
  });

  it('removes nothing from a short, recent list', () => {
    expect(copiesToPrune([copy('a', 0), copy('b', 2)], now)).toEqual([]);
  });

  it('deletes the pruned copies from a store', async () => {
    const store = new MemoryStore();
    for (const [key, age] of [['aa', 1], ['bb', 20]] as const) {
      await store.put(key, new Uint8Array(1), { savedAt: now - age * day });
    }
    await pruneStore(store, now);
    expect([...store.copies.keys()]).toEqual(['aa']);
  });
});

describe('when a copy is due', () => {
  it('is never due without unsaved edits', () => {
    expect(saveDueAt({ firstEditAt: null, lastEditAt: null })).toBeNull();
  });

  it('is due 3 seconds after the last edit', () => {
    expect(IDLE_MS).toBe(3000);
    expect(saveDueAt({ firstEditAt: 1000, lastEditAt: 5000 })).toBe(8000);
  });

  it('is due 30 seconds after the first edit when editing does not stop', () => {
    expect(MAX_WAIT_MS).toBe(30_000);
    expect(saveDueAt({ firstEditAt: 1000, lastEditAt: 30_500 })).toBe(31_000);
  });
});

describe('autosaver', () => {
  const KEY = 'c'.repeat(32);
  let store: MemoryStore;
  let pointerDown: boolean;
  let unsaved: boolean;
  let mask: Uint8Array;
  let saved: number[];
  let errors: unknown[];
  let snapshots: number;
  let saver: Autosaver;
  let releaseCompress: (() => void) | null;
  let holdCompress: boolean;

  const snapshot = (): RecoverySnapshot | null => {
    snapshots++;
    return unsaved ? { key: KEY, mask: mask.slice(), dims: [2, 2, 2], maskName: 'Room mask', segments: SEGMENTS } : null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_780_000_000_000);
    store = new MemoryStore();
    pointerDown = false;
    unsaved = true;
    mask = new Uint8Array([0, 1, 1, 0, 2, 2, 0, 0]);
    saved = [];
    errors = [];
    snapshots = 0;
    releaseCompress = null;
    holdCompress = false;
    saver = new Autosaver({
      store,
      snapshot,
      busy: () => pointerDown,
      compress: (data) =>
        new Promise((resolve) => {
          const done = () => resolve(gzipSync(data));
          if (holdCompress) releaseCompress = done;
          else done();
        }),
      onSaved: (at) => saved.push(at),
      onError: (err) => errors.push(err),
    });
  });

  afterEach(() => {
    saver.stop();
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('writes nothing until there is an edit', async () => {
    await advance(120_000);
    expect(store.copies.size).toBe(0);
    expect(snapshots).toBe(0);
  });

  it('writes a copy 3 seconds after edits stop', async () => {
    const start = Date.now();
    saver.noteEdit();
    await advance(2900);
    expect(store.copies.size).toBe(0);
    await advance(200);
    expect(store.copies.size).toBe(1);
    expect(saved).toEqual([start + 3000]);
  });

  it('stores the voxels, segments and mask name under the image key', async () => {
    saver.noteEdit();
    await advance(3100);
    const { header, gz } = decodeRecovery((await store.get(KEY))!);
    expect(gunzipSync(gz)).toEqual(mask);
    expect(header).toEqual({ v: 1, key: KEY, savedAt: saved[0], maskName: 'Room mask', dims: [2, 2, 2], segments: SEGMENTS });
  });

  it('writes at most every 30 seconds while editing does not stop', async () => {
    for (let t = 0; t < 29; t++) {
      saver.noteEdit();
      await advance(1000);
    }
    expect(store.copies.size).toBe(0);
    saver.noteEdit();
    await advance(1000);
    expect(saved).toHaveLength(1);
    for (let t = 0; t < 29; t++) {
      saver.noteEdit();
      await advance(1000);
    }
    expect(saved).toHaveLength(1);
    saver.noteEdit();
    await advance(1000);
    expect(saved).toHaveLength(2);
  });

  it('writes once for one burst of edits', async () => {
    saver.noteEdit();
    saver.noteEdit();
    saver.noteEdit();
    await advance(60_000);
    expect(saved).toHaveLength(1);
  });

  it('never writes while the pointer is down, and writes once it is released', async () => {
    saver.noteEdit();
    pointerDown = true;
    await advance(40_000);
    expect(snapshots).toBe(0);
    expect(store.copies.size).toBe(0);
    pointerDown = false;
    await advance(600);
    expect(store.copies.size).toBe(1);
  });

  it('writes nothing when there are no unsaved changes', async () => {
    unsaved = false;
    saver.noteEdit();
    await advance(60_000);
    expect(store.copies.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it('writes straight away on flush, but only when something is waiting', async () => {
    await saver.flush();
    expect(store.copies.size).toBe(0);
    saver.noteEdit();
    await saver.flush();
    expect(store.copies.size).toBe(1);
    await advance(60_000);
    expect(saved).toHaveLength(1);
  });

  it('does not flush while the pointer is down', async () => {
    saver.noteEdit();
    pointerDown = true;
    await saver.flush();
    expect(store.copies.size).toBe(0);
  });

  it('saves edits made while a copy was being written', async () => {
    holdCompress = true;
    saver.noteEdit();
    await advance(3100);
    expect(store.copies.size).toBe(0);
    mask[0] = 2;
    saver.noteEdit();
    holdCompress = false;
    releaseCompress!();
    await advance(10);
    expect(gunzipSync(decodeRecovery((await store.get(KEY))!).gz)[0]).toBe(0);
    await advance(3100);
    expect(saved).toHaveLength(2);
    expect(gunzipSync(decodeRecovery((await store.get(KEY))!).gz)[0]).toBe(2);
  });

  it('forgets the copy after the mask is saved, even if a write is in flight', async () => {
    holdCompress = true;
    saver.noteEdit();
    await advance(3100);
    const forgetting = saver.forget(KEY);
    releaseCompress!();
    await forgetting;
    await advance(60_000);
    expect(store.copies.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it('forgets edits that were waiting when the mask is saved', async () => {
    saver.noteEdit();
    await saver.forget(KEY);
    await advance(60_000);
    expect(store.copies.size).toBe(0);
  });

  it('writes nothing while paused and catches up when resumed', async () => {
    saver.pause();
    saver.noteEdit();
    await advance(60_000);
    expect(store.copies.size).toBe(0);
    saver.resume();
    await advance(3100);
    expect(store.copies.size).toBe(1);
  });

  it('writes nothing when turned off, and removes every copy', async () => {
    await store.put('d'.repeat(32), new Uint8Array(1), { savedAt: Date.now() });
    saver.noteEdit();
    await saver.turnOff();
    saver.noteEdit();
    await advance(60_000);
    await saver.flush();
    expect(store.copies.size).toBe(0);
  });

  it('writes again after being turned back on', async () => {
    await saver.turnOff();
    saver.turnOn();
    saver.noteEdit();
    await advance(3100);
    expect(store.copies.size).toBe(1);
  });

  it('reports a failed write once and keeps going on the next edit', async () => {
    store.failNext = true;
    saver.noteEdit();
    await advance(3100);
    expect(errors).toHaveLength(1);
    expect(saved).toEqual([]);
    await advance(60_000);
    expect(errors).toHaveLength(1);
    saver.noteEdit();
    await advance(3100);
    expect(saved).toHaveLength(1);
  });

  it('prunes old copies after writing', async () => {
    await store.put('e'.repeat(32), new Uint8Array(1), { savedAt: Date.now() - KEEP_MS - 1000 });
    saver.noteEdit();
    await advance(3100);
    expect([...store.copies.keys()]).toEqual([KEY]);
  });

  it('passes the image path on to the store but keeps it out of the copy', async () => {
    const withPath = new Autosaver({
      store,
      snapshot: () => ({ ...snapshot()!, imagePath: '/scans/DOE_JOHN.nii.gz' }),
      busy: () => false,
      compress: async (data) => gzipSync(data),
      onSaved: () => {},
      onError: () => {},
    });
    withPath.noteEdit();
    await advance(3100);
    expect(store.copies.get(KEY)!.imagePath).toBe('/scans/DOE_JOHN.nii.gz');
    expect(new TextDecoder().decode(store.copies.get(KEY)!.bytes)).not.toContain('DOE_JOHN');
    withPath.stop();
  });
});

describe('copy', () => {
  // 3 May 2026, 14:32 local time.
  const at = new Date(2026, 4, 3, 14, 32, 10).getTime();

  it('says when the found edits were made', () => {
    expect(foundText(at)).toBe('Unsaved edits from 14:32 on 3 May were found for this image.');
    expect(foundText(new Date(2026, 0, 9, 7, 5).getTime())).toBe('Unsaved edits from 07:05 on 9 January were found for this image.');
  });

  it('names the recovery copy in the status bar without claiming a file was saved', () => {
    expect(statusText(at)).toBe('recovery copy 14:32');
    expect(statusText(at)).not.toMatch(/\bsaved\b/i);
  });

  it('counts the images with recovered work', () => {
    expect(waitingText(1)).toBe('Recovered work is available for 1 image. Open the image to restore it.');
    expect(waitingText(3)).toBe('Recovered work is available for 3 images. Open an image to restore it.');
  });
});
