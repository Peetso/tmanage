import { greeting, signOff } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { CredentialNoticeRecipient } from '../common/database/notice-store.js';
import { renderSecurityNoticeHtml } from './security-notice-html.js';

/**
 * `D05d`'s security-event receipt, as an email — the relay's third producer on the
 * `@tmanage/mail` port and the first that is not about a client request.
 *
 * ## What it says, and the four things it deliberately does not
 *
 * `35-NOTIFICATION-AND-EMAIL-COPY` §1 puts "MFA/credential changes" in the critical-security
 * class but writes no template for one, so the sentence is written here and kept to what the
 * notice row actually holds: **who**, **what changed**, and **when**. Absent, each for a
 * reason migration 0020 already gives:
 *
 * - **No link.** Every other template in this directory carries one into a tenant's portal.
 *   A credential change happens on the identity path, before any organization is resolved —
 *   there is no `orgSlug` to build a route with, and a link invented for this mail would be
 *   the one phishing shape a security notice must never have.
 * - **No address and no device.** `authentication_events` holds both; the notice table
 *   refuses them on purpose, because an intruder reading the owner's mailbox would otherwise
 *   be handed the addresses the owner signs in from.
 * - **No secret.** Not a password, not a seed, not a recovery code. The relay's credential
 *   cannot reach the tables that hold them at all (`scripts/db/users.sql`, D07).
 * - **No unsubscribe.** §7 exempts transactional mail, and a security receipt the owner
 *   could switch off is a control an attacker switches off first.
 *
 * ## The route back in has to be one that works while locked out
 *
 * The closing sentence used to read "sign in, change your password, and contact your studio
 * administrator". It was unusable in the case the mail exists for: the likeliest reason a
 * `password_set` receipt is unexpected is that somebody else has just set the password, in
 * which case the recipient *cannot* sign in — and the recipient of a credential receipt is
 * often the studio owner, for whom "your studio administrator" is nobody.
 *
 * So it names the one route back in this product actually has today, in the same words the
 * application itself uses: `RecoveryScreen` (`ID-05`) tells a locked-out person to ask
 * whoever administers their workspace to reset the password for them, because self-service
 * recovery is `ID-002` and has not been built — `/recover` renders a form that does not
 * submit and sends no email. Naming that page here would send a locked-out person to a dead
 * end, and recovery codes are not the answer either: they are consumed at the *second* factor,
 * after the password has already been accepted, so they open nothing once it has changed. No
 * support address and no turnaround are given for `RecoveryScreen`'s reason — this
 * application has neither, and inventing one would be the same defect in a friendlier voice.
 *
 * ## An unknown action is not mailed
 *
 * {@link composeCredentialChangeEmail} returns `null` for an `action` outside the four
 * `CREDENTIAL_CHANGE_ACTIONS` the API writes. A fifth action added upstream would otherwise
 * be rendered by interpolating a raw column value into a sentence about somebody's account —
 * so the notice is drained and stamped, and nothing is sent, which is the same answer the
 * dispatcher gives an event type with no consumer.
 */

/** EMAIL-COPY S5: subject and fact line per action, English and Arabic. */
const COPY_BY_ACTION: Readonly<
  Record<string, { readonly en: readonly [string, string]; readonly ar: readonly [string, string] }>
> = {
  password_set: {
    en: ['Your TManage password was changed', 'The password of your TManage account was changed.'],
    ar: ['تغيّرت كلمة مرورك في TManage', 'تغيّرت كلمة مرور حسابك في TManage.'],
  },
  mfa_factor_enrolled: {
    en: [
      'Two-step verification was added to your account',
      'A two-step verification method was added to your account.',
    ],
    ar: ['أُضيف التحقق بخطوتين إلى حسابك', 'أُضيفت وسيلة تحقق بخطوتين إلى حسابك.'],
  },
  mfa_factor_disabled: {
    en: [
      'Two-step verification was removed from your account',
      'A two-step verification method was removed from your account.',
    ],
    ar: ['أُزيل التحقق بخطوتين من حسابك', 'أُزيلت وسيلة تحقق بخطوتين من حسابك.'],
  },
  recovery_codes_issued: {
    en: [
      'New recovery codes were issued',
      'A new set of recovery codes was issued. The old codes no longer work.',
    ],
    ar: [
      'صدرت رموز استرداد جديدة',
      'صدرت مجموعة جديدة من رموز الاسترداد، والرموز القديمة لم تعد تعمل.',
    ],
  },
  mfa_default_changed: {
    en: [
      'Your first verification method changed',
      'The verification method asked for first at sign-in was changed.',
    ],
    ar: ['تغيّرت وسيلة التحقق الأولى', 'تغيّرت وسيلة التحقق التي تُطلب أولًا عند تسجيل الدخول.'],
  },
  passkey_added: {
    en: ['A passkey was added to your account', 'A passkey was added to your account.'],
    ar: ['أُضيف مفتاح مرور إلى حسابك', 'أُضيف مفتاح مرور إلى حسابك.'],
  },
  passkey_removed: {
    en: ['A passkey was removed from your account', 'A passkey was removed from your account.'],
    ar: ['أُزيل مفتاح مرور من حسابك', 'أُزيل مفتاح مرور من حسابك.'],
  },
  new_device_sign_in: {
    en: [
      'New device signed in to your account',
      'Your account was signed in to from a device it has not used before.',
    ],
    ar: ['تسجيل دخول من جهاز جديد', 'سُجّل الدخول إلى حسابك من جهاز لم يُستخدم من قبل.'],
  },
};

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = String.fromCodePoint(0x20_0f);

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** `2026-09-19 14:05 UTC` — the instant, in the one zone the notice is stored in. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface CredentialChangeEmailFacts {
  readonly recipient: CredentialNoticeRecipient;
  readonly action: string;
  readonly occurredAt: Date;
  /** EMAILBUILD (c): the account's locale when known; English otherwise. */
  readonly locale?: string;
}

/** The message, or `null` when the action is outside the closed vocabulary — see the header. */
export function composeCredentialChangeEmail(
  facts: CredentialChangeEmailFacts,
): MailMessage | null {
  if (!Object.hasOwn(COPY_BY_ACTION, facts.action)) return null;
  const copy = COPY_BY_ACTION[facts.action];
  if (copy === undefined) return null;
  const arabic = facts.locale !== undefined && /^ar(?:-|$)/iu.test(facts.locale);
  const language = arabic ? 'ar' : 'en';
  const [subject, changed] = copy[language];
  const when = utcMinute(facts.occurredAt);
  const hello = greeting(language, oneLine(facts.recipient.displayName));
  const signature = signOff('security', language);
  const advice = arabic
    ? 'إن كنت أنت من فعل ذلك فلا شيء مطلوب منك. وإن لم تكن أنت، غيّر كلمة مرورك الآن وراسلنا على support@tmanageapp.com.'
    : 'If this was you, there is nothing to do. If it was not, change your password now and write to support@tmanageapp.com.';
  const whenLine = arabic ? `الوقت: ${when}.` : `When: ${when}.`;
  const mark = arabic ? RLM : '';
  return {
    to: facts.recipient.email,
    language,
    subject: `${mark}${subject}`,
    text: [hello, `${mark}${changed}`, whenLine, `${mark}${advice}`, signature.join('\n')].join(
      '\n\n',
    ),
    html: renderSecurityNoticeHtml({
      arabic,
      eyebrow: arabic ? 'إشعار أمان' : 'Security notice',
      subject: `${mark}${subject}`,
      intro: `${hello} ${mark}${changed}`,
      rows: [
        { label: arabic ? 'ما الذي تغيّر' : 'What changed', value: changed },
        { label: arabic ? 'الوقت' : 'When', value: when },
      ],
      note: advice,
      footer: '',
      signature,
    }),
  };
}

/** What became of one notice. `'none'` means no transport was configured to try. */
export type CredentialChangeMailDelivery = 'sent' | 'none' | 'skipped' | 'failed';

/**
 * `ClientRequestMailer`'s shape, for the notice queue. Like it, {@link deliver} never throws:
 * it runs on the far side of the batch's commit, where a throw could not un-publish the row
 * it belongs to, so absorbing the error into the operator's log is the only honest shape.
 */
export class CredentialChangeMailer {
  /** @param mailer `null` when no transport is wired — every database suite's default. */
  constructor(private readonly mailer: Mailer | null) {}

  /** Whether a transport exists to try; the consumer reads this before paying for the join. */
  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: CredentialChangeEmailFacts): Promise<CredentialChangeMailDelivery> {
    if (this.mailer === null) return 'none';
    const message = composeCredentialChangeEmail(facts);
    if (message === null) return 'skipped';
    try {
      return await this.mailer.send(message);
    } catch (error) {
      // Absorbed loudly, and without the address: the driver's words may name the recipient,
      // so they go to the operator's log and nowhere else — never into the batch report.
      console.error('[worker] credential change email failed', error);
      return 'failed';
    }
  }
}
