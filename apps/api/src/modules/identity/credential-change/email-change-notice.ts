import type { Mailer, MailMessage } from '@tmanage/mail';
import { renderActionEmail } from '../../../common/email/action-email.js';
import { serializeForLog } from '../../../common/observability/logger.js';
import { emailIsRtl, emailT, mailLink } from '../../../common/i18n/email-messages.js';

/**
 * Platform admin v2 (PA-06, SPEC §4 B2) — "your sign-in email changed", to the OLD and the NEW
 * address.
 *
 * The queue that tells an account holder their credentials changed (`credential_change_notices`,
 * 0020) carries a user id and reads the address at delivery, so a notice written for an email
 * change reaches only the new address. The old address is the one that must hear about it — it is
 * how the real owner learns that someone moved their account — so this sender mails both, at the
 * moment of the change, beside the queue row (`email_changed`) that keeps the record.
 *
 * The mail carries no link that signs anyone in, no IP and no device: only what changed, when, and
 * what to do if it was not expected. A send failure is logged (through the OBS-001 redactor) and
 * never undoes the change.
 */

/** `authentication_events.action` / `credential_change_notices.action` for an email change. */
export const EMAIL_CHANGED_ACTION = 'email_changed';

export interface EmailChangeNoticeFacts {
  readonly to: string;
  readonly displayName: string;
  readonly oldEmail: string;
  readonly newEmail: string;
  /** `old` — the address that no longer signs in; `new` — the address that must be verified. */
  readonly recipient: 'old' | 'new';
  readonly locale?: string;
  readonly link: string;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function composeEmailChangeNotice(facts: EmailChangeNoticeFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const name = oneLine(facts.displayName);
  const copy = {
    subject: emailT(locale, 'emailChange.subject'),
    eyebrow: emailT(locale, 'emailChange.eyebrow'),
    heading: emailT(locale, 'emailChange.heading', { name }),
    intro: emailT(
      locale,
      facts.recipient === 'old' ? 'emailChange.introOld' : 'emailChange.introNew',
    ),
    button: emailT(locale, 'emailChange.button'),
    fallback: emailT(locale, 'common.fallback'),
    note: emailT(locale, 'emailChange.note'),
    footer: emailT(locale, 'emailChange.footer'),
    rows: [
      { label: emailT(locale, 'emailChange.previousEmail'), value: facts.oldEmail },
      { label: emailT(locale, 'emailChange.newEmail'), value: facts.newEmail },
    ],
  };
  const { rows, ...content } = copy;
  return {
    to: facts.to,
    subject: copy.subject,
    text: [
      copy.heading,
      copy.intro,
      ...rows.map((row) => `${row.label}: ${row.value}`),
      copy.note,
      copy.footer,
    ].join('\n\n'),
    html: renderActionEmail({ arabic, link: facts.link, rows, ...content }),
  };
}

/** Sends the two notices. `null` mailer (no transport) sends nothing. */
export class EmailChangeNotifier {
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  async notify(input: {
    readonly displayName: string;
    readonly oldEmail: string;
    readonly newEmail: string;
    readonly locale?: string;
  }): Promise<{ readonly sent: number }> {
    if (this.mailer === null) return { sent: 0 };
    const link = mailLink(this.webPublicUrl, '/sign-in', input.locale);
    let sent = 0;
    for (const recipient of ['old', 'new'] as const) {
      try {
        await this.mailer.send(
          composeEmailChangeNotice({
            ...input,
            to: recipient === 'old' ? input.oldEmail : input.newEmail,
            recipient,
            link,
          }),
        );
        sent += 1;
      } catch (error) {
        console.error('[mailer] email change notice failed', serializeForLog(error));
      }
    }
    return { sent };
  }
}
