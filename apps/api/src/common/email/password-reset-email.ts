import { greeting, signOff } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { serializeForLog } from '../observability/logger.js';
import { renderActionEmail } from './action-email.js';
import { emailIsRtl, emailT, mailLink } from '../i18n/email-messages.js';

/**
 * The password-reset email (ACC-02) and its sender.
 *
 * The copy is ID-05's approved sentence: the link works once and expires in 30 minutes. The
 * message never says whether other accounts exist and carries nothing but the link — the
 * request screen answers the same whether or not the address is known, so this email is the
 * only place the fact "this address has an account" is ever disclosed, and it is disclosed to
 * the mailbox itself.
 */

export interface PasswordResetEmailFacts {
  readonly to: string;
  readonly displayName: string;
  /** The reset URL, token included — built by {@link PasswordResetMailer} from configuration. */
  readonly link: string;
  /** How long the link works, in minutes. */
  readonly ttlMinutes: number;
  /** The account's `locale` (`emailT` picks the catalog; English when it has none). */
  readonly locale?: string;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function composePasswordResetEmail(facts: PasswordResetEmailFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const language = arabic ? 'ar' : 'en';
  const name = oneLine(facts.displayName);
  const minutes = String(facts.ttlMinutes);
  const signature = signOff('security', language);
  const copy = {
    subject: emailT(locale, 'passwordReset.subject'),
    preheader: emailT(locale, 'passwordReset.preheader', { minutes }),
    eyebrow: emailT(locale, 'passwordReset.eyebrow'),
    heading: greeting(language, name),
    intro: emailT(locale, 'passwordReset.intro'),
    button: emailT(locale, 'passwordReset.button'),
    fallback: emailT(locale, 'common.fallback'),
    note: emailT(locale, 'passwordReset.note', { minutes }),
    footer: emailT(locale, 'passwordReset.footer'),
  };

  return {
    to: facts.to,
    language,
    subject: copy.subject,
    text: [
      copy.heading,
      copy.intro,
      `${copy.button}: ${facts.link}`,
      copy.note,
      copy.footer,
      signature.join('\n'),
    ].join('\n\n'),
    html: renderActionEmail({ arabic, link: facts.link, rows: [], signature, ...copy }),
  };
}

/**
 * VERIFYMAIL. The "Confirm your e-mail" message: the same kind of link as the reset (it works
 * once and expires in the same time), to the confirmation page instead of the recover page.
 * Clicking it only confirms the address; it never changes the password or signs anyone in.
 */
export function composeEmailConfirmationEmail(facts: PasswordResetEmailFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const language = arabic ? 'ar' : 'en';
  const name = oneLine(facts.displayName);
  const minutes = String(facts.ttlMinutes);
  const signature = signOff('security', language);
  const copy = {
    subject: emailT(locale, 'emailConfirm.subject'),
    preheader: emailT(locale, 'emailConfirm.preheader'),
    eyebrow: emailT(locale, 'emailConfirm.eyebrow'),
    heading: greeting(language, name),
    intro: emailT(locale, 'emailConfirm.intro'),
    button: emailT(locale, 'emailConfirm.button'),
    fallback: emailT(locale, 'common.fallback'),
    note: emailT(locale, 'emailConfirm.note', { minutes }),
    footer: emailT(locale, 'emailConfirm.footer'),
  };
  return {
    to: facts.to,
    language,
    subject: copy.subject,
    text: [
      copy.heading,
      copy.intro,
      `${copy.button}: ${facts.link}`,
      copy.note,
      copy.footer,
      signature.join('\n'),
    ].join('\n\n'),
    html: renderActionEmail({ arabic, link: facts.link, rows: [], signature, ...copy }),
  };
}

/**
 * Sends the reset email. Owns the link — `${WEB_PUBLIC_URL}/recover/${token}?lang=…` (`mailLink`), built from
 * configuration and never from a request header, because a `Host` header is attacker-writable
 * and this link carries a credential — and absorbs a mail failure loudly (the operator's log,
 * through the OBS-001 redactor) rather than letting it reach the person, whose answer must not
 * depend on whether their address is known.
 */
export class PasswordResetMailer {
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(
    facts: Omit<PasswordResetEmailFacts, 'link'> & { readonly token: string },
  ): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    const { token, ...rest } = facts;
    const link = mailLink(this.webPublicUrl, `/recover/${token}`, rest.locale);
    try {
      return await this.mailer.send(composePasswordResetEmail({ ...rest, link }));
    } catch (error) {
      console.error('[mailer] password reset email failed', serializeForLog(error));
      return 'failed';
    }
  }

  /**
   * VERIFYMAIL. `${WEB_PUBLIC_URL}/confirm-email/${token}?lang=<catalog>`, built from
   * configuration only; `?lang=` is the allow-listed alias of the mail's own language (SMALLFIX 3).
   */
  async deliverConfirmation(
    facts: Omit<PasswordResetEmailFacts, 'link'> & { readonly token: string },
  ): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    const { token, ...rest } = facts;
    const link = mailLink(this.webPublicUrl, `/confirm-email/${token}`, rest.locale);
    try {
      return await this.mailer.send(composeEmailConfirmationEmail({ ...rest, link }));
    } catch (error) {
      console.error('[mailer] e-mail confirmation failed', serializeForLog(error));
      return 'failed';
    }
  }
}
