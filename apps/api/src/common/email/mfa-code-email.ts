import { greeting, renderMailLayout, signOff } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { serializeForLog } from '../observability/logger.js';
import { emailIsRtl, emailT } from '../i18n/email-messages.js';
import { arabicMinutes } from './arabic-minutes.js';

/**
 * MFAOPTIONS. The e-mail that carries a two-step verification code, and its sender.
 *
 * It says what the code is for (finishing a sign-in, or turning the e-mail method on), how long
 * it works, and what to do if the person did not ask for it. It carries **no link**: a link that
 * signs in would make the mailbox a password, which is the opposite of a second step. The code is
 * in the body only; it never reaches a log line — a failed send logs the transport error alone.
 */

export type MfaCodeEmailPurpose = 'sign_in' | 'enrol';

export interface MfaCodeEmailFacts {
  readonly to: string;
  readonly displayName: string;
  /** Six digits. */
  readonly code: string;
  readonly purpose: MfaCodeEmailPurpose;
  /** How long the code works, in minutes. */
  readonly ttlMinutes: number;
  /** The account's `locale` (`emailT` picks the catalog; English when it has none). */
  readonly locale?: string;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function composeMfaCodeEmail(facts: MfaCodeEmailFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const name = oneLine(facts.displayName);
  const minutes = String(facts.ttlMinutes);
  const duration = arabicMinutes(facts.ttlMinutes);
  const language = arabic ? 'ar' : 'en';
  const signature = signOff('security', language);
  const copy = {
    subject: emailT(locale, 'mfaCode.subject'),
    preheader: emailT(locale, 'mfaCode.preheader', { minutes, duration }),
    eyebrow: emailT(locale, 'mfaCode.eyebrow'),
    heading: greeting(language, name),
    intro: emailT(
      locale,
      facts.purpose === 'sign_in' ? 'mfaCode.introSignIn' : 'mfaCode.introEnrol',
    ),
    note: emailT(locale, 'mfaCode.note', { minutes, duration }),
    footer: emailT(locale, 'mfaCode.footer'),
  };

  return {
    to: facts.to,
    language,
    subject: copy.subject,
    text: [
      copy.heading,
      emailT(locale, 'mfaCode.codeLine', { code: facts.code }),
      copy.intro,
      copy.note,
      copy.footer,
      signature.join('\n'),
    ].join('\n\n'),
    html: renderCodeEmail({ arabic, code: facts.code, signature, ...copy }),
  };
}

/** The shared mail layout with the button and link replaced by the code itself. */
function renderCodeEmail(content: {
  readonly arabic: boolean;
  readonly code: string;
  readonly subject: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly intro: string;
  readonly note: string;
  readonly footer: string;
  readonly preheader: string;
  readonly signature: readonly string[];
}): string {
  return renderMailLayout({
    arabic: content.arabic,
    subject: content.subject,
    preheader: content.preheader,
    eyebrow: content.eyebrow,
    heading: content.heading,
    blocks: [
      { kind: 'text', text: content.intro },
      { kind: 'code', code: content.code },
    ],
    note: content.note,
    signature: content.signature,
    footer: content.footer,
  });
}

/**
 * Sends the code. Absorbs a transport failure into `'failed'` and logs it without the message,
 * so the code never reaches the operator's log.
 */
export class MfaCodeMailer {
  constructor(private readonly mailer: Mailer | null) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: MfaCodeEmailFacts): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(composeMfaCodeEmail(facts));
    } catch (error) {
      console.error('[mailer] two-step code email failed', serializeForLog(error));
      return 'failed';
    }
  }
}
