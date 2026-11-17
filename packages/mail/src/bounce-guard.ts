import { laneForTemplate } from './lanes.js';
import { emailAddressHash } from './list-unsubscribe.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';

/**
 * 56-26 — stop sending company mail to an address that bounced.
 *
 * Wraps the transport a company's producers send through. A message that names its company
 * (`organizationId`) and is not `auth` mail (sign-in codes, password resets: never held back, a
 * person must always be able to get into their account) is checked against the company's bounce
 * suppressions first. A suppressed recipient is refused with {@link MailRecipientSuppressedError}
 * — a thrown error, so the producer reports the delivery as failed (the invitation screen then
 * shows the link to send by hand) instead of claiming a mail is on its way.
 *
 * Scoped to the company on purpose: an address that bounced for one company says nothing about
 * another company's mail, and one company can never stop another's.
 *
 * A lookup that fails sends anyway (fail-open, as `NotificationMailTransport` does): the mail was
 * wanted until proven otherwise, and a new bounce suppresses the address again.
 */

/**
 * The message with the company it is sent for, so the SMTP driver signs its Message-ID and the
 * guard applies; unchanged when the producer knows no company.
 */
export function forCompany(message: MailMessage, organizationId: string | undefined): MailMessage {
  return organizationId === undefined ? message : { ...message, organizationId };
}

/** Whether a company has stopped mail to an address hash (`emailAddressHash`). */
export interface BounceSuppressionLookup {
  isBounceSuppressed(organizationId: string, addressHash: string): Promise<boolean>;
}

/** The recipient bounced in this company; the message names no address. */
export class MailRecipientSuppressedError extends Error {
  constructor() {
    super('the recipient address bounced and is suppressed for this company');
    this.name = 'MailRecipientSuppressedError';
  }
}

export class BounceGuardMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly lookup: BounceSuppressionLookup,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    const organizationId = message.organizationId;
    if (organizationId !== undefined && laneForTemplate(message.templateKey) !== 'auth') {
      let suppressed = false;
      try {
        suppressed = await this.lookup.isBounceSuppressed(
          organizationId,
          emailAddressHash(message.to),
        );
      } catch {
        this.log('[mailer] bounce suppression lookup failed; sending');
      }
      if (suppressed) throw new MailRecipientSuppressedError();
    }
    return this.inner.send(message);
  }
}
