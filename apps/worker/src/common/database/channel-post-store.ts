import { uuidv7 } from '@tmanage/domain';
import { decideAfterAttempt } from '../../jobs/webhook-retry-sweeper.js';
import { settle } from '../../jobs/channel-post-sweeper.js';
import type { ChannelPostStore } from '../../jobs/channel-post-sweeper.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * R15-c (54-05 / 54-06 Phase 0) — the worker's statements on 0289 `integration_channel_links` /
 * `integration_channel_posts` (and the one read of `outbox_events` a post needs). The staging
 * logic lives in `consumers/channel-notices.ts`, the sending logic in `jobs/channel-post-sweeper.ts`.
 */

/** An active link as staging reads it. */
export interface StagingLinkRow {
  readonly id: string;
  readonly events_json: unknown;
  readonly project_id: string | null;
  readonly locale: string;
}

/** The organization's active channel links, inside the event's transaction. */
export async function listActiveChannelLinks(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<readonly StagingLinkRow[]> {
  const rows = await tx.query<readonly StagingLinkRow[]>(
    'SELECT id, events_json, project_id, locale FROM integration_channel_links ' +
      "WHERE organization_id = ? AND status = 'active'",
    [organizationId],
  );
  return Array.isArray(rows) ? rows : [];
}

/** Stage one post for (link, event); the ledger's UNIQUE keeps it one per pair. */
export async function insertStagedChannelPost(
  tx: WorkerTransaction,
  post: {
    readonly organizationId: string;
    readonly linkId: string;
    readonly outboxEventId: string;
    readonly eventKind: string;
    readonly locale: string;
    readonly now: Date;
  },
): Promise<void> {
  await tx.query(
    'INSERT INTO integration_channel_posts (id, organization_id, link_id, outbox_event_id, event_kind, locale, ' +
      "status, attempt, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'staged', 1, ?, ?, ?)",
    [
      uuidv7(),
      post.organizationId,
      post.linkId,
      post.outboxEventId,
      post.eventKind,
      post.locale,
      post.now,
      post.now,
      post.now,
    ],
  );
}

/** The worker's statements on 0289. Every statement but the org scan names `organization_id`. */
export function createChannelPostStore(database: WorkerDatabase): ChannelPostStore {
  return {
    listDueOrganizations: (now) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { organization_id: string }[]>(
          'SELECT DISTINCT organization_id FROM integration_channel_posts ' +
            "WHERE status IN ('staged', 'sending') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) LIMIT 500",
          [now],
        );
        return rows.map((row) => row.organization_id);
      }),
    reopenStale: (organizationId, before) =>
      database.transaction(async (tx) => {
        await tx.query(
          "UPDATE integration_channel_posts SET status = 'staged' " +
            "WHERE organization_id = ? AND status = 'sending' AND updated_at < ?",
          [organizationId, before],
        );
      }),
    listDue: (organizationId, now, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly {
            id: string;
            link_id: string;
            outbox_event_id: string | null;
            event_kind: string;
            locale: string;
            attempt: number;
          }[]
        >(
          'SELECT id, link_id, outbox_event_id, event_kind, locale, attempt FROM integration_channel_posts ' +
            "WHERE organization_id = ? AND status = 'staged' AND next_attempt_at <= ? " +
            'ORDER BY next_attempt_at, id LIMIT ?',
          [organizationId, now, Math.max(1, Math.trunc(limit))],
        );
        return rows.map((row) => ({
          id: row.id,
          linkId: row.link_id,
          outboxEventId: row.outbox_event_id,
          eventKind: row.event_kind,
          locale: row.locale,
          attempt: Number(row.attempt),
        }));
      }),
    claim: (organizationId, id, now) =>
      database.transaction(async (tx) => {
        const result = await tx.query<{ affectedRows: number }>(
          "UPDATE integration_channel_posts SET status = 'sending', updated_at = ? " +
            "WHERE organization_id = ? AND id = ? AND status = 'staged'",
          [now, organizationId, id],
        );
        return result.affectedRows === 1;
      }),
    loadLink: (organizationId, linkId) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly { id: string; kind: string; status: string; webhook_url_enc: string }[]
        >(
          'SELECT id, kind, status, webhook_url_enc FROM integration_channel_links ' +
            'WHERE organization_id = ? AND id = ? LIMIT 1',
          [organizationId, linkId],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : { id: row.id, kind: row.kind, status: row.status, webhookUrlEnc: row.webhook_url_enc };
      }),
    loadEvent: (organizationId, eventId) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { payload_json: unknown }[]>(
          'SELECT payload_json FROM outbox_events WHERE organization_id = ? AND id = ? LIMIT 1',
          [organizationId, eventId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        let payload: unknown = row.payload_json;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }
        return { payload };
      }),
    orgSlug: (organizationId) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { slug: string }[]>(
          'SELECT slug FROM organizations WHERE id = ? LIMIT 1',
          [organizationId],
        );
        return rows[0]?.slug ?? null;
      }),
    finish: (organizationId, post, outcome, now) =>
      database.transaction(async (tx) => {
        let streakAfter = 0;
        if (outcome.status === 'success') {
          await tx.query(
            'UPDATE integration_channel_links SET failure_streak = 0, last_posted_at = ? ' +
              'WHERE organization_id = ? AND id = ?',
            [now, organizationId, post.linkId],
          );
        } else if (outcome.status === 'failure' || outcome.status === 'blocked_private_ip') {
          await tx.query(
            'UPDATE integration_channel_links SET failure_streak = failure_streak + 1 ' +
              'WHERE organization_id = ? AND id = ?',
            [organizationId, post.linkId],
          );
          const rows = await tx.query<readonly { failure_streak: number }[]>(
            'SELECT failure_streak FROM integration_channel_links WHERE organization_id = ? AND id = ? LIMIT 1',
            [organizationId, post.linkId],
          );
          streakAfter = Number(rows[0]?.failure_streak ?? 0);
        }
        const settled = settle(
          outcome,
          decideAfterAttempt(outcome, post.attempt, streakAfter),
          now,
        );
        await tx.query(
          'UPDATE integration_channel_posts SET status = ?, attempt = ?, next_attempt_at = ?, ' +
            'last_status_code = ?, last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?',
          [
            settled.postStatus,
            settled.postStatus === 'staged' ? post.attempt + 1 : post.attempt,
            settled.nextAttemptAt,
            outcome.responseCode,
            outcome.error === null ? null : outcome.error.slice(0, 500),
            now,
            organizationId,
            post.id,
          ],
        );
        if (settled.pause !== null) {
          await tx.query(
            "UPDATE integration_channel_links SET status = 'paused', paused_reason = ?, updated_at = ? " +
              "WHERE organization_id = ? AND id = ? AND status = 'active'",
            [settled.pause, now, organizationId, post.linkId],
          );
        }
        return settled;
      }),
  };
}
