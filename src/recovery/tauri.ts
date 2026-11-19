import { isRecoveryKey, type RecoveryStore, type StoredCopy } from '../mask/recovery';

async function call<T>(command: string, ...rest: unknown[]): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return (invoke as (command: string, ...rest: unknown[]) => Promise<T>)(command, ...rest);
}

function check(key: string): void {
  if (!isRecoveryKey(key)) throw new Error('The recovery key is not valid.');
}

/** Recovery copies as files in the desktop app's local data folder. See src-tauri/README.md. */
export class TauriRecoveryStore implements RecoveryStore {
  async put(key: string, bytes: Uint8Array, info: { savedAt: number; imagePath?: string }): Promise<void> {
    check(key);
    const headers: Record<string, string> = { 'x-recovery-key': key };
    // The path stays on this computer; the app keeps it only for a file the user chose.
    if (info.imagePath) headers['x-image-path'] = encodeURIComponent(info.imagePath);
    await call<void>('recovery_write', bytes, { headers });
  }

  async get(key: string): Promise<Uint8Array | null> {
    check(key);
    const buffer = await call<ArrayBuffer>('recovery_read', { key });
    return buffer.byteLength ? new Uint8Array(buffer) : null;
  }

  async list(): Promise<StoredCopy[]> {
    const copies = await call<{ key: string; savedAt: number; bytes: number; imageName: string | null }[]>('recovery_list');
    return copies.map(({ key, savedAt, bytes, imageName }) => ({ key, savedAt, bytes, ...(imageName ? { imageName } : {}) }));
  }

  async delete(key: string): Promise<void> {
    check(key);
    await call<void>('recovery_delete', { key });
  }

  /** The bytes of the image a copy belongs to, when the app knows where it is. */
  async image(key: string): Promise<Uint8Array> {
    check(key);
    return new Uint8Array(await call<ArrayBuffer>('recovery_image', { key }));
  }
}
