import type { Mailer, MailMessage } from '@tmanage/mail';
import { renderActionEmail } from '../../../common/email/action-email.js';
import { serializeForLog } from '../../../common/observability/logger.js';

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
  const arabic = (facts.locale ?? 'en').toLowerCase().startsWith('ar');
  const name = oneLine(facts.displayName);
  const copy = arabic
    ? {
        subject: 'تغيّر بريد تسجيل الدخول إلى TManage',
        eyebrow: 'أمان الحساب',
        heading: `مرحبًا ${name}، تغيّر بريد حسابك`,
        intro:
          facts.recipient === 'old'
            ? 'غيّر دعم TManage بريد تسجيل الدخول لحسابك. لم يعد هذا العنوان يسجّل الدخول.'
            : 'أصبح هذا العنوان بريد تسجيل الدخول لحسابك في TManage. أكِّده قبل تسجيل الدخول مرة أخرى.',
        button: 'فتح TManage',
        fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:',
        note: 'انتهت كل جلساتك. إن لم تتوقع هذا التغيير فتواصل مع مالك مؤسستك أو مع دعم TManage.',
        footer: 'لا تحتوي هذه الرسالة على رابط لتسجيل الدخول.',
        rows: [
          { label: 'البريد السابق', value: facts.oldEmail },
          { label: 'البريد الجديد', value: facts.newEmail },
        ],
      }
    : {
        subject: 'Your TManage sign-in email changed',
        eyebrow: 'Account security',
        heading: `Hi ${name}, your account email changed`,
        intro:
          facts.recipient === 'old'
            ? 'TManage support changed the sign-in email of your account. This address no longer signs in.'
            : 'This address is now the sign-in email of your TManage account. Verify it before you sign in again.',
        button: 'Open TManage',
        fallback: 'Button not working? Copy this link into your browser:',
        note: 'All your sessions have ended. If you did not expect this change, contact your organization owner or TManage support.',
        footer: 'This email carries no sign-in link.',
        rows: [
          { label: 'Previous email', value: facts.oldEmail },
          { label: 'New email', value: facts.newEmail },
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
    const link = `${this.webPublicUrl.replace(/\/+$/u, '')}/sign-in`;
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
