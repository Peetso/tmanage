import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError } from '@/lib/api/errors';
import { AuthBoundary } from '@/lib/auth-boundary';
import { clearOfflineOnAuthChange } from '@/lib/offline/offline-runtime';
import { MemoryOfflineStore, OfflineQueue, textOf, type OfflineWrite } from '@/lib/offline/queue';
import { keepMine, replayQueue, takeTheirs } from '@/lib/offline/replay';
import type { OfflineTransport } from '@/lib/offline/transport';
import { isQueued, sendOrQueue, transitionOrQueue } from '@/lib/offline/write-or-queue';
import type { WorkItemSummary } from '@/lib/api/work-items';
import type { ApiClient } from '@/lib/api/client';

/** 53-16 Offline mode: queue, ordered replay, conflicts and the auth-boundary wipe. */

function newQueue(): OfflineQueue {
  let n = 0;
  return new OfflineQueue(
    new MemoryOfflineStore(),
    () => new Date(),
    () => `key-${++n}`,
  );
}

function transport(
  answer: (write: OfflineWrite) => unknown = () => ({}),
  current?: { state: string; version: number },
): OfflineTransport & { sent: OfflineWrite[] } {
  const sent: OfflineWrite[] = [];
  return {
    sent,
    async send(write) {
      const result = answer(write);
      if (result instanceof Error) throw result;
      sent.push(write);
      return result as never;
    },
    async current() {
      return current;
    },
  };
}

const conflict = () => new ApiRequestError(409, 'conflict', 'stale', 'corr');

function comment(queue: OfflineQueue, workItemId: string, body: string) {
  return queue.enqueue({ kind: 'comment', workspaceSlug: 'acme', workItemId, payload: { body } });
}

describe('offline queue', () => {
  it('keeps writes in order with their own idempotency keys', async () => {
    const queue = newQueue();
    const a = await comment(queue, 'w1', 'first');
    const b = await comment(queue, 'w1', 'second');
    expect(queue.list().map((w) => w.id)).toEqual([a.id, b.id]);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.status).toBe('pending');
  });

  it('gives "copy my text" the words the person typed', async () => {
    const queue = newQueue();
    const write = await comment(queue, 'w1', 'Client approved');
    expect(textOf(write)).toBe('Client approved');
  });
});

describe('replay', () => {
  it('sends everything in order and empties the queue', async () => {
    const queue = newQueue();
    await comment(queue, 'w1', 'one');
    await comment(queue, 'w2', 'two');
    const t = transport();
    const result = await replayQueue(queue, t);
    expect(result).toEqual({ outcome: 'done', sent: 2, conflicts: 0 });
    expect(t.sent.map((w) => (w.kind === 'comment' ? w.payload.body : ''))).toEqual(['one', 'two']);
    expect(queue.list()).toHaveLength(0);
  });

  it('stops on a dropped connection and keeps the rest queued', async () => {
    const queue = newQueue();
    await comment(queue, 'w1', 'one');
    await comment(queue, 'w1', 'two');
    const t = transport(() => new NetworkError('offline'));
    expect((await replayQueue(queue, t)).outcome).toBe('offline');
    expect(queue.list()).toHaveLength(2);
  });

  it('turns a refusal into a conflict and holds later writes on the same item', async () => {
    const queue = newQueue();
    await queue.enqueue({
      kind: 'transition',
      workspaceSlug: 'acme',
      workItemId: 'w1',
      payload: { to: 'in_review', version: 3, facts: {} },
    });
    await comment(queue, 'w1', 'after the move');
    await comment(queue, 'w2', 'other item');
    const t = transport((w) => (w.kind === 'transition' ? conflict() : {}), {
      state: 'blocked',
      version: 5,
    });
    const result = await replayQueue(queue, t);
    expect(result).toEqual({ outcome: 'done', sent: 1, conflicts: 1 });
    const [first, second] = queue.list();
    expect(first?.status).toBe('conflict');
    expect(first?.conflict).toEqual({ status: 409, code: 'conflict', theirs: 'blocked' });
    expect(second?.status).toBe('pending');
  });

  it('stops when the session has ended', async () => {
    const queue = newQueue();
    await comment(queue, 'w1', 'one');
    const t = transport(() => new ApiRequestError(401, 'unauthenticated', 'no', 'c'));
    expect((await replayQueue(queue, t)).outcome).toBe('signed-out');
  });

  it('"keep mine" re-sends a status change on the current version', async () => {
    const queue = newQueue();
    await queue.enqueue({
      kind: 'transition',
      workspaceSlug: 'acme',
      workItemId: 'w1',
      payload: { to: 'done', version: 3, facts: {} },
    });
    await replayQueue(
      queue,
      transport(() => conflict(), { state: 'blocked', version: 7 }),
    );
    const stuck = queue.list()[0]!;
    const t = transport(() => ({}), { state: 'blocked', version: 7 });
    await keepMine(queue, t, stuck);
    expect(t.sent[0]?.kind === 'transition' && t.sent[0].payload.version).toBe(7);
    expect(queue.list()).toHaveLength(0);
  });

  it('"take theirs" drops my change and lets the next one go', async () => {
    const queue = newQueue();
    await comment(queue, 'w1', 'refused');
    await comment(queue, 'w1', 'next');
    let refuse = true;
    const t = transport(() => (refuse ? new ApiRequestError(403, 'forbidden', 'no', 'c') : {}));
    await replayQueue(queue, t);
    refuse = false;
    await takeTheirs(queue, t, queue.list()[0]!);
    expect(queue.list()).toHaveLength(0);
    expect(t.sent.map((w) => (w.kind === 'comment' ? w.payload.body : ''))).toEqual(['next']);
  });
});

describe('send or queue', () => {
  it('sends at once when online', async () => {
    const queue = newQueue();
    const result = await sendOrQueue(
      { kind: 'comment', workspaceSlug: 'acme', workItemId: 'w1', payload: { body: 'hi' } },
      { queue, transport: transport(() => ({ id: 'c1' })), online: () => true },
    );
    expect(result).toEqual({ id: 'c1' });
    expect(queue.list()).toHaveLength(0);
  });

  it('queues with the same key when the request never arrives', async () => {
    const queue = newQueue();
    const keys: string[] = [];
    const t = transport((w) => {
      keys.push(w.idempotencyKey);
      return new NetworkError('down');
    });
    const result = await sendOrQueue(
      { kind: 'comment', workspaceSlug: 'acme', workItemId: 'w1', payload: { body: 'hi' } },
      { queue, transport: t, online: () => true },
    );
    expect(isQueued(result)).toBe(true);
    expect(queue.list()[0]?.idempotencyKey).toBe(keys[0]);
  });

  it('does not queue a refusal: it is an answer', async () => {
    const queue = newQueue();
    await expect(
      sendOrQueue(
        { kind: 'comment', workspaceSlug: 'acme', workItemId: 'w1', payload: { body: 'hi' } },
        { queue, transport: transport(() => conflict()), online: () => true },
      ),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(queue.list()).toHaveLength(0);
  });

  it('answers a queued status change with the new state on the old version', async () => {
    const queue = newQueue();
    const item = { id: 'w1', state: 'in_progress', version: 4 } as unknown as WorkItemSummary;
    const next = await transitionOrQueue(
      {} as ApiClient,
      'acme',
      item,
      { to: 'blocked', facts: {} },
      {
        queue,
        transport: transport(),
        online: () => false,
      },
    );
    expect(next).toMatchObject({ state: 'blocked', version: 4 });
    expect(queue.list()[0]).toMatchObject({ kind: 'transition', payload: { version: 4 } });
  });
});

describe('auth boundary', () => {
  it('clears the queue and the read cache on every boundary event', async () => {
    const queue = newQueue();
    await comment(queue, 'w1', 'mine');
    const boundary = new AuthBoundary();
    const clearCache = vi.fn(async () => undefined);
    clearOfflineOnAuthChange(boundary, () => queue, clearCache);
    boundary.announce('signed-out');
    await vi.waitFor(() => expect(queue.list()).toHaveLength(0));
    expect(clearCache).toHaveBeenCalledTimes(1);
  });
});
