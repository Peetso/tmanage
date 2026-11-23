import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from '../api/client';
import { NetworkError } from '../api/errors';
import type { TimeLog, WorkChecklistItem, WorkComment, WorkItemSummary } from '../api/work-items';
import {
  newIdempotencyKey,
  type NewOfflineWrite,
  type OfflineQueue,
  type OfflineWrite,
  type TimeLogPayload,
} from './queue';
import { apiTransport, type OfflineTransport, type SentResult } from './transport';
import { isOnline, offlineQueue } from './offline-runtime';

/**
 * 53-16. The four safe writes, offline-aware. A screen calls these instead of the plain API
 * functions: online they send at once (with an `Idempotency-Key` where the route takes one);
 * offline — or when the request never reaches the server — they queue the write and answer
 * `{ queued: true }`, so the screen clears its input and shows the item with a Pending badge.
 *
 * A refusal from the server (403, 404, 409, 400) is **not** queued: it is an answer, and the
 * screen shows it exactly as before.
 */

export interface Queued {
  readonly queued: true;
  readonly write: OfflineWrite;
}

export function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && (value as Queued).queued === true;
}

export interface OfflineDeps {
  readonly queue: OfflineQueue;
  readonly transport: OfflineTransport;
  readonly online: () => boolean;
}

function defaults(client: ApiClient): OfflineDeps {
  return { queue: offlineQueue(), transport: apiTransport(client), online: isOnline };
}

export async function sendOrQueue(
  input: NewOfflineWrite,
  deps: OfflineDeps,
): Promise<SentResult | Queued> {
  const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey();
  const withKey = { ...input, idempotencyKey } as NewOfflineWrite;
  if (deps.online()) {
    try {
      // A provisional entry: the transport needs the shape, the queue never sees it.
      return await deps.transport.send({
        ...withKey,
        id: 'direct',
        seq: 0,
        createdAt: new Date().toISOString(),
        status: 'pending',
      } as OfflineWrite);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
    }
  }
  // Same key as the attempt that may have reached the server: a replay cannot write twice.
  return { queued: true, write: await deps.queue.enqueue(withKey) };
}

export async function addCommentOrQueue(
  client: ApiClient,
  workspaceSlug: string,
  workItemId: string,
  body: string,
  deps: OfflineDeps = defaults(client),
): Promise<WorkComment | Queued> {
  return sendOrQueue(
    { kind: 'comment', workspaceSlug, workItemId, payload: { body } },
    deps,
  ) as Promise<WorkComment | Queued>;
}

export async function addTimeLogOrQueue(
  client: ApiClient,
  workspaceSlug: string,
  workItemId: string,
  payload: TimeLogPayload,
  deps: OfflineDeps = defaults(client),
): Promise<TimeLog | Queued> {
  return sendOrQueue({ kind: 'time-log', workspaceSlug, workItemId, payload }, deps) as Promise<
    TimeLog | Queued
  >;
}

export async function tickChecklistOrQueue(
  client: ApiClient,
  workspaceSlug: string,
  workItemId: string,
  item: Pick<WorkChecklistItem, 'id' | 'label'>,
  done: boolean,
  deps: OfflineDeps = defaults(client),
): Promise<WorkChecklistItem | Queued> {
  return sendOrQueue(
    {
      kind: 'checklist',
      workspaceSlug,
      workItemId,
      payload: { itemId: item.id, done, label: item.label },
    },
    deps,
  ) as Promise<WorkChecklistItem | Queued>;
}

/**
 * A status change. Queued, it answers the item as the person will see it — the new state, the
 * same version — so the screen moves on; the replay sends the version it was made against.
 */
export async function transitionOrQueue(
  client: ApiClient,
  workspaceSlug: string,
  item: WorkItemSummary,
  input: { readonly to: WorkItemState; readonly facts: Readonly<Record<string, string>> },
  deps: OfflineDeps = defaults(client),
): Promise<WorkItemSummary> {
  const result = await sendOrQueue(
    {
      kind: 'transition',
      workspaceSlug,
      workItemId: item.id,
      payload: { to: input.to, version: item.version, facts: input.facts },
    },
    deps,
  );
  return isQueued(result) ? { ...item, state: input.to } : (result as WorkItemSummary);
}
