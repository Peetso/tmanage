import type { OfflineStore, OfflineWrite } from './queue';

/**
 * 53-16. The browser's {@link OfflineStore}: one IndexedDB database, one object store keyed by
 * the write id. Same-origin by construction. Only the four safe writes live here, and the
 * whole store is cleared at the authentication boundary.
 */

const DB_NAME = 'tmanage-offline';
const STORE = 'writes';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbOfflineStore implements OfflineStore {
  private db: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async all(): Promise<readonly OfflineWrite[]> {
    return request((await this.store('readonly')).getAll() as IDBRequest<OfflineWrite[]>);
  }

  async put(write: OfflineWrite): Promise<void> {
    await request((await this.store('readwrite')).put(write));
  }

  async remove(id: string): Promise<void> {
    await request((await this.store('readwrite')).delete(id));
  }

  async clear(): Promise<void> {
    await request((await this.store('readwrite')).clear());
  }
}
