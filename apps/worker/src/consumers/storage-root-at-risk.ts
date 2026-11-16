import { isInQuietHours, quietHoursResumeAt } from '@tmanage/domain';
import type { OutboxEventPayloads } from '@tmanage/domain';
import {
  decodeQuietHoursMailResume,
  enqueueQuietHoursMailResume,
  findActiveOrgWideMembership,
  findUsageMailRecipient,
  insertNotification,
  listActiveOrgWideMemberships,
} from '../common/database/notifications-store.js';
import type {
  OrgWideMembershipCandidate,
  UsageMailRecipient,
} from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects, OutboxHandler } from '../outbox/dispatcher.js';
import type { StorageRootMailer } from '../notifications/storage-root-mailer.js';

/**
 * 51-17 slice 2 — the consumer of `storage_connection.root_at_risk.v1`, produced by the API when
 * the person holding the company's storage leaves (offboarding, SCIM deactivation) and by the
 * weekly root check. It tells the workspace **owners** — the people who decide who holds the
 * company's files — in the inbox (a reference row: `storage_connection` + the connection id, no
 * content) and, when a transport is wired, by e-mail.
 *
 * Once per announcement: the notice's dedupe key is the event's idempotency key (connection,
 * reason, week or leave), and the mail is staged only when this delivery inserted the notice, so a
 * redelivery neither repeats the notice nor the mail. The mail honours the owner's mail toggle and
 * quiet hours (an owner in their quiet window gets a per-recipient resume row, as the usage mail
 * does); the inbox notice is never deferred.
 */

type RootAtRisk = OutboxEventPayloads['storage_connection.root_at_risk.v1'];

const OBJECT_TYPE = 'storage_connection';
const REASONS: readonly RootAtRisk['reason'][] = [
  'holder_offboarded',
  'holder_not_admin',
  'personal_root',
];

/** The recipient rule: an active, organization-wide owner membership, and no one else. */
export function isStorageRootRecipient(candidate: OrgWideMembershipCandidate): boolean {
  return candidate.role === 'owner' && candidate.hasOrgWideScope;
}

export function readRootAtRisk(event: ClaimedOutboxEvent): RootAtRisk {
  const raw = (
    event.payload !== null && typeof event.payload === 'object' ? event.payload : {}
  ) as Record<string, unknown>;
  const connectionId = raw['connectionId'];
  const provider = raw['provider'];
  const reason = REASONS.find((entry) => entry === raw['reason']);
  const idempotencyKey = raw['idempotencyKey'];
  const occurredAt = raw['occurredAt'];
  if (
    typeof connectionId !== 'string' ||
    (provider !== 'google_drive' && provider !== 'onedrive') ||
    reason === undefined ||
    typeof idempotencyKey !== 'string' ||
    typeof occurredAt !== 'string'
  ) {
    throw new Error(`event ${event.id} has no readable storage root payload`);
  }
  return {
    organizationId: event.organizationId,
    connectionId,
    provider,
    reason,
    idempotencyKey,
    occurredAt,
  };
}

function stageMail(
  effects: OutboxEffects,
  mailer: StorageRootMailer,
  recipient: UsageMailRecipient,
  payload: RootAtRisk,
): void {
  effects.afterCommit(async () => {
    await mailer.deliver({
      recipientEmail: recipient.email,
      recipientName: recipient.displayName,
      provider: payload.provider,
      reason: payload.reason,
    });
  });
}

/** The notice for every owner, and (with a mailer) each newly told owner's mail. */
export function createStorageRootAtRisk(mailer: StorageRootMailer | null): OutboxHandler {
  return async (event, tx, effects) => {
    const payload = readRootAtRisk(event);
    const owners = (await listActiveOrgWideMemberships(tx, event.organizationId)).filter(
      isStorageRootRecipient,
    );
    const now = new Date();
    for (const owner of owners) {
      const inserted = await insertNotification(tx, {
        organizationId: event.organizationId,
        recipientUserId: owner.userId,
        type: event.type,
        objectType: OBJECT_TYPE,
        objectId: payload.connectionId,
        dedupeKey: `storage_root:${payload.idempotencyKey}`,
      });
      if (!inserted || mailer === null) continue;
      const recipient = await findUsageMailRecipient(tx, event.organizationId, owner.userId);
      if (recipient === null || !recipient.emailEnabled) continue;
      if (isInQuietHours(now, recipient.quietHours)) {
        const resumeAt = quietHoursResumeAt(now, recipient.quietHours);
        if (resumeAt !== null) {
          await enqueueQuietHoursMailResume(tx, event, resumeAt, owner.userId);
          continue;
        }
      }
      stageMail(effects, mailer, recipient, payload);
    }
  };
}

/**
 * The resume half: a deferred owner mail, sent once their quiet window ended — if they are still
 * an active owner and still take mail. No-op on any other resume row.
 */
export function createStorageRootMailResume(mailer: StorageRootMailer): OutboxHandler {
  return async (event, tx, effects) => {
    const envelope = decodeQuietHoursMailResume(event);
    if (envelope === null || envelope.originalType !== 'storage_connection.root_at_risk.v1') return;
    const recipientUserId = envelope.recipientUserId;
    if (recipientUserId === undefined) return;
    const membership = await findActiveOrgWideMembership(tx, event.organizationId, recipientUserId);
    if (membership === null || !isStorageRootRecipient(membership)) return;
    const payload = readRootAtRisk({ ...event, payload: envelope.originalPayload });
    const recipient = await findUsageMailRecipient(tx, event.organizationId, recipientUserId);
    if (recipient === null || !recipient.emailEnabled) return;
    stageMail(effects, mailer, recipient, payload);
  };
}
