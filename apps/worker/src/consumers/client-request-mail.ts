import { eventTypeBypassesQuietHours, isInQuietHours, quietHoursResumeAt } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { findClientRequestMailFacts } from '../common/database/mail-store.js';
import {
  clientRecipientStillPermitted,
  decodeQuietHoursMailResume,
  enqueueQuietHoursMailResume,
  findRecipientQuietHours,
  findRequestSubmitter,
} from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects, OutboxHandler } from '../outbox/dispatcher.js';
import { mailKindForStatus } from '../notifications/client-request-mailer.js';
import type {
  ClientRequestMailer,
  ClientRequestMailKind,
} from '../notifications/client-request-mailer.js';

/**
 * The mail consumers — the second producer on the `Mailer` port, and the first one that is
 * not the API.
 *
 * ## The shape, which is the whole point of the ticket
 *
 * Each consumer does its reading **inside** the batch transaction and hands the send to
 * `effects.afterCommit`, which the dispatcher runs once the batch has committed. That split
 * is not tidiness: a handler that called SMTP directly would hold the batch's open
 * transaction, and the claim's `FOR UPDATE SKIP LOCKED` row locks, across a network call to a
 * host this process does not control. The API's invitation producer avoids exactly that by
 * sending after its own commit; this is the same rule, on the relay's side.
 *
 * The consequence, stated rather than hidden: mail is **at-most-once**. An effect runs only
 * if the batch committed, and a committed batch has already stamped `published_at`, so the
 * event is never claimed again and a failed send is never retried. The in-app notification —
 * canonical per `35-NOTIFICATION-AND-EMAIL-COPY` §1 — is the one written transactionally and
 * is the one that survives.
 *
 * ## §6 of the event catalog is obeyed twice, not once
 *
 * `24-EVENT-CATALOG` §6 forbids a consumer inferring authorization from event receipt, and
 * forbids a delayed notification revealing an object after access was revoked. The
 * notification consumers already re-resolve the client's three-part permission at delivery.
 * These consumers re-resolve it too, from the same store function, because an email is
 * *worse* than a notification row in exactly the way §6 cares about: a notification carries a
 * reference and is re-checked when the reader opens it, while an email carries its content
 * permanently and has no second check. So a client whose membership expired, or whose
 * organization lost the project share, between the event and its delivery gets no mail — and
 * the check is made in the same transaction as the read, not before it.
 *
 * ## Composed with the notification consumers, not instead of them
 *
 * One event type takes one handler, so `registry.ts` composes the notification consumer and
 * the mail consumer into one. Order matters: the notification is written first, so a mail
 * consumer that throws rolls back an event whose notification will be re-inserted on redelivery
 * — idempotently, by `uq_notifications_dedupe`.
 */

function payloadOf(event: ClaimedOutboxEvent): Record<string, unknown> {
  if (event.payload !== null && typeof event.payload === 'object') {
    return event.payload as Record<string, unknown>;
  }
  throw new Error(`event ${event.id} has no readable payload`);
}

function stringField(payload: Record<string, unknown>, key: string, eventId: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`event ${eventId} has no readable ${key}`);
  }
  return value;
}

/**
 * Everything the two consumers share: resolve the submitter, re-check their access, read the
 * facts, and stage the send. Returns without staging anything when any step says no.
 *
 * ## Quiet hours — INBOX-001, the one behaviour this ticket added here
 *
 * Email is an interrupting channel. Before it is staged, the recipient's quiet window is read
 * (`findRecipientQuietHours`) and, if the submitter is inside it and the event type is not one
 * `24-EVENT-CATALOG` marks urgent, the send is **deferred, not dropped**: the event is
 * re-enqueued as a dedicated {@link QUIET_HOURS_MAIL_RESUME_TYPE} row with `available_at` set to
 * the window's end, and nothing is staged on this pass. The in-app notification the composed
 * notification consumer already wrote stays committed — only the email waits. When the resume row
 * comes due it is dispatched to {@link createQuietHoursMailResume}, which calls this with
 * `deferForQuietHours: false` so the mail is staged unconditionally — a deferral is one hop. A
 * `null` resume time (not actually in the window by the time this reads) falls through to an
 * immediate send.
 */
async function stageClientMail(input: {
  readonly event: ClaimedOutboxEvent;
  readonly tx: WorkerTransaction;
  readonly effects: OutboxEffects;
  readonly mailer: ClientRequestMailer;
  readonly kind: ClientRequestMailKind;
  readonly requestId: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  /** True on the original delivery (may defer); false on the resume pass (send now). */
  readonly deferForQuietHours: boolean;
}): Promise<void> {
  const { event, tx, effects, mailer, kind, requestId } = input;

  const submitter = await findRequestSubmitter(tx, event.organizationId, requestId);
  if (submitter === null) return; // The row is gone; there is nothing to say about it.

  const permitted = await clientRecipientStillPermitted(tx, {
    organizationId: event.organizationId,
    userId: submitter,
    clientOrganizationId: input.clientOrganizationId,
    projectId: input.projectId,
  });
  if (!permitted) return; // §6: revoked between event and delivery means silence.

  const facts = await findClientRequestMailFacts(tx, event.organizationId, requestId);
  if (facts === null) return;

  // INBOX-001: honour the recipient's quiet hours on the first delivery only. A resume pass has
  // already waited out the window; an urgent kind never waits.
  if (input.deferForQuietHours && !eventTypeBypassesQuietHours(event.type)) {
    const now = new Date();
    const quietHours = await findRecipientQuietHours(tx, event.organizationId, submitter);
    if (isInQuietHours(now, quietHours)) {
      const resumeAt = quietHoursResumeAt(now, quietHours);
      if (resumeAt !== null) {
        await enqueueQuietHoursMailResume(tx, event, resumeAt);
        return; // Interrupting send deferred to the window's end; in-app row already written.
      }
    }
  }

  effects.afterCommit(async () => {
    await mailer.deliver(kind, requestId, facts);
  });
}

/** `Request received` — §3's first client-request template, on the submission event. */
export function createClientRequestSubmittedMail(mailer: ClientRequestMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return; // No transport: do not pay for the join.

    const raw = payloadOf(event);
    await stageClientMail({
      event,
      tx,
      effects,
      mailer,
      kind: 'received',
      requestId: stringField(raw, 'requestId', event.id),
      projectId: stringField(raw, 'projectId', event.id),
      clientOrganizationId: stringField(raw, 'clientOrganizationId', event.id),
      deferForQuietHours: true,
    });
  };
}

/**
 * `Clarification required`, `Request accepted`, `Request declined` and `Request deferred` — the
 * destination states the client is owed an answer about (REQ-03). The mailer's `KIND_BY_STATUS`
 * decides which; a transition to any other state is notified in-app and mailed to nobody.
 */
export function createClientRequestTransitionedMail(mailer: ClientRequestMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;

    const raw = payloadOf(event);
    const kind = mailKindForStatus(stringField(raw, 'toStatus', event.id));
    if (kind === null) return;

    await stageClientMail({
      event,
      tx,
      effects,
      mailer,
      kind,
      requestId: stringField(raw, 'requestId', event.id),
      projectId: stringField(raw, 'projectId', event.id),
      clientOrganizationId: stringField(raw, 'clientOrganizationId', event.id),
      deferForQuietHours: true,
    });
  };
}

/**
 * The quiet-hours resume consumer — INBOX-001, the second half of the deferral.
 *
 * A deferred interrupting delivery is re-enqueued as a dedicated internal event type
 * ({@link QUIET_HOURS_MAIL_RESUME_TYPE}) whose payload wraps the original type and payload. Only
 * this handler is registered for that type (see `registry.ts`), so the notification consumer — and
 * any future consumer of the real `client_request.*` types — never sees a resume row and cannot
 * double-fire on it. When the row comes due this unwraps the envelope, recovers the mail kind from
 * the original type, and stages the send unconditionally (`deferForQuietHours: false` — the window
 * was already waited out). The §6 permission re-check still runs inside {@link stageClientMail},
 * so a revocation between defer and resume still silences the mail; tenant scoping is the resume
 * row's own `organizationId`, copied from the original.
 */
export function createQuietHoursMailResume(mailer: ClientRequestMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return; // No transport: do not pay for the join.

    const envelope = decodeQuietHoursMailResume(event);
    if (envelope === null) return; // Not a well-formed resume row; nothing to send.
    const { originalType, originalPayload } = envelope;

    let kind: ClientRequestMailKind | null;
    if (originalType === 'client_request.submitted.v1') {
      kind = 'received';
    } else if (originalType === 'client_request.transitioned.v1') {
      kind = mailKindForStatus(stringField(originalPayload, 'toStatus', event.id));
    } else {
      return; // No interrupting channel defers any other type today.
    }
    if (kind === null) return;

    await stageClientMail({
      event,
      tx,
      effects,
      mailer,
      kind,
      requestId: stringField(originalPayload, 'requestId', event.id),
      projectId: stringField(originalPayload, 'projectId', event.id),
      clientOrganizationId: stringField(originalPayload, 'clientOrganizationId', event.id),
      deferForQuietHours: false,
    });
  };
}
