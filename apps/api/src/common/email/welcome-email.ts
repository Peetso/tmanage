import type { Mailer, MailMessage } from '@tmanage/mail';
import { serializeForLog } from '../observability/logger.js';
import { renderActionEmail } from './action-email.js';
import { emailIsRtl, emailT } from '../i18n/email-messages.js';

/**
 * The welcome email a public sign-up sends (in the shared action-email layout).
 *
 * It carries no credential: the link is the neutral sign-in page (`/sign-in`), never the new
 * workspace's address — the slug is derived from what the anonymous sign-up typed (audit run 2,
 * F36a leftover), so it would put attacker-chosen words into a genuine TManage link. Verification of the address is not required to use the account yet
 * (Peter, 2026-10-18: "open the sign up for public for now"), so the message says welcome and
 * nothing more — it is also the first signal to a mailbox owner that somebody used their address.
 *
 * It quotes nothing the person typed (audit run 1, F36a): the sign-up is anonymous and the
 * address is not proved, so a display name or workspace name would let anyone put their own
 * sentences, phone numbers or web addresses into a genuine TManage message to any mailbox. The
 * greeting is generic and the only variable part is the configuration-built link.
 */

export interface WelcomeEmailFacts {
  readonly to: string;
  /** Built by {@link WelcomeMailer} from configuration, never from a request header. */
  readonly link: string;
  readonly locale?: string;
}

export function composeWelcomeEmail(facts: WelcomeEmailFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const copy = {
    subject: emailT(locale, 'welcome.subject'),
    eyebrow: emailT(locale, 'welcome.eyebrow'),
    heading: emailT(locale, 'welcome.heading'),
    intro: emailT(locale, 'welcome.intro'),
    button: emailT(locale, 'welcome.button'),
    fallback: emailT(locale, 'common.fallback'),
    note: emailT(locale, 'welcome.note'),
    footer: emailT(locale, 'welcome.footer'),
  };

  return {
    to: facts.to,
    subject: copy.subject,
    text: [copy.heading, copy.intro, `${copy.button}: ${facts.link}`, copy.note, copy.footer].join(
      '\n\n',
    ),
    html: renderActionEmail({ arabic, link: facts.link, rows: [], ...copy }),
  };
}

/** Sends the welcome email; a mail failure is logged and never fails the sign-up. */
export class WelcomeMailer {
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(
    facts: Omit<WelcomeEmailFacts, 'link'> & {
      /** Accepted from the sign-up and deliberately unused: the link no longer names it (F36a). */
      readonly organizationSlug?: string;
    },
  ): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    // Only the fields the template uses: anything else a caller passes never reaches the mail.
    const link = `${this.webPublicUrl.replace(/\/+$/u, '')}/sign-in`;
    try {
      return await this.mailer.send(
        composeWelcomeEmail({
          to: facts.to,
          link,
          ...(facts.locale === undefined ? {} : { locale: facts.locale }),
        }),
      );
    } catch (error) {
      console.error('[mailer] welcome email failed', serializeForLog(error));
      return 'failed';
    }
  }
}
