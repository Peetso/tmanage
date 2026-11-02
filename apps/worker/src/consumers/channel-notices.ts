import {
  insertStagedChannelPost,
  listActiveChannelLinks,
} from '../common/database/channel-post-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { OutboxHandler, OutboxHandlers } from '../outbox/dispatcher.js';
import {
  WEBHOOK_SOURCES,
  WEBHOOK_SOURCE_TYPES,
  eventFiresKind,
  parseEvents,
} from './webhook-deliveries.js';

/**
 * R15-c (54-05 Slack + 54-06 Teams, Phase 0) — channel notice staging.
 *
 * Answers the same outbox types as webhook staging ({@link WEBHOOK_SOURCE_TYPES}) and, inside the
 * event's transaction, stages one `staged` row in `integration_channel_posts` per **active** link
 * whose events include a kind the event fires and whose `project_id` is NULL (whole org) or the
 * event's project. One row per (link, event) — the ledger's UNIQUE — so when two kinds fire on one
 * event (`work.updated` and `work.completed`), the narrower, filtered kind is the one posted.
 * Nothing leaves the process here; `jobs/channel-post-sweeper.ts` posts.
 */

export interface StagingLink {
  readonly id: string;
  readonly events_json: unknown;
  readonly project_id: string | null;
  readonly locale: string;
}

/** The kind to post for one link, or null when the link does not take this event. */
export function channelKindFor(link: StagingLink, type: string, payload: unknown): string | null {
  const projectId =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['projectId']
      : undefined;
  if (link.project_id !== null && link.project_id !== projectId) return null;
  const kinds = parseEvents(link.events_json).filter((kind) => eventFiresKind(kind, type, payload));
  if (kinds.length === 0) return null;
  return kinds.find((kind) => WEBHOOK_SOURCES[kind]?.filter !== undefined) ?? (kinds[0] as string);
}

export const channelNoticeStagingConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const rows = await listActiveChannelLinks(tx, event.organizationId);
  if (rows.length === 0) return;
  const now = new Date();
  for (const link of rows) {
    const kind = channelKindFor(link, event.type, event.payload);
    if (kind === null) continue;
    await insertStagedChannelPost(tx, {
      organizationId: event.organizationId,
      linkId: link.id,
      outboxEventId: event.id,
      eventKind: kind,
      locale: link.locale,
      now,
    });
  }
};

/** Channel staging composed after whatever already answers each source type. */
export function withChannelNoticeStaging(handlers: OutboxHandlers): OutboxHandlers {
  const composed: Record<string, OutboxHandler> = { ...handlers };
  for (const type of WEBHOOK_SOURCE_TYPES) {
    const existing = handlers[type];
    composed[type] =
      existing === undefined
        ? channelNoticeStagingConsumer
        : async (event, tx, effects) => {
            await existing(event, tx, effects);
            await channelNoticeStagingConsumer(event, tx, effects);
          };
  }
  return composed;
}
