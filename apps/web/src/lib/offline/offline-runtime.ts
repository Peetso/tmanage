import { authBoundary, type AuthBoundary } from '../auth-boundary';
import { IndexedDbOfflineStore } from './idb-store';
import { MemoryOfflineStore, OfflineQueue } from './queue';

/**
 * 53-16. The browser's single offline queue, and the auth boundary that empties it.
 *
 * Read caches live in the service worker (`/sw.js`, cache `tmanage-data-v1`): the last-seen My
 * Day, work list and task detail. Both the queue and that cache hold one person's workspace data,
 * so **every** boundary event — sign-in, sign-out, session ended, in this tab or another — drops
 * both. The next person on this browser starts with nothing from the previous one.
 */

/** Must match `DATA_CACHE` in `public/sw.js`. */
export const OFFLINE_DATA_CACHE = 'tmanage-data-v1';
/** Must match the message `public/sw.js` listens for. */
export const CLEAR_DATA_MESSAGE = { type: 'CLEAR_DATA' } as const;

let queue: OfflineQueue | undefined;

export function offlineQueue(): OfflineQueue {
  if (!queue) {
    const factory = typeof indexedDB === 'undefined' ? undefined : indexedDB;
    queue = new OfflineQueue(
      factory ? new IndexedDbOfflineStore(factory) : new MemoryOfflineStore(),
    );
  }
  return queue;
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Drop the service worker's read cache, from the page and in the worker. */
export async function clearReadCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(OFFLINE_DATA_CACHE);
  } catch {
    // A cache that cannot be opened holds nothing to clear.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage(CLEAR_DATA_MESSAGE);
  } catch {
    // No controlling worker: nothing cached through it.
  }
}

/**
 * Subscribe the queue and the read cache to the boundary. Exported for the test; the module
 * wires the application's boundary below.
 */
export function clearOfflineOnAuthChange(
  boundary: AuthBoundary,
  target: () => OfflineQueue,
  clearCache: () => Promise<void>,
): () => void {
  return boundary.subscribe(() => {
    void target().clear();
    void clearCache();
  });
}

if (typeof window !== 'undefined') {
  clearOfflineOnAuthChange(authBoundary, offlineQueue, clearReadCache);
}

/** Test seam. */
export function resetOfflineQueue(next?: OfflineQueue): void {
  queue = next;
}
