import { uuidv7 } from '@tmanage/domain';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import type { Mailer } from '@tmanage/mail';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import {
  composeSalesNotification,
  newWalkthroughReference,
  parseWalkthroughRequest,
  walkthroughHoneypotFilled,
} from './walkthrough-content.js';
import type { WalkthroughStore } from './walkthrough.repository.js';

/**
 * LANE-Q — "Book a walkthrough", the public door's service (migration 0388).
 *
 * Order, the 56-17 report door's: parse once (422 on any problem), honeypot (a filled one answers
 * like a success and stores nothing), 52-21's assessment (form proof, windows, spam score), store,
 * then the notification to sales@. A spam or block-list verdict answers the same shape with a
 * reference that was never stored; only a window refusal is a 429. This door cannot show a
 * challenge, so a `challenge` verdict is stored as `hold` and not mailed (a person looks).
 *
 * The visitor's address is a FieldCipher envelope (`walkthrough_email`, owner = row id), or NULL
 * on a keyless host — never plain text in the table; the sales team gets it in the mail. The mail
 * goes through the API's own mail stack (the `mail_queue` outbox when `MAIL_QUEUE=on`), from sales@
 * with Reply-To the visitor. A mail failure never fails the request: the row is kept and
 * `notified_at` stays NULL, which is what the sales team checks.
 */

const CIPHER_PURPOSE = 'walkthrough_email' as const;

export interface WalkthroughSubmitRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly ip: string | undefined;
  readonly acceptLanguage: string | undefined;
  readonly correlationId: string;
}

export type WalkthroughSubmitResult =
  | { readonly kind: 'accepted'; readonly reference: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

export class WalkthroughService {
  constructor(
    private readonly store: WalkthroughStore,
    private readonly cipher: FieldCipher,
    private readonly mailer: Mailer | null,
    private readonly assess: AssessPublicWrite | null,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async submit(request: WalkthroughSubmitRequest): Promise<WalkthroughSubmitResult> {
    const at = this.now();
    const input = parseWalkthroughRequest(request.body, at);
    if (walkthroughHoneypotFilled(request.body)) {
      return { kind: 'accepted', reference: newWalkthroughReference() };
    }
    const verdict = await this.assess?.({
      surface: 'walkthrough_request',
      kind: 'contact',
      body: request.body,
      email: input.email,
      texts: [input.name, input.company],
      ip: request.ip,
      acceptLanguage: request.acceptLanguage,
      pageLocale: input.language,
      offerChallenge: false,
      correlationId: request.correlationId,
    });
    if (verdict?.decision === 'blocked') {
      if (verdict.retryAfterSeconds !== undefined) {
        return { kind: 'rate_limited', retryAfterSeconds: verdict.retryAfterSeconds };
      }
      return { kind: 'accepted', reference: newWalkthroughReference() };
    }
    if (verdict?.decision === 'spam') {
      return { kind: 'accepted', reference: newWalkthroughReference() };
    }
    const decision = verdict === undefined || verdict.decision === 'allow' ? 'allow' : 'hold';
    const id = uuidv7();
    const reference = newWalkthroughReference();
    await this.store.insert(
      {
        id,
        reference,
        name: input.name,
        emailEnc: this.seal(input.email, id),
        company: input.company,
        teamSize: input.teamSize,
        timeZone: input.timeZone,
        slots: input.slots.join(','),
        topics: input.topics.join(','),
        language: input.language,
        source: input.source,
        riskDecision: decision,
        consentAt: at,
        createdAt: at,
      },
      request.correlationId,
    );
    if (decision === 'allow' && this.mailer !== null) {
      try {
        await this.mailer.send(composeSalesNotification(input, reference));
        await this.store.markNotified(id, this.now(), request.correlationId);
      } catch {
        // The request is stored; notified_at stays NULL. No address or text in the log line.
        this.log(`[walkthrough] the sales notification for ${reference} was not sent`);
      }
    }
    return { kind: 'accepted', reference };
  }

  /** Encrypt the address, or store nothing on a keyless host — never plain text. */
  private seal(email: string, id: string): string | null {
    if (!this.cipher.enabled) return null;
    try {
      return this.cipher.encrypt(email, { purpose: CIPHER_PURPOSE, ownerId: id });
    } catch {
      return null;
    }
  }
}
