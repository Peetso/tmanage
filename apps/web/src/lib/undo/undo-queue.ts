/**
 * 55-23 Undo everywhere — the shared queue behind every "Undo" toast.
 *
 * A destructive action (delete, archive, move, complete, remove) is not sent to the server at
 * once: it is **held** for 5–10 seconds while a toast offers Undo. Undo drops the held call, so
 * nothing ever reached the server; letting the timer run out (or closing the toast, or leaving the
 * page) sends it. The API has no member-level restore route for most of these objects, so holding
 * the call is the only undo that is honest on every surface — a "restore" would be a second write
 * the server may refuse.
 *
 * Pure and clock-injected so the unit tests drive time by hand; `use-undo.ts` binds one shared
 * instance to React.
 */

export const UNDO_MIN_MS = 5_000;
export const UNDO_MAX_MS = 10_000;
/** FIX6 item 9: 10 s by default, so a person has time to read the toast and reach Undo. */
export const UNDO_DEFAULT_MS = 10_000;

export interface UndoRequest {
  /** What the action is about ("work:abc"), so a screen can hide an item while it is held. */
  readonly key: string;
  /** The toast's sentence, already translated ("Task deleted"). */
  readonly message: string;
  /** The real server call. Runs once, when the hold ends without an Undo. */
  readonly commit: () => Promise<unknown>;
  /** Put the screen back the way it was. */
  readonly onUndo?: () => void;
  readonly onCommitted?: () => void;
  readonly onFailed?: (error: unknown) => void;
  /** Hold time; clamped to 5–10 s. */
  readonly delayMs?: number;
}

export type UndoStatus = 'pending' | 'committing' | 'failed';

export interface UndoEntry {
  readonly id: string;
  readonly key: string;
  readonly message: string;
  /** Epoch ms at which the held call is sent. */
  readonly deadline: number;
  /**
   * FIX6 item 9: while the pointer or keyboard focus is on the toast the countdown stops; this is
   * the time that was left when it paused (null while counting).
   */
  readonly pausedRemainingMs: number | null;
  readonly status: UndoStatus;
  readonly error?: unknown;
}

export interface UndoClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: UndoClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function clampUndoDelay(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return UNDO_DEFAULT_MS;
  return Math.min(UNDO_MAX_MS, Math.max(UNDO_MIN_MS, Math.round(ms)));
}

export interface UndoQueue {
  enqueue(request: UndoRequest): string;
  /** Cancel a held action. `false` once it has already been sent. */
  undo(id: string): boolean;
  /** Send a held action now (the toast was closed). */
  flush(id: string): void;
  /** Send everything still held (the page is going away). */
  flushAll(): void;
  /** Drop a failed entry's toast. */
  dismiss(id: string): void;
  /** Stop the countdown while a person reads or reaches the toast (FIX6 item 9). */
  pause(id: string): void;
  /** Start it again with the time that was left. */
  resume(id: string): void;
  isPending(key: string): boolean;
  entries(): readonly UndoEntry[];
  subscribe(listener: () => void): () => void;
}

interface Slot {
  entry: UndoEntry;
  readonly request: UndoRequest;
  timer: unknown;
}

export function createUndoQueue(clock: UndoClock = systemClock): UndoQueue {
  const slots = new Map<string, Slot>();
  const listeners = new Set<() => void>();
  let snapshot: readonly UndoEntry[] = [];
  let sequence = 0;

  function changed(): void {
    snapshot = [...slots.values()].map((slot) => slot.entry);
    for (const listener of listeners) listener();
  }

  function send(slot: Slot): void {
    if (slot.entry.status !== 'pending') return;
    clock.clearTimeout(slot.timer);
    slot.entry = { ...slot.entry, status: 'committing' };
    changed();
    const id = slot.entry.id;
    slot.request.commit().then(
      () => {
        slots.delete(id);
        changed();
        slot.request.onCommitted?.();
      },
      (error: unknown) => {
        slot.entry = { ...slot.entry, status: 'failed', error };
        changed();
        slot.request.onFailed?.(error);
      },
    );
  }

  return {
    enqueue(request) {
      // A second action on the same object sends the first one rather than stacking two holds.
      for (const slot of slots.values()) {
        if (slot.entry.key === request.key && slot.entry.status === 'pending') send(slot);
      }
      sequence += 1;
      const id = `undo-${sequence}`;
      const delay = clampUndoDelay(request.delayMs);
      const slot: Slot = {
        entry: {
          id,
          key: request.key,
          message: request.message,
          deadline: clock.now() + delay,
          pausedRemainingMs: null,
          status: 'pending',
        },
        request,
        timer: undefined,
      };
      slot.timer = clock.setTimeout(() => send(slot), delay);
      slots.set(id, slot);
      changed();
      return id;
    },
    undo(id) {
      const slot = slots.get(id);
      if (!slot || slot.entry.status !== 'pending') return false;
      clock.clearTimeout(slot.timer);
      slots.delete(id);
      changed();
      slot.request.onUndo?.();
      return true;
    },
    flush(id) {
      const slot = slots.get(id);
      if (slot) send(slot);
    },
    flushAll() {
      for (const slot of [...slots.values()]) send(slot);
    },
    dismiss(id) {
      const slot = slots.get(id);
      if (!slot) return;
      if (slot.entry.status === 'pending') {
        send(slot);
        return;
      }
      if (slot.entry.status === 'failed') {
        slots.delete(id);
        changed();
      }
    },
    pause(id) {
      const slot = slots.get(id);
      if (!slot || slot.entry.status !== 'pending' || slot.entry.pausedRemainingMs !== null) return;
      clock.clearTimeout(slot.timer);
      slot.entry = {
        ...slot.entry,
        pausedRemainingMs: Math.max(0, slot.entry.deadline - clock.now()),
      };
      changed();
    },
    resume(id) {
      const slot = slots.get(id);
      const remaining = slot?.entry.pausedRemainingMs;
      if (!slot || slot.entry.status !== 'pending' || remaining === null || remaining === undefined)
        return;
      // At least a moment after the pointer leaves, so the toast never vanishes under it.
      const left = Math.max(remaining, 2_000);
      slot.entry = { ...slot.entry, deadline: clock.now() + left, pausedRemainingMs: null };
      slot.timer = clock.setTimeout(() => send(slot), left);
      changed();
    },
    isPending(key) {
      for (const slot of slots.values()) {
        if (slot.entry.key === key && slot.entry.status !== 'failed') return true;
      }
      return false;
    },
    entries: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The key of one object's held action: `undoKey('work', id)` → `work:<id>`. */
export function undoKey(
  kind: 'work' | 'project-member' | 'file-folder' | 'doc',
  id: string,
): string {
  return `${kind}:${id}`;
}

/** Keys whose action is held or in flight — a list hides these rows meanwhile. */
export function heldKeys(entries: readonly UndoEntry[]): ReadonlySet<string> {
  return new Set(entries.filter((entry) => entry.status !== 'failed').map((entry) => entry.key));
}
