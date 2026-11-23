import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import { deriveTrialLinkKey, readTrialLink, verifyTrialLink } from '@tmanage/mail';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import { OutreachRepository, redeemTrialWithin } from './outreach.repository.js';

/**
 * LANE-Q — the personal trial link (`/sign-up?trial=<token>`), read side and redemption.
 *
 * The token (`packages/mail/src/trial-link.ts`) names only the recipient row and an expiry, and
 * is bound by HMAC to that row's address and company: no personal data rides in the URL, and a
 * token stops verifying if the row it was minted for no longer matches. The key is derived from
 * SESSION_SECRET under its own label, as the unsubscribe key is.
 *
 * What the link grants is small on purpose: the sign-up form is pre-filled (workspace name =
 * company, e-mail = the recipient's address) and the new workspace is recorded as the recipient's
 * conversion. It creates nothing by itself: the workspace exists only when the person finishes
 * sign-up and sets their own password (or uses Google); no password is ever e-mailed.
 *
 * Works once: the pre-fill answers `used` after a redemption, and the redemption is a
 * compare-and-set inside the account transaction, so two sign-ups racing on one link record one.
 * A link that is invalid, expired or already used never blocks a sign-up: the person signs up
 * like anyone else, just without the pre-fill and the conversion stamp.
 */

const CIPHER_PURPOSE = 'outreach_email' as const;

export type TrialInviteLookup =
  | {
      readonly kind: 'valid';
      readonly recipientId: string;
      readonly company: string;
      readonly email: string;
      readonly language: 'en' | 'ar';
    }
  | { readonly kind: 'expired' | 'used' | 'invalid' };

export interface TrialInviteView {
  readonly company: string;
  readonly email: string;
  readonly language: 'en' | 'ar';
}

/** The part of the sign-up service's trial handling (`PublicSignupService`). */
export interface SignupTrialInvites {
  /** The recipient id of a valid, unused link, else `null`. */
  validRecipient(token: unknown, correlationId: string): Promise<string | null>;
  /** Inside the account transaction: stamp the recipient. False when another sign-up won. */
  redeemWithin(
    identity: IdentityQueryRunner,
    recipientId: string,
    userId: string,
  ): Promise<boolean>;
}

export class TrialInvites implements SignupTrialInvites {
  constructor(
    private readonly store: Pick<OutreachRepository, 'trialRecipient' | 'stampWalkthrough'>,
    private readonly cipher: FieldCipher,
    /** `deriveTrialLinkKey(SESSION_SECRET)`, or `null` (no secret: every link is invalid). */
    private readonly key: Buffer | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async lookup(token: unknown, correlationId: string): Promise<TrialInviteLookup> {
    const claim = readTrialLink(token);
    if (claim === null || this.key === null) return { kind: 'invalid' };
    const row = await this.store.trialRecipient(claim.recipientId, correlationId);
    if (row === null) return { kind: 'invalid' };
    let email: string;
    try {
      email = this.cipher.decrypt(row.emailEnc, { purpose: CIPHER_PURPOSE, ownerId: row.id });
    } catch {
      return { kind: 'invalid' };
    }
    const verdict = verifyTrialLink(
      this.key,
      token as string,
      { recipientId: row.id, email, company: row.company },
      this.now(),
    );
    if (verdict !== 'valid') return { kind: verdict };
    if (row.redeemed) return { kind: 'used' };
    return {
      kind: 'valid',
      recipientId: row.id,
      company: row.company,
      email,
      language: row.language === 'ar' ? 'ar' : 'en',
    };
  }

  /**
   * OUTREACH MANAGER — "Book a walkthrough" from a campaign mail: a token that verifies (used or
   * not: a person who already signed up may still book) stamps the recipient's `walkthrough_at`
   * once. An invalid or expired token stamps nothing.
   */
  async stampBooking(token: unknown, at: Date, correlationId: string): Promise<boolean> {
    const claim = readTrialLink(token);
    if (claim === null || this.key === null) return false;
    const row = await this.store.trialRecipient(claim.recipientId, correlationId);
    if (row === null) return false;
    let email: string;
    try {
      email = this.cipher.decrypt(row.emailEnc, { purpose: CIPHER_PURPOSE, ownerId: row.id });
    } catch {
      return false;
    }
    const verdict = verifyTrialLink(
      this.key,
      token as string,
      { recipientId: row.id, email, company: row.company },
      this.now(),
    );
    if (verdict !== 'valid') return false;
    return this.store.stampWalkthrough(row.id, at, correlationId);
  }

  async validRecipient(token: unknown, correlationId: string): Promise<string | null> {
    if (token === undefined || token === null || token === '') return null;
    const found = await this.lookup(token, correlationId);
    return found.kind === 'valid' ? found.recipientId : null;
  }

  redeemWithin(identity: IdentityQueryRunner, recipientId: string, userId: string) {
    return redeemTrialWithin(identity, recipientId, userId, this.now());
  }
}

/** The production wiring, shared by the public door and the sign-up service (one key, one rule). */
export function createTrialInvites(
  database: TenantDatabase,
  env: NodeJS.ProcessEnv = process.env,
): TrialInvites {
  const secret = (env['SESSION_SECRET'] ?? '').trim();
  return new TrialInvites(
    new OutreachRepository(database),
    createFieldCipher(loadFieldCipherKeyring(env)),
    secret === '' ? null : deriveTrialLinkKey(secret),
  );
}
