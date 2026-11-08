import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from '../api/client';
import {
  getWorkItem,
  transitionWorkItem,
  updateChecklistItem,
  type WorkComment,
  type WorkItemSummary,
  type TimeLog,
  type WorkChecklistItem,
} from '../api/work-items';
import type { OfflineWrite } from './queue';

/**
 * 53-16. How one queued write reaches the API — the same routes and the same permissions as the
 * online screens; nothing here is a new server path.
 *
 * - comment → `POST work-items/:id/comments` with `Idempotency-Key`
 * - time entry → `POST work-items/:id/time-logs` with `Idempotency-Key`
 * - checklist tick → `PATCH work-items/:id/checklist/:itemId` (`done` is a value: repeat-safe)
 * - status change → `POST work-items/:id/transitions` with the `version` it was made against
 *   (a replay against a changed item is the API's own 409, which becomes the conflict card)
 *
 * The server decides tenant scope and permission on every one of them, exactly as online.
 */

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

function itemPath(slug: string, workItemId: string): string {
  return `/v1/organizations/${encodeURIComponent(slug)}/work-items/${encodeURIComponent(workItemId)}`;
}

export type SentResult = WorkComment | TimeLog | WorkChecklistItem | WorkItemSummary;

export interface OfflineTransport {
  send(write: OfflineWrite): Promise<SentResult>;
  /** The item as the server has it now, for "keep mine" and for the conflict card. */
  current(write: OfflineWrite): Promise<{ state: string; version: number } | undefined>;
}

export function apiTransport(client: ApiClient): OfflineTransport {
  return {
    async send(write) {
      const { workspaceSlug: slug, workItemId } = write;
      switch (write.kind) {
        case 'comment': {
          const { data } = await client.request<WorkComment>({
            method: 'POST',
            path: `${itemPath(slug, workItemId)}/comments`,
            body: { body: write.payload.body },
            headers: { [IDEMPOTENCY_HEADER]: write.idempotencyKey },
          });
          return data;
        }
        case 'time-log': {
          const { data } = await client.request<TimeLog>({
            method: 'POST',
            path: `${itemPath(slug, workItemId)}/time-logs`,
            body: write.payload,
            headers: { [IDEMPOTENCY_HEADER]: write.idempotencyKey },
          });
          return data;
        }
        case 'checklist':
          return updateChecklistItem(client, slug, workItemId, write.payload.itemId, {
            done: write.payload.done,
          });
        case 'transition':
          return transitionWorkItem(client, slug, workItemId, {
            version: write.payload.version,
            to: write.payload.to as WorkItemState,
            facts: write.payload.facts,
          });
      }
    },
    async current(write) {
      try {
        const item = await getWorkItem(client, write.workspaceSlug, write.workItemId);
        return { state: item.state, version: item.version };
      } catch {
        return undefined;
      }
    },
  };
}
