import { ApiRequestError, NetworkError } from '../api/errors';
import type { OfflineQueue, OfflineWrite } from './queue';
import type { OfflineTransport } from './transport';

/**
 * 53-16. Sending the queue when the connection is back.
 *
 * - **In order.** Oldest first, one at a time: a status change queued after a comment reaches
 *   the server after it.
 * - **A dropped connection stops the run** and leaves everything from that write on queued.
 * - **A refusal becomes a conflict, not a loss.** The entry stays, marked `conflict`, with the
 *   status and code (and, for a status change, the state the item is in now) for the card.
 *   Later writes on the *same* item wait behind it, so they cannot land out of order; writes on
 *   other items carry on.
 * - **A session that ended stops the run.** The auth boundary clears the queue right after.
 */

export type ReplayOutcome = 'done' | 'offline' | 'signed-out';

export interface ReplayResult {
  readonly outcome: ReplayOutcome;
  readonly sent: number;
  readonly conflicts: number;
}

export async function replayQueue(
  queue: OfflineQueue,
  transport: OfflineTransport,
): Promise<ReplayResult> {
  await queue.load();
  let sent = 0;
  let conflicts = 0;
  const blocked = new Set<string>();
  for (const write of [...queue.list()].sort((a, b) => a.seq - b.seq)) {
    if (write.status === 'conflict') {
      blocked.add(write.workItemId);
      continue;
    }
    if (blocked.has(write.workItemId)) continue;
    try {
      await transport.send(write);
      await queue.remove(write.id);
      sent += 1;
    } catch (error) {
      if (error instanceof NetworkError) return { outcome: 'offline', sent, conflicts };
      if (error instanceof ApiRequestError && error.status === 401) {
        return { outcome: 'signed-out', sent, conflicts };
      }
      const status = error instanceof ApiRequestError ? error.status : 0;
      const code = error instanceof ApiRequestError ? error.code : 'internal_error';
      const now = write.kind === 'transition' ? await transport.current(write) : undefined;
      await queue.update({
        ...write,
        status: 'conflict',
        conflict: { status, code, ...(now ? { theirs: now.state } : {}) },
      } as OfflineWrite);
      blocked.add(write.workItemId);
      conflicts += 1;
    }
  }
  return { outcome: 'done', sent, conflicts };
}

/**
 * "Keep mine": send it again. A status change is re-based on the item's current version, so the
 * person's choice wins over the change that beat it; the other writes are re-sent as they are.
 */
export async function keepMine(
  queue: OfflineQueue,
  transport: OfflineTransport,
  write: OfflineWrite,
): Promise<ReplayResult> {
  let next: OfflineWrite = { ...write, status: 'pending' } as OfflineWrite;
  delete (next as { conflict?: unknown }).conflict;
  if (next.kind === 'transition') {
    const now = await transport.current(next);
    if (now) next = { ...next, payload: { ...next.payload, version: now.version } };
  }
  await queue.update(next);
  return replayQueue(queue, transport);
}

/** "Take theirs": drop my change; the server's version stands. Later writes may now go. */
export async function takeTheirs(
  queue: OfflineQueue,
  transport: OfflineTransport,
  write: OfflineWrite,
): Promise<ReplayResult> {
  await queue.remove(write.id);
  return replayQueue(queue, transport);
}
