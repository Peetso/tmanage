import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createTwoPhaseFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { serializeForLog } from '../../common/observability/logger.js';
import { AUTHENTICATION_ACTIONS } from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import {
  hashInvitationToken,
  issueInvitationToken,
  looksLikeInvitationToken,
} from './invitation-token.js';
import { describePasswordRejection, hashPassword, screenPassword } from './password.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import type { SeedCipher } from './seed-cipher.js';
import { SessionsRepository } from './sessions.repository.js';
import { BEARER_CREDENTIALS_REVOKER, type BearerCredentialCutoff } from './bearer-credentials.js';

/**
 * Self-service password reset — ID-05's recovery half (walkthrough ACC-02).
 *
 * Two public steps, both with no session:
 *
 * 1. **Request** — an address in, always the same answer out. If an account uses the address,
 *    a 256-bit link (stored only as its SHA-256) is mailed to it; older open links for that
 *    person are retired. The answer and its timing do not depend on whether the address is
 *    known: the mail is sent after the answer is decided and is not awaited, because a
 *    recovery form that confirms an address is an account-enumeration oracle
 *    (`26-THREAT-MODELS`).
 * 2. **Complete** — the link and a new password. The link is spent by a compare-and-set in the
 *    same transaction that replaces the hash, ends **every** session the person holds (they
 *    were locked out; whatever is signed in is not them, or is a device they can sign in on
 *    again), and writes the `password_set` credential-change record and notice (`D05d`), so the
 *    owner is told by email that their password changed. It also marks the address verified
 *    (F03): the link reached that mailbox, which is the proof verification asks for.
 *
 * The token generator and shape check are the invitation's — the same 256-bit base64url value.
 */

/** ID-05's approved copy: "It works once and expires in 30 minutes." */
export const PASSWORD_RESET_TTL_MINUTES = 30;

/** Recorded on `sessions.revoked_reason` for every session a reset ends. */
export const PASSWORD_RESET_REVOCATION_REASON = 'password_reset';

const RESET_TABLES = [
  'users',
  'user_passwords',
  'authentication_events',
  'credential_change_notices',
  'sessions',
  'password_reset_tokens',
] as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** A reset writes a password row and never touches MFA seeds; a seed call fails loudly. */
const refuseSeed = (): never => {
  throw new Error('password reset has no MFA seed cipher');
};
const NO_SEED_CIPHER: SeedCipher = {
  encrypt: refuseSeed,
  decrypt: refuseSeed,
  keyVersionOf: refuseSeed,
  needsRotation: refuseSeed,
};

/**
 * NV11 (wave 9). The mail budget behind the per-address limiter the controller applies.
 *
 * The controller's limiter is keyed by source address only, so a caller with many addresses
 * could mail one person a reset link without limit. Two more bounds, in process like the
 * controller's (a restart forgets them; the bootstrap profile runs one API process):
 *
 *  - **per recipient** - {@link PASSWORD_RESET_MAX_PER_RECIPIENT} requests per normalised address
 *    per window, charged for every well-formed address, known or not, so the bound itself says
 *    nothing about whether an account exists;
 *  - **global** - {@link PASSWORD_RESET_MAX_DELIVERIES} reset mails per window across everyone,
 *    charged only when a mail would actually be sent, so random addresses cannot spend it.
 *
 * Over either bound the request is answered exactly as every other one (202, no mail): the
 * person who really asked can ask again in a while, and the answer still enumerates nothing.
 */
export const PASSWORD_RESET_MAIL_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_MAX_PER_RECIPIENT = 3;
export const PASSWORD_RESET_MAX_DELIVERIES = 500;

export interface PasswordResetMailBudget {
  /** Charge one request for this normalised address; `false` once its window is used. */
  admitRecipient(email: string): boolean;
  /** Charge one delivery against the global window; `false` once it is used. */
  admitDelivery(): boolean;
}

export function createPasswordResetMailBudget(
  options: {
    readonly windowMs?: number;
    readonly maxPerRecipient?: number;
    readonly maxDeliveries?: number;
    readonly now?: () => number;
  } = {},
): PasswordResetMailBudget {
  const windowMs = options.windowMs ?? PASSWORD_RESET_MAIL_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const perRecipient = createTwoPhaseFixedWindowLimiter({
    windowMs,
    max: options.maxPerRecipient ?? PASSWORD_RESET_MAX_PER_RECIPIENT,
    now,
  });
  const deliveries = createTwoPhaseFixedWindowLimiter({
    windowMs,
    max: options.maxDeliveries ?? PASSWORD_RESET_MAX_DELIVERIES,
    maxKeys: 1,
    now,
  });
  return {
    admitRecipient: (email) => {
      const at = now();
      return perRecipient.test(email, at) && perRecipient.commit(email, at);
    },
    admitDelivery: () => {
      const at = now();
      return deliveries.test('all', at) && deliveries.commit('all', at);
    },
  };
}

export interface PasswordResetContext {
  readonly correlationId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export class PasswordResetService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly mailer: PasswordResetMailer | null,
    private readonly resets: PasswordResetRepository = new PasswordResetRepository(),
    private readonly credentials: CredentialsRepository = new CredentialsRepository(NO_SEED_CIPHER),
    private readonly sessions: SessionsRepository = new SessionsRepository(),
    /** F19 (wave 9): the bearer cutoff a completed reset applies beside the session cutoff. */
    private readonly bearerCutoff: BearerCredentialCutoff = BEARER_CREDENTIALS_REVOKER,
    /** NV11 (wave 9): the per-recipient and global mail bounds. One per service instance. */
    private readonly mailBudget: PasswordResetMailBudget = createPasswordResetMailBudget(),
  ) {}

  /**
   * Step 1. Resolves the same way for a known address, an unknown one and a malformed one.
   * Returns the delivery promise only so a test can await it; the controller does not.
   */
  async request(
    rawEmail: unknown,
    context: PasswordResetContext,
  ): Promise<{ readonly delivery: Promise<unknown> }> {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!EMAIL_SHAPE.test(email) || email.length > 254) {
      return { delivery: Promise.resolve('none') };
    }
    // NV11: the per-recipient bound, before any read, so it costs nothing and reveals nothing.
    if (!this.mailBudget.admitRecipient(email)) return { delivery: Promise.resolve('none') };

    const issued = issueInvitationToken();
    const target = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...RESET_TABLES] },
      async (tx) => {
        const account = await this.resets.findAccount(tx, email);
        if (account === null) return null;
        // NV11: the global bound, charged only for a mail that would really be sent. Over it,
        // no link is issued and older links stay as they were.
        if (!this.mailBudget.admitDelivery()) return null;
        await this.resets.retireOpen(tx, account.userId);
        await this.resets.create(tx, {
          userId: account.userId,
          tokenHash: issued.tokenHash,
          ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
        });
        return account;
      },
    );

    if (target === null || this.mailer === null) return { delivery: Promise.resolve('none') };

    const delivery = this.mailer
      .deliver({
        to: target.email,
        displayName: target.displayName,
        locale: target.locale,
        ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
        token: issued.token,
      })
      .catch((error: unknown) => {
        console.error('[password-reset] delivery threw', serializeForLog(error));
        return 'failed' as const;
      });
    return { delivery };
  }

  /** Step 2. 404 for a link that is unknown, used, superseded or expired — all the same. */
  async complete(token: unknown, password: unknown, context: PasswordResetContext): Promise<void> {
    if (typeof token !== 'string' || !looksLikeInvitationToken(token)) throw unusableLink();
    const tokenHash = hashInvitationToken(token);

    const target = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...RESET_TABLES] },
      (db) => this.resets.findLive(db, tokenHash),
    );
    if (target === null) throw unusableLink();

    const candidate = typeof password === 'string' ? password : '';
    const screened = await screenPassword({
      password: candidate,
      identifiers: [target.email.split('@')[0] ?? '', target.displayName],
    });
    if (screened.rejections.length > 0) {
      throw new ApiError(
        422,
        'validation_failed',
        'Choose a different password.',
        screened.rejections.map((rejection) => ({
          field: 'password',
          message: describePasswordRejection(rejection),
        })),
      );
    }

    const hash = await hashPassword(candidate);
    // F19 (wave 9): a reset also ends every personal access token and AI app grant the person
    // holds, in every organization. Those rows are tenant-owned, so they cannot join the identity
    // transaction below (see `bearer-credentials.ts`); the cutoff runs before it - a failure then
    // leaves the link unspent, so the person can retry - and again after it commits.
    await this.bearerCutoff.revokeAllForUser(this.database, {
      userId: target.userId,
      correlationId: context.correlationId,
    });
    await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...RESET_TABLES] },
      async (tx) => {
        // F03 / NV04 (wave 10): spending the mailed link also marks the address verified - it
        // proves the mailbox - and the session and bearer cutoffs here end whatever a
        // pre-registrant of the address held.
        if (!(await this.resets.spend(tx, tokenHash))) throw unusableLink();
        await this.credentials.setPassword(tx, target.userId, hash);
        await this.sessions.revokeAllForUser(tx, target.userId, PASSWORD_RESET_REVOCATION_REASON);
        await this.credentials.recordCredentialChange(tx, {
          userId: target.userId,
          action: AUTHENTICATION_ACTIONS.passwordSet,
          correlationId: context.correlationId,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        });
      },
    );
    await this.bearerCutoff.revokeAllForUser(this.database, {
      userId: target.userId,
      correlationId: context.correlationId,
    });
  }
}

function unusableLink(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'password_reset_unusable');
}
