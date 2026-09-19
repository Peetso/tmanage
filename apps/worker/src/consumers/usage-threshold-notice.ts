import { isInternalRole } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  insertNotification,
  listActiveOrgWideMemberships,
} from '../common/database/notifications-store.js';
import type { OrgWideMembershipCandidate } from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';

/**
 * USAGE-001 slice 4b — the consumer of `usage.threshold_reached.v1` (x63 emits it, nobody
 * consumed it yet). It tells the organization's billing owners that their storage crossed a
 * threshold band, in the one canonical channel: the in-app inbox notice
 * (`35-NOTIFICATION-AND-EMAIL-COPY` §1, INBOX-001's `notifications` table).
 *
 * ## Who is told — `12-PERMISSION-MATRIX` §1's "Billing/ownership" row
 *
 * `docs/implementation-status.md` fixes slice 4's recipients as the organization-wide **owner**
 * and **org_admin** memberships — no new capability, because the matrix already puts billing in
 * those two roles and nowhere else. The rule is the pure {@link isUsageThresholdRecipient}, so it
 * is enumerated in a unit test against `INTERNAL_ROLES` rather than trusted; the store returns the
 * active set and this decides, the same split the sibling `mayTriageClientRequests` uses.
 *
 * ## Tenant-scoped, and §6-safe by being a reference
 *
 * Recipients are read from the *current* active memberships inside the delivery transaction and
 * only within the event's own organization, so a membership ended between the event and its
 * delivery is not told (`24-EVENT-CATALOG` §6). The notice row is a reference envelope — `type`,
 * `object_type`, `object_id`, never content — pointing at `organization_usage`; the band %, and
 * the used+reserved-of-quota bytes the copy shows, are rendered by the inbox reader from the usage
 * read model at display time (USAGE-001 slice 5), exactly as the sibling notices render their copy
 * from the object they reference. The `notifications` trigger forbids storing content here.
 *
 * ## Idempotent on redelivery
 *
 * The dedupe key is built from the payload's `idempotencyKey` (`<counterId>:<band>:<counterVersion>`),
 * the value x63's producer documents "the notification consumer dedupes on". `uq_notifications_dedupe`
 * (org, recipient, dedupeKey) turns an at-least-once redelivery of the same crossing into a no-op,
 * while a re-entry after the usage fell back below the hysteresis floor carries a fresh counter
 * version — a new key — and is delivered again.
 *
 * ## Mail is a recorded follow-up
 *
 * Acceptance §1's mail is conditional on the existing mail path having a reusable template
 * mechanism. It does not: the only mailer is `ClientRequestMailer`, whose templates and facts are
 * client-request-specific, so a usage mail would need a new template file — the acceptance's
 * "ship the inbox notice only and record the mail as follow-up" branch. Quiet-hours handling —
 * including §3's yes-critical 100-band bypass — belongs to that mail follow-up: in-app notices are
 * never deferred (only interrupting channels are), so quiet hours does not gate this consumer, and
 * no bypass classification is carried here until there is a mail channel for it to govern.
 */

/** The notice `object_type` — the aggregate `24-EVENT-CATALOG` §4 names for this event. */
const USAGE_OBJECT_TYPE = 'organization_usage';

/**
 * The recipient rule: an org-wide owner or org_admin membership, and no one else. Pure so the
 * unit suite can enumerate it against `INTERNAL_ROLES`. `has_org_wide_scope` is required because
 * billing is an organization-wide concern — a workspace-scoped owner/admin is not a billing
 * recipient.
 */
export function isUsageThresholdRecipient(candidate: OrgWideMembershipCandidate): boolean {
  if (!isInternalRole(candidate.role)) return false;
  if (candidate.role !== 'owner' && candidate.role !== 'org_admin') return false;
  return candidate.hasOrgWideScope;
}

interface ThresholdPayload {
  readonly idempotencyKey: string;
}

function readPayload(event: ClaimedOutboxEvent): ThresholdPayload {
  if (event.payload === null || typeof event.payload !== 'object') {
    throw new Error(`event ${event.id} has no readable payload`);
  }
  const raw = event.payload as Record<string, unknown>;
  const idempotencyKey = raw['idempotencyKey'];
  if (typeof idempotencyKey !== 'string') {
    throw new Error(`event ${event.id} has no readable idempotencyKey`);
  }
  return { idempotencyKey };
}

export const usageThresholdReachedConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const payload = readPayload(event);
  const candidates = await listActiveOrgWideMemberships(tx, event.organizationId);

  for (const candidate of candidates.filter(isUsageThresholdRecipient)) {
    await insertNotification(tx, {
      organizationId: event.organizationId,
      recipientUserId: candidate.userId,
      type: event.type,
      objectType: USAGE_OBJECT_TYPE,
      // The organization's usage is the object; the reader resolves current usage under it.
      objectId: event.organizationId,
      // The crossing's idempotency key — a redelivery repeats it, a re-arm mints a fresh one.
      dedupeKey: `usage.threshold_reached:${payload.idempotencyKey}`,
    });
  }
};
