'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { createUndoQueue, type UndoEntry, type UndoQueue, type UndoRequest } from './undo-queue';

/**
 * The one queue every screen shares, so a held delete survives the screen that started it (the
 * work item page navigates away at once) and `UndoToastHost` shows every hold in one place.
 */
export const undoQueue: UndoQueue = createUndoQueue();

const NO_ENTRIES: readonly UndoEntry[] = [];

/** Every held or failed action, for the toast host. */
export function useUndoEntries(queue: UndoQueue = undoQueue): readonly UndoEntry[] {
  return useSyncExternalStore(queue.subscribe, queue.entries, () => NO_ENTRIES);
}

export interface UseUndo {
  /** Hold a destructive call behind an Undo toast. */
  readonly schedule: (request: UndoRequest) => string;
  /** True while the action on this key is held or being sent — hide the item meanwhile. */
  readonly isPending: (key: string) => boolean;
}

export function useUndo(queue: UndoQueue = undoQueue): UseUndo {
  // Subscribing re-renders the caller whenever a hold starts or ends.
  useUndoEntries(queue);
  const schedule = useCallback((request: UndoRequest) => queue.enqueue(request), [queue]);
  const isPending = useCallback((key: string) => queue.isPending(key), [queue]);
  return { schedule, isPending };
}
