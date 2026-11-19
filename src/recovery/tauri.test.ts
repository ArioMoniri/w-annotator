import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { TauriRecoveryStore } from './tauri';

const KEY = 'ab'.repeat(16);

describe('desktop recovery store', () => {
  beforeEach(() => invoke.mockReset());

  it('sends the copy as the raw body with the key in a header, and no path unless one is known', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await new TauriRecoveryStore().put(KEY, bytes, { savedAt: 5 });
    expect(invoke).toHaveBeenCalledWith('recovery_write', bytes, { headers: { 'x-recovery-key': KEY } });
  });

  it('percent-encodes the image path', async () => {
    await new TauriRecoveryStore().put(KEY, new Uint8Array(1), { savedAt: 5, imagePath: '/scans/a b é.nii.gz' });
    expect(invoke.mock.calls[0][2]).toEqual({
      headers: { 'x-recovery-key': KEY, 'x-image-path': '%2Fscans%2Fa%20b%20%C3%A9.nii.gz' },
    });
  });

  it('refuses a key that is not lowercase hex before calling the app', async () => {
    const store = new TauriRecoveryStore();
    await expect(store.put('../../x', new Uint8Array(1), { savedAt: 5 })).rejects.toThrow();
    await expect(store.get('NOPE')).rejects.toThrow();
    await expect(store.delete('a/b')).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reads a copy, and gives null when there is none', async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([9, 8]).buffer);
    expect(await new TauriRecoveryStore().get(KEY)).toEqual(new Uint8Array([9, 8]));
    expect(invoke).toHaveBeenCalledWith('recovery_read', { key: KEY });
    invoke.mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await new TauriRecoveryStore().get(KEY)).toBeNull();
  });

  it('lists copies with the image name only when the app gives one', async () => {
    invoke.mockResolvedValueOnce([
      { key: KEY, savedAt: 7, bytes: 3, imageName: 'scan.nii.gz' },
      { key: 'cd'.repeat(16), savedAt: 6, bytes: 4, imageName: null },
    ]);
    expect(await new TauriRecoveryStore().list()).toEqual([
      { key: KEY, savedAt: 7, bytes: 3, imageName: 'scan.nii.gz' },
      { key: 'cd'.repeat(16), savedAt: 6, bytes: 4 },
    ]);
  });

  it('deletes by key and opens the image by key, never by path', async () => {
    const store = new TauriRecoveryStore();
    await store.delete(KEY);
    expect(invoke).toHaveBeenLastCalledWith('recovery_delete', { key: KEY });
    invoke.mockResolvedValueOnce(new Uint8Array([4]).buffer);
    expect(await store.image(KEY)).toEqual(new Uint8Array([4]));
    expect(invoke).toHaveBeenLastCalledWith('recovery_image', { key: KEY });
  });
});
