import { hasCapability, isRole } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  clientRecipientStillPermitted,
  findRequestSubmitter,
  insertNotification,
  listActiveInternalMemberships,
} from '../common/database/notifications-store.js';
import type { InternalRecipientCandidate } from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';

/**
 * The notification consumers — NOTIF-001's first half, on the two events
 * `24-EVENT-CATALOG` §4 names "notification" as a primary consumer for.
 *
 * ## Who is told what
 *
 * - **A request is submitted** → the people who can answer it: every internal member whose
 *   role ceiling includes `client_request.triage` *and* who can reach the project — org-wide
 *   scope, or a project membership. That is `mayTriage`'s rule from the API restated from
 *   the same source rather than copied: the capability half is asked of `capabilitiesFor`,
 *   the domain's own ceiling table, and the relation half mirrors `authorize()`'s
 *   internal-relation rule (org-wide scope or a project relation).
 * - **A request transitions** → the person who asked: `submitted_by_user_id`. The answer to
 *   a request is the one thing its submitter is always owed — except `withdrawn`, which is
 *   the submitter's own act (the only client-performed transition §6 of `23-ERD` has), and
 *   telling someone what they just did is noise.
 *
 * ## §6 of the catalog, obeyed at delivery time
 *
 * "Consumers cannot infer authorization from event receipt … Delayed notifications must not
 * reveal an object after access was revoked." Both recipient sets are computed from the
 * *current* membership rows inside the delivery transaction: an internal member suspended
 * between the event and its delivery is not told, and a client whose membership expired —
 * or whose organization lost the project share — is not told either. The notification row
 * itself carries only a reference (type, object type, object id), so even a row written
 * before a revocation reveals nothing at read time: the reader resolves the object through
 * the ordinary authorized read path, which answers 404.
 *
 * ## Idempotent by the table's own key
 *
 * `uq_notifications_dedupe` absorbs at-least-once redelivery. The transitioned key carries
 * the request *version*, so `triage → needs_clarification → triage → needs_clarification`
 * — a legal cycle — notifies each time, while a replay of one event never doubles.
 */

/** The recipient rule for a submitted request, pure so the unit suite can enumerate it. */
export function mayTriageClientRequests(candidate: InternalRecipientCandidate): boolean {
  if (!isRole(candidate.role)) return false;
  if (!hasCapability(candidate.role, 'client_request.triage')) return false;
  return candidate.hasOrgWideScope || candidate.onProject;
}

interface SubmittedPayload {
  readonly requestId: string;
  readonly projectId: string;
}

interface TransitionedPayload {
  readonly requestId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly toStatus: string;
  readonly requestVersion: number;
}

function stringField(payload: Record<string, unknown>, key: string, eventId: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`event ${eventId} has no readable ${key}`);
  }
  return value;
}

function payloadOf(event: ClaimedOutboxEvent): Record<string, unknown> {
  if (event.payload !== null && typeof event.payload === 'object') {
    return event.payload as Record<string, unknown>;
  }
  throw new Error(`event ${event.id} has no readable payload`);
}

export const clientRequestSubmittedConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const raw = payloadOf(event);
  const payload: SubmittedPayload = {
    requestId: stringField(raw, 'requestId', event.id),
    projectId: stringField(raw, 'projectId', event.id),
  };

  const candidates = await listActiveInternalMemberships(
    tx,
    event.organizationId,
    payload.projectId,
  );

  for (const candidate of candidates.filter(mayTriageClientRequests)) {
    await insertNotification(tx, {
      organizationId: event.organizationId,
      recipientUserId: candidate.userId,
      type: event.type,
      objectType: 'client_request',
      objectId: payload.requestId,
      // One submission ever, so the request id alone is replay-proof.
      dedupeKey: `client_request.submitted:${payload.requestId}`,
    });
  }
};

export const clientRequestTransitionedConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const raw = payloadOf(event);
  const version = raw['requestVersion'];
  const payload: TransitionedPayload = {
    requestId: stringField(raw, 'requestId', event.id),
    projectId: stringField(raw, 'projectId', event.id),
    clientOrganizationId: stringField(raw, 'clientOrganizationId', event.id),
    toStatus: stringField(raw, 'toStatus', event.id),
    requestVersion: typeof version === 'number' ? version : 0,
  };

  // The submitter's own act — see the module doc. Told nothing, deliberately.
  if (payload.toStatus === 'withdrawn') return;

  const submitter = await findRequestSubmitter(tx, event.organizationId, payload.requestId);
  if (submitter === null) return; // The row is gone; there is nothing safe to reference.

  const permitted = await clientRecipientStillPermitted(tx, {
    organizationId: event.organizationId,
    userId: submitter,
    clientOrganizationId: payload.clientOrganizationId,
    projectId: payload.projectId,
  });
  if (!permitted) return; // §6: revoked between event and delivery means silence.

  await insertNotification(tx, {
    organizationId: event.organizationId,
    recipientUserId: submitter,
    type: event.type,
    objectType: 'client_request',
    objectId: payload.requestId,
    // The version distinguishes a legal state cycle from a redelivery of one event.
    dedupeKey: `client_request.transitioned:${payload.requestId}:${payload.toStatus}:${payload.requestVersion}`,
  });
};
