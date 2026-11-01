import { uuidv7 } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * R7 slice 5 — the worker's statements on `link_previews` (and the one read of `messages` it needs).
 * Every statement names `organization_id`, which leads both unique keys.
 */

/** A live message's body, or `null` when it is gone (removed, or another tenant's id). */
export async function findMessageBody(
  tx: WorkerTransaction,
  organizationId: string,
  messageId: string,
): Promise<string | null> {
  const rows = await tx.query<{ body: string }[]>(
    'SELECT body FROM messages WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [organizationId, messageId],
  );
  return rows[0]?.body ?? null;
}

/**
 * Stage the message's preview as `pending` (one per message: a redelivery, or a row the API staged,
 * collides on `uq_link_previews_message`), and answer the row as it now stands.
 */
export async function stageLinkPreview(
  tx: WorkerTransaction,
  organizationId: string,
  messageId: string,
  url: string,
): Promise<{ url: string; status: string } | null> {
  await tx.query(
    'INSERT INTO link_previews (id, organization_id, message_id, url, status, created_at) ' +
      "VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id = id",
    [uuidv7(), organizationId, messageId, url],
  );
  const rows = await tx.query<{ url: string; status: string }[]>(
    'SELECT url, status FROM link_previews WHERE organization_id = ? AND message_id = ? LIMIT 1',
    [organizationId, messageId],
  );
  return rows[0] ?? null;
}

export interface LinkPreviewOutcome {
  readonly status: 'ready' | 'failed';
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
}

/** Record the unfurl's outcome on a still-pending row. */
export async function finishLinkPreview(
  tx: WorkerTransaction,
  organizationId: string,
  messageId: string,
  outcome: LinkPreviewOutcome,
): Promise<void> {
  await tx.query(
    'UPDATE link_previews SET status = ?, title = ?, description = ?, image_url = ?, site_name = ? ' +
      "WHERE organization_id = ? AND message_id = ? AND status = 'pending'",
    [
      outcome.status,
      outcome.title,
      outcome.description,
      outcome.imageUrl,
      outcome.siteName,
      organizationId,
      messageId,
    ],
  );
}
