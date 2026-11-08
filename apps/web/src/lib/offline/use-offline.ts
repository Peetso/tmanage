'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { OfflineWrite, OfflineWriteKind } from './queue';
import { isOnline, offlineQueue } from './offline-runtime';

/** 53-16. React views of the connection and the offline queue. */

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `true` on the server and before hydration, so nothing flashes "offline" on first paint. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}

const EMPTY: readonly OfflineWrite[] = [];

/** Every queued write, oldest first. */
export function useOfflineWrites(): readonly OfflineWrite[] {
  useEffect(() => {
    void offlineQueue().load();
  }, []);
  return useSyncExternalStore(
    (onChange) => offlineQueue().subscribe(onChange),
    () => offlineQueue().list(),
    () => EMPTY,
  );
}

/** The queued writes of one kind on one work item — what a panel shows with a Pending badge. */
export function usePendingWrites<K extends OfflineWriteKind>(
  workspaceSlug: string,
  workItemId: string,
  kind: K,
): readonly Extract<OfflineWrite, { kind: K }>[] {
  const all = useOfflineWrites();
  return useMemo(
    () =>
      all.filter(
        (write): write is Extract<OfflineWrite, { kind: K }> =>
          write.kind === kind &&
          write.workspaceSlug === workspaceSlug &&
          write.workItemId === workItemId,
      ),
    [all, kind, workspaceSlug, workItemId],
  );
}
