import {
  findPrivacyMailOrganization,
  findPrivacyMailRecipients,
  listActiveOwnerIds,
} from '../common/database/privacy-mail-store.js';
import type { PrivacyMailRecipient } from '../common/database/privacy-mail-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects, OutboxHandler } from '../outbox/dispatcher.js';
import type {
  PrivacyEmailFacts,
  PrivacyMailKind,
  PrivacyMailer,
} from '../notifications/privacy-mailer.js';

/**
 * H3 — the email consumers of the two data-rights events (`privacy-job.ts`, `privacy.service.ts`).
 *
 * Same contract as the other relay mail consumers: the facts are re-read inside the batch
 * transaction from the event's own organization, and each send is one `afterCommit` effect, so a
 * failed send for one person neither rolls back the event nor stops the others.
 *
 * Unlike the collaboration mails these are **not** subject to the mail-channel toggle or quiet
 * hours: they answer a data-rights request (33-LEGAL §8 "… → respond"), the kind of receipt a person
 * cannot opt out of, like the credential-change receipt.
 *
 * Who is told:
 * - `privacy_export.ready.v1` — the person who asked for the export.
 * - `privacy_deletion.changed.v1`, company — every active owner, and whoever acted.
 * - `privacy_deletion.changed.v1`, account — the person whose account it is, and whoever acted.
 */

type Payload = Record<string, unknown>;

function payloadOf(event: ClaimedOutboxEvent): Payload {
  if (event.payload === null || typeof event.payload !== 'object') {
    throw new Error(`event ${event.id} has no readable payload`);
  }
  return event.payload as Payload;
}

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function stage(
  effects: OutboxEffects,
  mailer: PrivacyMailer,
  kind: PrivacyMailKind,
  recipient: PrivacyMailRecipient,
  facts: Omit<PrivacyEmailFacts, 'recipientEmail' | 'recipientName' | 'locale'>,
): void {
  effects.afterCommit(async () => {
    await mailer.deliver(kind, {
      ...facts,
      recipientEmail: recipient.email,
      recipientName: recipient.displayName,
      locale: recipient.locale,
    });
  });
}

/** `privacy_export.ready.v1` → the requester. */
export function createPrivacyExportReadyMail(mailer: PrivacyMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;
    const payload = payloadOf(event);
    const requester = text(payload, 'requestedByUserId');
    if (requester === null) throw new Error(`event ${event.id} names no requester`);
    const kind = text(payload, 'kind') === 'company' ? 'company' : 'member';
    const subject = text(payload, 'subjectUserId');

    const org = await findPrivacyMailOrganization(tx, event.organizationId);
    if (org === null) return;
    const [recipient] = await findPrivacyMailRecipients(tx, event.organizationId, [requester]);
    if (recipient === undefined) return; // The person is gone; nothing to say.

    // A member's own export is downloaded from "My data"; a company export, or one an owner made
    // about a member, from the admin Privacy page.
    const own = kind === 'member' && subject === requester;
    const path = own ? `/${org.slug}/settings/my-data` : `/${org.slug}/admin/privacy`;
    stage(effects, mailer, 'export_ready', recipient, {
      organizationName: org.name,
      scope: kind,
      link: mailer.linkTo(path),
    });
  };
}

const DELETION_KINDS: Readonly<Record<string, PrivacyMailKind>> = {
  scheduled: 'deletion_scheduled',
  cancelled: 'deletion_cancelled',
  executed: 'deletion_executed',
};

/** `privacy_deletion.changed.v1` → owners (company) or the person (account), and the actor. */
export function createPrivacyDeletionChangedMail(mailer: PrivacyMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;
    const payload = payloadOf(event);
    const mailKind = DELETION_KINDS[text(payload, 'status') ?? ''];
    if (mailKind === undefined) return; // A status this consumer does not tell anyone about.
    const company = text(payload, 'kind') === 'company';
    const actor = text(payload, 'actorUserId');
    const subject = text(payload, 'subjectUserId');
    const scheduledText = text(payload, 'scheduledFor');
    const scheduledFor = scheduledText === null ? undefined : new Date(scheduledText);
    if (scheduledFor !== undefined && Number.isNaN(scheduledFor.getTime())) {
      throw new Error(`event ${event.id} has no readable scheduledFor`);
    }

    const org = await findPrivacyMailOrganization(tx, event.organizationId);
    if (org === null) return;

    const ids: string[] = [];
    if (company) ids.push(...(await listActiveOwnerIds(tx, event.organizationId)));
    else if (subject !== null) ids.push(subject);
    if (actor !== null) ids.push(actor);
    const recipients = await findPrivacyMailRecipients(tx, event.organizationId, ids);

    // Once carried out there is nothing left to open; before that, the page the request is on.
    const path = company ? `/${org.slug}/admin/privacy` : `/${org.slug}/settings/my-data`;
    const link = mailKind === 'deletion_executed' ? undefined : mailer.linkTo(path);
    for (const recipient of recipients) {
      stage(effects, mailer, mailKind, recipient, {
        organizationName: org.name,
        scope: company ? 'company' : 'account',
        ...(scheduledFor === undefined ? {} : { scheduledFor }),
        ...(link === undefined ? {} : { link }),
      });
    }
  };
}
