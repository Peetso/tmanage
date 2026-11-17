import { emailAddressHash, listUnsubscribeHeaders } from './list-unsubscribe.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';
import { fillLinkTokens } from './sign-off.js';

/**
 * 51-11 — the transport the notification mailers send through (mentions, comments, request
 * updates, usage thresholds, digests). Transactional and security mail (invitations, password
 * resets, credential and privacy notices) does NOT go through here: a person cannot opt out of
 * being told their password changed, and those messages carry no unsubscribe header.
 *
 * Per message it (1) asks the suppression list whether the recipient unsubscribed — a suppressed
 * recipient is answered `'none'`, nothing is submitted — and (2) stamps the RFC 8058 headers
 * pointing at the API's signed one-click route. A suppression lookup that fails sends anyway
 * (fail-open): the notification was wanted until proven otherwise, and the header still lets the
 * person stop the next one.
 */

/** Whether a recipient's address hash is on the suppression list. */
export interface SuppressionLookup {
  isSuppressed(addressHash: string): Promise<boolean>;
}

export interface NotificationTransportOptions {
  /** Absolute URL of `POST /v1/public/email/unsubscribe` (the token is appended as `?t=`). */
  readonly unsubscribeUrl: string;
  readonly key: Buffer;
  readonly suppressions?: SuppressionLookup | undefined;
  /** A monitored support mailbox, used as `Reply-To` when the producer set none. */
  readonly replyTo?: string | undefined;
}

export class NotificationMailTransport implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly options: NotificationTransportOptions,
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    const lookup = this.options.suppressions;
    if (lookup !== undefined) {
      let suppressed = false;
      try {
        suppressed = await lookup.isSuppressed(emailAddressHash(message.to));
      } catch (error) {
        console.error('[mailer] suppression lookup failed; sending', error);
      }
      if (suppressed) return 'none';
    }
    const headers = listUnsubscribeHeaders(
      this.options.unsubscribeUrl,
      this.options.key,
      message.to,
    );
    for (const value of Object.values(headers)) {
      if (/[\r\n]/u.test(value)) throw new Error('refused a header value holding a line break');
    }
    const replyTo = message.replyTo ?? this.options.replyTo;
    // EMAILBUILD (c): the sign-off's links line. The settings link is the unsubscribe route
    // without a token: opened in a browser it answers 303 to the web app (it never acts on GET).
    const unsubscribe = /^<(.*)>$/u.exec(headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    const settingsUrl = new URL(this.options.unsubscribeUrl);
    settingsUrl.search = '';
    const links = { settings: settingsUrl.toString(), unsubscribe };
    return this.inner.send({
      ...message,
      text: fillLinkTokens(message.text, links, false),
      ...(message.html === undefined ? {} : { html: fillLinkTokens(message.html, links, true) }),
      ...(replyTo === undefined ? {} : { replyTo }),
      headers: { ...message.headers, ...headers },
    });
  }
}
