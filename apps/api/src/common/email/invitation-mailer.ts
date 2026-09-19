import { composeInvitationEmail } from './invitation-email.js';
import type { InvitationEmailFacts } from './invitation-email.js';
import { serializeForLog } from '../observability/logger.js';
import type { Mailer } from '@tmanage/mail';

/**
 * The mail port's first producer — TEN-003's invitation, delivered.
 *
 * One class between `InvitationsService` and the `Mailer` port, because the service should
 * say *what happened to the invitation* and not know SMTP exists. This class owns the two
 * things the port deliberately does not:
 *
 * - **The link.** The accept URL is `${WEB_PUBLIC_URL}/invitations/${token}` — the same
 *   shape ON-04 builds in the browser from `window.location.origin`. Built server-side
 *   from configuration rather than from any request header, because a `Host` header is
 *   attacker-writable and this link carries a credential.
 * - **The failure.** A mail host being down must not roll back or 500 an invitation that
 *   is already committed — the issuer is looking at the printed link, which is the
 *   bootstrap fallback working as designed. So `deliver` never throws: it answers
 *   `'sent'`, `'none'` (no transport was configured to try) or `'failed'`, and the
 *   service records that answer in the audit trail and the response.
 */

export type InvitationDelivery = 'sent' | 'none' | 'failed';

/** `deliver`'s input: the composer's facts, minus the link this class builds. */
export type InvitationDeliveryFacts = Omit<InvitationEmailFacts, 'link'> & {
  readonly token: string;
};

export class InvitationMailer {
  /**
   * @param mailer `null` when no mail wiring exists at all — the database suites' default —
   *   in which case every answer is `'none'` and nothing is composed.
   * @param webPublicUrl `WEB_PUBLIC_URL`, the origin the accept route lives on.
   */
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  /**
   * Whether a transport exists to try — the console driver counts, because printing the
   * composed mail is its whole job. The service reads this before paying for the name join
   * the composer needs: with nothing wired at all, fetching the names of things nobody
   * will compose is a query per invitation for nothing.
   */
  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: InvitationDeliveryFacts): Promise<InvitationDelivery> {
    if (this.mailer === null) {
      return 'none';
    }

    const { token, ...rest } = facts;
    const link = `${this.webPublicUrl.replace(/\/+$/u, '')}/invitations/${token}`;
    try {
      return await this.mailer.send(composeInvitationEmail({ ...rest, link }));
    } catch (error) {
      // The one place a mail error is absorbed, and it is absorbed loudly: the audit row
      // the service writes says `error`, and this line carries the driver's own words —
      // which may name the recipient and can carry the SMTP host and credential, so it goes
      // to the operator's log through the OBS-001 redactor and nowhere else.
      console.error('[mailer] invitation email failed', serializeForLog(error));
      return 'failed';
    }
  }
}
