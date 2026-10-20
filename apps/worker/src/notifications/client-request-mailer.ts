import type { Mailer, MailMessage } from '@tmanage/mail';
import type { ClientRequestMailFacts } from '../common/database/mail-store.js';
import {
  composeClarificationRequiredEmail,
  composeClientRequestReceivedEmail,
  composeRequestAcceptedEmail,
  composeRequestDeclinedEmail,
  composeRequestDeferredEmail,
} from './client-request-email.js';

/**
 * The relay's mail producer — `InvitationMailer`'s shape, on the worker's side of the wire.
 *
 * One class between the consumers and the `Mailer` port, owning the two things the port
 * deliberately does not:
 *
 * - **The link.** `${WEB_PUBLIC_URL}/${slug}/portal/requests/${id}` is the portal route
 *   `apps/web/src/app/[orgSlug]/portal/requests/[requestId]` serves. Built from
 *   configuration, never from anything on the event — the relay has no request to take a
 *   `Host` header from, which is the only reason that class of mistake is impossible here.
 * - **The failure.** `deliver` never throws. It runs on the far side of the batch's commit,
 *   where a throw could not un-publish the event it belongs to (see the dispatcher's module
 *   doc), so absorbing the error and reporting it is the only honest shape.
 *
 * ## Which transitions are mailed
 *
 * `client_request.transitioned.v1` fires for every legal move in `23-ERD` §6. This class mails
 * the four destinations the client is owed an answer about: `needs_clarification`, `accepted`,
 * `declined` and `deferred`. REQ-03 added the last two — a client who hears nothing when their
 * request is turned down or parked reads the silence as the request being lost — and each
 * carries the manager's client-safe `client_visible_reason`. `planned` and `delivered` are
 * studio-internal lifecycle steps the client already tracks through the accepted request;
 * `triage` reads as `submitted` and is not an answer; `withdrawn` is the client's own act and is
 * not even notified, per NOTIF-001.
 */

export type ClientRequestMailKind =
  'received' | 'clarification' | 'accepted' | 'declined' | 'deferred';

/** What became of one message. `'none'` means no transport was configured to try. */
export type ClientRequestMailDelivery = 'sent' | 'none' | 'failed';

/**
 * The destination states §3 has copy for, mapped to their template. `toStatus` values not in
 * this table are not mailed — see the class doc.
 */
const KIND_BY_STATUS: Readonly<Record<string, ClientRequestMailKind>> = {
  needs_clarification: 'clarification',
  accepted: 'accepted',
  declined: 'declined',
  deferred: 'deferred',
};

/**
 * The template for a transition's destination state, or `null` when §3 writes none.
 *
 * `Object.hasOwn` rather than a bare lookup: `toStatus` comes off an event payload, and a
 * plain object literal answers `'constructor'` and `'toString'` from its prototype. TypeScript
 * types that lookup as `ClientRequestMailKind | undefined` and is wrong at runtime, so the
 * check is here rather than trusted to the type. Its own test asserts both keys.
 */
export function mailKindForStatus(toStatus: string): ClientRequestMailKind | null {
  if (!Object.hasOwn(KIND_BY_STATUS, toStatus)) return null;
  return KIND_BY_STATUS[toStatus] ?? null;
}

const COMPOSERS = {
  received: composeClientRequestReceivedEmail,
  clarification: composeClarificationRequiredEmail,
  accepted: composeRequestAcceptedEmail,
  declined: composeRequestDeclinedEmail,
  deferred: composeRequestDeferredEmail,
} as const;

export class ClientRequestMailer {
  /**
   * @param mailer `null` when no transport is wired at all — every database suite's default,
   *   and the shape a deployment that never called `MailerModule.forConfig` has. Every
   *   delivery then answers `'none'` and nothing is composed.
   * @param webPublicUrl `WEB_PUBLIC_URL`, the origin the portal is served from.
   */
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  /**
   * Whether a transport exists to try. The consumers read this before paying for the join
   * `findClientRequestMailFacts` costs: with nothing wired, that is a query per event for a
   * message nobody will compose.
   */
  get enabled(): boolean {
    return this.mailer !== null;
  }

  /** The message this kind of event would send, composed but not sent. Exposed for suites. */
  compose(
    kind: ClientRequestMailKind,
    requestId: string,
    facts: ClientRequestMailFacts,
  ): MailMessage {
    const origin = this.webPublicUrl.replace(/\/+$/u, '');
    const link = `${origin}/${facts.organizationSlug}/portal/requests/${requestId}`;
    return COMPOSERS[kind]({ ...facts, link });
  }

  async deliver(
    kind: ClientRequestMailKind,
    requestId: string,
    facts: ClientRequestMailFacts,
  ): Promise<ClientRequestMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(this.compose(kind, requestId, facts));
    } catch (error) {
      // Absorbed loudly. The driver's words may name the recipient's address, so they go to
      // the operator's log and nowhere else — never into the batch report, which `main.ts`
      // prints, and never into an audit row, which `assertSafeAuditMetadata` would refuse.
      console.error(`[worker] client request email failed for request ${requestId}`, error);
      return 'failed';
    }
  }
}
