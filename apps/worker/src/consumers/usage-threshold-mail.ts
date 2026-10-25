import { eventBypassesQuietHours, isInQuietHours, quietHoursResumeAt } from '@tmanage/domain';
import {
  decodeQuietHoursMailResume,
  enqueueQuietHoursMailResume,
  findActiveOrgWideMembership,
  findUsageMailRecipient,
  listActiveOrgWideMemberships,
} from '../common/database/notifications-store.js';
import type { UsageMailRecipient } from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects, OutboxHandler } from '../outbox/dispatcher.js';
import type { UsageThresholdMailer } from '../notifications/usage-threshold-mailer.js';
import { isUsageThresholdRecipient } from './usage-threshold-notice.js';

/**
 * USAGE-001 slice 4c — the mail half of `usage.threshold_reached.v1`, composed in `registry.ts`
 * with x68's inbox-notice consumer (`both(notice, mail)`). It completes the follow-up x68
 * recorded: the notice ships unconditionally; the mail is the interrupting channel, so it honours
 * NOTIF-001 and INBOX-001.
 *
 * ## The same shape as the client-request mail, and where it must differ
 *
 * Like `client-request-mail.ts`, it reads inside the batch transaction and hands each send to
 * `effects.afterCommit` — a handler that called SMTP directly would hold the batch's transaction
 * and the claim's row locks across a network round trip. Mail is at-most-once on the far side of
 * a commit that is at-least-once; the canonical channel is the in-app notice x68 already wrote.
 *
 * It differs in one structural way: this event **fans out** to every org-wide owner/admin, not to
 * one submitter. So three things are per-recipient, not per-event:
 *
 * - **The mail-channel toggle (acceptance §2).** Each recipient's `notification_preferences`
 *   `email_enabled` is read at delivery ({@link findUsageMailRecipient}) and a recipient who
 *   turned mail off is skipped — the in-app notice still reached them (x68's design, unconditional).
 *   The existing relay mailers honour NOTIF-001 for their recipients through the quiet-hours read
 *   only; this is the first with internal recipients whose channel toggle is meaningful, so it
 *   reads it in the same in-transaction, re-resolved, default-reachable style. Recorded as a
 *   divergence in the status doc.
 * - **Quiet hours (acceptance §3).** Each recipient's own window is read; an in-window recipient
 *   is **deferred per recipient** — a {@link enqueueQuietHoursMailResume} row carrying just that
 *   `recipientUserId`, resuming at that recipient's window end. Deferring the whole event would
 *   re-fan-out on resume and re-mail the recipients who were not in quiet hours.
 * - **Failure isolation (acceptance §4).** One `afterCommit` effect is staged **per recipient**,
 *   so the dispatcher's per-effect `try/catch` isolates a failed send, and `mailer.deliver` also
 *   never throws — a mail failure for one recipient rolls back neither the committed inbox notice
 *   nor the other recipients' mails. This matches the dispatcher's after-commit contract and the
 *   existing mailers' absorb-and-report `deliver`.
 *
 * ## The band-100 bypass (acceptance §3)
 *
 * Bands 70/85/95 are advisory and defer; band 100 is critical (uploads are already blocked) and
 * bypasses quiet hours. A single event *type* cannot say that, so the rule is a payload predicate
 * on the domain's `eventBypassesQuietHours` — the smallest generic extension over a special case
 * here (see `packages/domain/src/notifications/quiet-hours.ts`).
 */

interface UsagePayload {
  readonly band: number;
  readonly used: number;
  readonly reserved: number;
  readonly quota: number;
  /** Carried so a per-recipient resume row wraps the same crossing the original event did. */
  readonly raw: Record<string, unknown>;
}

function numberField(payload: Record<string, unknown>, key: string, eventId: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`event ${eventId} has no readable ${key}`);
  }
  return value;
}

function readUsagePayload(event: ClaimedOutboxEvent): UsagePayload {
  if (event.payload === null || typeof event.payload !== 'object') {
    throw new Error(`event ${event.id} has no readable payload`);
  }
  const raw = event.payload as Record<string, unknown>;
  return {
    band: numberField(raw, 'band', event.id),
    used: numberField(raw, 'used', event.id),
    reserved: numberField(raw, 'reserved', event.id),
    quota: numberField(raw, 'quota', event.id),
    raw,
  };
}

/**
 * Stage one recipient's send, honouring the mail-channel toggle. Returns without staging when the
 * user row is gone or that recipient turned mail off — the in-app notice already reached them.
 */
function stageUsageMail(input: {
  readonly effects: OutboxEffects;
  readonly mailer: UsageThresholdMailer;
  readonly recipient: UsageMailRecipient;
  readonly payload: UsagePayload;
}): void {
  const { recipient, payload } = input;
  input.effects.afterCommit(async () => {
    await input.mailer.deliver({
      recipientEmail: recipient.email,
      recipientName: recipient.displayName,
      band: payload.band,
      used: payload.used,
      reserved: payload.reserved,
      quota: payload.quota,
    });
  });
}

/**
 * The original-delivery handler: fan out to org-wide owners/admins, and for each either stage the
 * mail now or defer it past that recipient's quiet window (unless band 100 bypasses).
 */
export function createUsageThresholdMail(mailer: UsageThresholdMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return; // No transport: do not pay for the fan-out.

    const payload = readUsagePayload(event);
    const candidates = await listActiveOrgWideMemberships(tx, event.organizationId);
    const bypass = eventBypassesQuietHours(event.type, payload.raw);
    const now = new Date();

    for (const candidate of candidates.filter(isUsageThresholdRecipient)) {
      const recipient = await findUsageMailRecipient(tx, event.organizationId, candidate.userId);
      if (recipient === null) continue; // §6: the user is gone; nothing to say.
      if (!recipient.emailEnabled) continue; // §2: this recipient turned the mail channel off.

      if (!bypass && isInQuietHours(now, recipient.quietHours)) {
        const resumeAt = quietHoursResumeAt(now, recipient.quietHours);
        if (resumeAt !== null) {
          // §3: defer this recipient alone to the end of their window; others are unaffected.
          await enqueueQuietHoursMailResume(tx, event, resumeAt, candidate.userId);
          continue;
        }
      }

      stageUsageMail({ effects, mailer, recipient, payload });
    }
  };
}

/**
 * The resume handler for a per-recipient usage deferral — INBOX-001's second half. Registered on
 * {@link QUIET_HOURS_MAIL_RESUME_TYPE} beside the client-request resume; it acts only on a resume
 * row whose original type is the usage crossing and which names a recipient, and no-ops otherwise
 * so the two resume handlers can be composed on the one type. The window was already waited out,
 * so quiet hours are not re-checked — but the recipient's active owner/admin membership and the
 * mail-channel toggle are re-read, so a person removed or demoted during the deferral (F58), or
 * who turned mail off, is not mailed, and a user gone by now is silence.
 */
export function createUsageThresholdMailResume(mailer: UsageThresholdMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;

    const envelope = decodeQuietHoursMailResume(event);
    if (envelope === null) return;
    if (envelope.originalType !== 'usage.threshold_reached.v1') return; // Not ours to resume.
    const recipientUserId = envelope.recipientUserId;
    if (recipientUserId === undefined) return; // A usage resume always names its one recipient.

    // F58: the recipient was an org-wide owner/admin when deferred; re-check it now, so a person
    // removed, suspended or demoted during their quiet hours does not get the org's storage figures.
    const membership = await findActiveOrgWideMembership(tx, event.organizationId, recipientUserId);
    if (membership === null || !isUsageThresholdRecipient(membership)) return;

    const payload = readUsagePayload({ ...event, payload: envelope.originalPayload });
    const recipient = await findUsageMailRecipient(tx, event.organizationId, recipientUserId);
    if (recipient === null) return; // The user is gone.
    if (!recipient.emailEnabled) return; // Turned the mail channel off during the deferral.

    stageUsageMail({ effects, mailer, recipient, payload });
  };
}
