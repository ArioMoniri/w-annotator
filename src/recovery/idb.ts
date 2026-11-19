import type { RecoveryStore, StoredCopy } from '../mask/recovery';

const DB = 'w-annotator-recovery';
/** Small rows, so listing never loads a mask. */
const INFO = 'info';
const DATA = 'data';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(INFO, { keyPath: 'key' });
      request.result.createObjectStore(DATA);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Recovery copies in the browser's own storage for this site. They never leave the device. */
export class IdbRecoveryStore implements RecoveryStore {
  private db: Promise<IDBDatabase> | null = null;

  private async run<T>(mode: IDBTransactionMode, work: (info: IDBObjectStore, data: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    this.db ??= open();
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([INFO, DATA], mode);
      const request = work(tx.objectStore(INFO), tx.objectStore(DATA));
      tx.oncomplete = () => resolve(request ? request.result : (undefined as T));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The browser refused to store the recovery copy.'));
    });
  }

  put(key: string, bytes: Uint8Array, info: { savedAt: number }): Promise<void> {
    return this.run('readwrite', (infoStore, dataStore) => {
      infoStore.put({ key, savedAt: info.savedAt, bytes: bytes.length } satisfies StoredCopy);
      dataStore.put(bytes, key);
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = await this.run<Uint8Array | undefined>('readonly', (_info, data) => data.get(key));
    return found ? new Uint8Array(found) : null;
  }

  list(): Promise<StoredCopy[]> {
    return this.run<StoredCopy[]>('readonly', (info) => info.getAll());
  }

  delete(key: string): Promise<void> {
    return this.run('readwrite', (info, data) => {
      info.delete(key);
      data.delete(key);
    });
  }
}
