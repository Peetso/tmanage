import { describe, expect, it, vi } from 'vitest';
import {
  clampUndoDelay,
  createUndoQueue,
  heldKeys,
  undoKey,
  type UndoClock,
} from '../src/lib/undo/undo-queue';

/** A hand-driven clock: `advance(ms)` fires every timer that is due. */
function manualClock() {
  let now = 1_000;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: UndoClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { clock, advance };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('undo queue (55-23)', () => {
  it('holds the server call until the delay ends, then sends it once', async () => {
    const { clock, advance } = manualClock();
    const queue = createUndoQueue(clock);
    const commit = vi.fn(() => Promise.resolve());
    const onCommitted = vi.fn();
    queue.enqueue({ key: 'work:1', message: 'Item deleted', commit, onCommitted });

    advance(9_999);
    expect(commit).not.toHaveBeenCalled();
    expect(queue.isPending('work:1')).toBe(true);

    advance(1);
    await settle();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(queue.entries()).toEqual([]);
  });

  it('Undo drops the held call so nothing reaches the server', async () => {
    const { clock, advance } = manualClock();
    const queue = createUndoQueue(clock);
    const commit = vi.fn(() => Promise.resolve());
    const onUndo = vi.fn();
    const id = queue.enqueue({ key: 'work:1', message: 'Item deleted', commit, onUndo });

    expect(queue.undo(id)).toBe(true);
    advance(20_000);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(queue.isPending('work:1')).toBe(false);
  });

  it('closing the toast or leaving the page sends at once, and Undo is then too late', async () => {
    const { clock } = manualClock();
    const queue = createUndoQueue(clock);
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const a = queue.enqueue({ key: 'a', message: 'A', commit: first });
    queue.enqueue({ key: 'b', message: 'B', commit: second });

    queue.dismiss(a);
    expect(first).toHaveBeenCalledTimes(1);
    expect(queue.undo(a)).toBe(false);
    queue.flushAll();
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a failed send keeps a danger entry and shows the item again', async () => {
    const { clock, advance } = manualClock();
    const queue = createUndoQueue(clock);
    const onFailed = vi.fn();
    const id = queue.enqueue({
      key: 'work:1',
      message: 'Item deleted',
      commit: () => Promise.reject(new Error('409')),
      onFailed,
    });
    advance(10_000);
    await settle();
    expect(queue.entries()[0]?.status).toBe('failed');
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(heldKeys(queue.entries()).has('work:1')).toBe(false);
    queue.dismiss(id);
    expect(queue.entries()).toEqual([]);
  });

  it('clamps the hold to 5-10 seconds and keys objects by kind', () => {
    expect(clampUndoDelay(undefined)).toBe(10_000);
    expect(clampUndoDelay(1_000)).toBe(5_000);
    expect(clampUndoDelay(60_000)).toBe(10_000);
    expect(undoKey('file-folder', 'f-1')).toBe('file-folder:f-1');
  });

  it('FIX6 item 9: waits 10 s by default and stops counting while the toast is hovered or focused', async () => {
    const { clock, advance } = manualClock();
    const queue = createUndoQueue(clock);
    const commit = vi.fn(() => Promise.resolve());
    const id = queue.enqueue({ key: 'file:1', message: 'File deleted', commit });
    advance(6_000);
    queue.pause(id);
    expect(queue.entries()[0]?.pausedRemainingMs).toBe(4_000);
    advance(30_000);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    queue.resume(id);
    advance(3_999);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    advance(1);
    await settle();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
