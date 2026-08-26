import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { CredentialsRepository } from './credentials.repository.js';
import {
  CHALLENGE_TTL_SECONDS,
  signChallengeToken,
  verifyChallengeToken,
} from './challenge-token.js';
import {
  hashPassword,
  needsRehash,
  screenPassword,
  verifyPassword,
  type BreachedPasswordScreen,
  type PasswordRejection,
} from './password.js';
import { findRecoveryCode, generateRecoveryCodes } from './recovery-codes.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

/**
 * ID-002 — what actually proves a person is who they say they are.
 *
 * `SessionService.start()` has always taken a `userId` "established by whatever proved the
 * person's identity". This is that whatever. The two stay separate: this service decides
 * *whether* a person is authenticated, `SessionService` decides what a session *is*, and
 * neither reaches into the other.
 *
 * ## The one rule the whole file is arranged around
 *
 * **Every failure looks the same from outside.**
 *
 * `MembershipResolver` returns one message for every resolution failure so that an outsider
 * cannot enumerate the customer base one slug at a time. `SessionService` does the same for
 * unknown, revoked, expired and replayed sessions. Sign-in is where that discipline matters
 * most, because the identifier is an email address and the question "does this person have an
 * account here" is itself commercially sensitive.
 *
 * So `signInWithPassword` returns exactly one rejection — `invalid_credentials` — for an
 * unknown email, a user with no password set, and a wrong password. The specific cause goes
 * to `authentication_events.reason`, which the caller never sees.
 *
 * That is not enough on its own. An unknown email would return in a millisecond while a
 * wrong password took the 15 ms an Argon2 verify costs, and the difference is measurable over
 * a few hundred requests. So the unknown-user path **runs a verify anyway**, against a hash
 * of a value nobody knows — see {@link DUMMY_PASSWORD_HASH}. The work is wasted deliberately.
 *
 * ## Lockout, and what it is not
 *
 * `countRecentFailures` counts rows in `authentication_events` within a window. Two honest
 * limitations, both recorded in `docs/implementation-status.md`:
 *
 * - It is **per user**, not per source. It stops credential stuffing against one account and
 *   does nothing about one attempt each against a thousand accounts.
 * - Two attempts arriving together can both read a count below the threshold and both
 *   proceed. The window is a counter, not a lock. Closing that would need `SELECT … FOR
 *   UPDATE` on a row that does not exist yet, and the attacker's gain from the race is one
 *   extra guess.
 */

/** The identity tables this service reaches. Enforced by `TenantDatabase.identity*`. */
const IDENTITY_TABLES = [
  'users',
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
] as const;

/**
 * A real Argon2id hash of a value nobody knows, used to keep the unknown-user path as
 * expensive as the wrong-password path.
 *
 * It is a constant rather than a hash computed at boot for one reason: a value computed at
 * boot would have to be held somewhere, and a variable holding "the password hash to compare
 * against when there is no user" is a variable somebody will eventually mistake for a
 * fallback credential. This one verifies against nothing, because the plaintext behind it was
 * never recorded anywhere.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Yzk3NGY4YjEyMzRhNWU2Nw$JXQ0v7q5CqYw3nZ8kK1hJ2mP4tR6sV8xA0bC2dE4fG8';

export const AUTHENTICATION_ACTIONS = {
  passwordSignIn: 'password_sign_in',
  mfaChallenge: 'mfa_challenge',
  recoveryCode: 'recovery_code',
  passwordSet: 'password_set',
  factorEnrolled: 'mfa_factor_enrolled',
  factorDisabled: 'mfa_factor_disabled',
  recoveryCodesIssued: 'recovery_codes_issued',
} as const;

export type AuthenticationAction =
  (typeof AUTHENTICATION_ACTIONS)[keyof typeof AUTHENTICATION_ACTIONS];

/**
 * The precise cause, written to `authentication_events.reason` and never returned.
 *
 * This list is the mirror image of the caller-facing vocabulary: it is as specific as the
 * response is vague, and every entry exists because someone reviewing an incident needs to
 * tell these cases apart.
 */
export type AuthenticationReason =
  | 'no_such_user'
  | 'no_password_set'
  | 'bad_password'
  | 'locked_out'
  | 'mfa_required'
  | 'mfa_bad_code'
  | 'mfa_replayed'
  | 'mfa_no_factor'
  | 'challenge_invalid'
  | 'challenge_expired'
  | 'recovery_code_invalid'
  | 'recovery_code_spent';

/** What the caller is told. Deliberately coarse — see the note at the top of the file. */
export type SignInRejection = 'invalid_credentials' | 'rate_limited';

export interface AuthenticationOptions {
  /** `SESSION_SECRET`. Signs the MFA challenge token; see `challenge-token.ts`. */
  readonly sessionSecret: string;
  /** How many failures inside the window before sign-in is refused outright. */
  readonly maxFailuresInWindow: number;
  /** The window, in seconds. */
  readonly failureWindowSeconds: number;
  /** The `issuer` in the `otpauth://` URI — what an authenticator app shows as the account. */
  readonly totpIssuer: string;
  /** Optional. When absent, only the bundled list screens a new password. */
  readonly breachedPasswordScreen?: BreachedPasswordScreen;
}

export interface SignInContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId: string;
}

/** The person is authenticated. The caller starts a session with this `userId`. */
export interface AuthenticatedOutcome {
  readonly status: 'authenticated';
  readonly userId: string;
}

/** The password was right and a second factor is required — `ID-02`. */
export interface ChallengeOutcome {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: Date;
  /** What to ask for. One entry per confirmed factor; no secrets, no identifiers. */
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
}

export type SignInOutcome = AuthenticatedOutcome | ChallengeOutcome;

export class AuthenticationRejectedError extends Error {
  constructor(
    readonly rejection: SignInRejection,
    /** The specific cause. Logged and written to the event row; never serialised to a caller. */
    readonly reason: AuthenticationReason,
  ) {
    super(rejection);
    this.name = 'AuthenticationRejectedError';
  }
}

export class PasswordRejectedError extends Error {
  constructor(
    readonly rejections: readonly PasswordRejection[],
    readonly remoteScreenUnavailable: boolean,
  ) {
    super('password_rejected');
    this.name = 'PasswordRejectedError';
  }
}

export class AuthenticationService {
  private readonly credentials: CredentialsRepository;

  constructor(
    private readonly database: TenantDatabase,
    private readonly options: AuthenticationOptions,
    credentials: CredentialsRepository = new CredentialsRepository(),
    /** Injectable so a test can drive the TOTP window without waiting thirty seconds. */
    private readonly now: () => number = () => Date.now(),
  ) {
    this.credentials = credentials;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Signing in
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `ID-01`. Verify an email and password, and say what happens next.
   *
   * The Argon2 verify runs **outside** any transaction. It costs 15 ms and holds no lock
   * worth holding; inside a transaction it would pin a pooled connection for the duration of
   * every sign-in attempt, which is the cheapest way to turn a password endpoint into a
   * connection-pool exhaustion attack.
   */
  async signInWithPassword(input: {
    email: string;
    password: string;
    context: SignInContext;
  }): Promise<SignInOutcome> {
    const { email, password, context } = input;

    const found = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (db) => {
        const user = await this.credentials.findUserIdByEmail(db, email);
        if (!user) return null;
        const [stored, failures] = await Promise.all([
          this.credentials.findPassword(db, user.id),
          this.credentials.countRecentFailures(db, user.id, this.options.failureWindowSeconds),
        ]);
        return { user, stored, failures };
      },
    );

    if (found && found.failures >= this.options.maxFailuresInWindow) {
      await this.record(context, {
        userId: found.user.id,
        action: AUTHENTICATION_ACTIONS.passwordSignIn,
        outcome: 'failed',
        reason: 'locked_out',
      });
      throw new AuthenticationRejectedError('rate_limited', 'locked_out');
    }

    // The wasted work that keeps the timing flat. `verifyPassword` returns false rather than
    // throwing on a hash it cannot use, so this is a plain Argon2 run and nothing else.
    const storedHash = found?.stored?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const correct = await verifyPassword(storedHash, password);

    if (!found || !found.stored || !correct) {
      const reason: AuthenticationReason = !found
        ? 'no_such_user'
        : !found.stored
          ? 'no_password_set'
          : 'bad_password';
      await this.record(context, {
        userId: found?.user.id ?? null,
        action: AUTHENTICATION_ACTIONS.passwordSignIn,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError('invalid_credentials', reason);
    }

    const userId = found.user.id;
    const currentHash = found.stored.passwordHash;

    if (needsRehash(currentHash)) {
      // The one moment the plaintext is legitimately in memory. Compare-and-swap, so a
      // password changed in another tab between the verify and here is not reinstated.
      const upgraded = await hashPassword(password);
      await this.database.identityTransaction(
        { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
        (tx) => this.credentials.rehashPassword(tx, userId, currentHash, upgraded),
      );
    }

    const factors = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.listActiveFactors(db, userId),
    );

    if (factors.length === 0) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.passwordSignIn,
        outcome: 'succeeded',
        reason: null,
      });
      return { status: 'authenticated', userId };
    }

    // The password was right, so this is a success for the *password* step even though the
    // sign-in is not finished. Recording it as a failure would put a legitimate person's
    // correct password into the lockout counter.
    await this.record(context, {
      userId,
      action: AUTHENTICATION_ACTIONS.passwordSignIn,
      outcome: 'succeeded',
      reason: 'mfa_required',
    });

    const expiresAt = new Date(this.now() + CHALLENGE_TTL_SECONDS * 1000);
    return {
      status: 'mfa_required',
      challengeToken: signChallengeToken({ userId, expiresAt }, this.options.sessionSecret),
      expiresAt,
      factors: factors.map((factor) => ({
        id: factor.id,
        kind: factor.kind,
        label: factor.label,
      })),
    };
  }

  /**
   * `ID-02`. Complete the sign-in with a code from an authenticator.
   *
   * Verification happens against every confirmed factor rather than against a nominated one.
   * A caller naming its own factor id would be choosing which secret to check a code against,
   * and there is no reason to accept that from an unauthenticated request when trying all of
   * them costs a few HMACs.
   */
  async completeMfaChallenge(input: {
    challengeToken: string | undefined;
    code: string;
    context: SignInContext;
  }): Promise<AuthenticatedOutcome> {
    const { challengeToken, code, context } = input;

    const verified = verifyChallengeToken(challengeToken, this.options.sessionSecret, this.now());
    if (!verified.ok) {
      const reason: AuthenticationReason =
        verified.rejection === 'expired' ? 'challenge_expired' : 'challenge_invalid';
      await this.record(context, {
        userId: null,
        action: AUTHENTICATION_ACTIONS.mfaChallenge,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError('invalid_credentials', reason);
    }

    const userId = verified.claims.userId;

    const outcome = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<AuthenticationReason | null> => {
        const failures = await this.credentials.countRecentFailures(
          tx,
          userId,
          this.options.failureWindowSeconds,
        );
        if (failures >= this.options.maxFailuresInWindow) return 'locked_out';

        const factors = await this.credentials.listActiveFactors(tx, userId);
        if (factors.length === 0) return 'mfa_no_factor';

        const atMs = this.now();
        let replayed = false;

        for (const factor of factors) {
          const result = verifyTotp({
            secret: factor.secret,
            code,
            atMs,
            lastAcceptedCounter: factor.lastAcceptedCounter,
          });

          if (result.ok) {
            // The counter write is itself a compare-and-swap. If it does not apply, another
            // request spent this counter between the verify and here, and this one is the
            // replay.
            const recorded = await this.credentials.recordFactorUse(tx, factor.id, result.counter);
            return recorded ? null : 'mfa_replayed';
          }

          if (result.rejection === 'replayed') replayed = true;
        }

        return replayed ? 'mfa_replayed' : 'mfa_bad_code';
      },
    );

    if (outcome !== null) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.mfaChallenge,
        outcome: 'failed',
        reason: outcome,
      });
      throw new AuthenticationRejectedError(
        outcome === 'locked_out' ? 'rate_limited' : 'invalid_credentials',
        outcome,
      );
    }

    await this.record(context, {
      userId,
      action: AUTHENTICATION_ACTIONS.mfaChallenge,
      outcome: 'succeeded',
      reason: null,
    });
    return { status: 'authenticated', userId };
  }

  /**
   * `ID-02`'s "Enter a recovery code" fallback.
   *
   * Spending the code and reporting success are the same transaction. If they were not, a
   * crash between them would leave a code spent and a person still locked out — the worst of
   * both outcomes, and unrecoverable without support.
   */
  async completeWithRecoveryCode(input: {
    challengeToken: string | undefined;
    code: string;
    context: SignInContext;
  }): Promise<AuthenticatedOutcome> {
    const { challengeToken, code, context } = input;

    const verified = verifyChallengeToken(challengeToken, this.options.sessionSecret, this.now());
    if (!verified.ok) {
      const reason: AuthenticationReason =
        verified.rejection === 'expired' ? 'challenge_expired' : 'challenge_invalid';
      await this.record(context, {
        userId: null,
        action: AUTHENTICATION_ACTIONS.recoveryCode,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError('invalid_credentials', reason);
    }

    const userId = verified.claims.userId;

    const outcome = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<AuthenticationReason | null> => {
        const failures = await this.credentials.countRecentFailures(
          tx,
          userId,
          this.options.failureWindowSeconds,
        );
        if (failures >= this.options.maxFailuresInWindow) return 'locked_out';

        const usable = await this.credentials.listUsableRecoveryCodes(tx, userId);
        const index = findRecoveryCode(
          code,
          usable.map((row) => row.codeHash),
        );
        if (index === undefined) return 'recovery_code_invalid';

        const spent = await this.credentials.consumeRecoveryCode(tx, usable[index]!.id);
        return spent ? null : 'recovery_code_spent';
      },
    );

    if (outcome !== null) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.recoveryCode,
        outcome: 'failed',
        reason: outcome,
      });
      throw new AuthenticationRejectedError(
        outcome === 'locked_out' ? 'rate_limited' : 'invalid_credentials',
        outcome,
      );
    }

    await this.record(context, {
      userId,
      action: AUTHENTICATION_ACTIONS.recoveryCode,
      outcome: 'succeeded',
      reason: null,
    });
    return { status: 'authenticated', userId };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Enrolment — every method here runs for an already-authenticated person
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Set or change a password.
   *
   * Screened before it is hashed, and the rejections are returned in full — this is the one
   * place in the identity surface where being specific is right, because the person is
   * choosing a value and cannot fix it without knowing what is wrong with it. There is no
   * enumeration risk: they are already authenticated, and the subject is their own password.
   */
  async setPassword(input: {
    userId: string;
    password: string;
    identifiers?: readonly string[];
    context: SignInContext;
  }): Promise<void> {
    const screened = await screenPassword({
      password: input.password,
      identifiers: input.identifiers ?? [],
      ...(this.options.breachedPasswordScreen
        ? { remoteScreen: this.options.breachedPasswordScreen }
        : {}),
    });

    if (screened.rejections.length > 0) {
      throw new PasswordRejectedError(screened.rejections, screened.remoteScreenUnavailable);
    }

    const hash = await hashPassword(input.password);

    await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        await this.credentials.setPassword(tx, input.userId, hash);
        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.passwordSet,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
      },
    );
  }

  /**
   * Begin TOTP enrolment.
   *
   * Returns the secret and the `otpauth://` URI, which is the only time the secret leaves the
   * server in a readable form — the person has to be able to type it if a camera will not
   * read the QR code. The factor authorises nothing until {@link confirmTotpFactor} proves a
   * code can be produced from it.
   */
  async beginTotpEnrolment(input: {
    userId: string;
    accountName: string;
    label: string;
    context: SignInContext;
  }): Promise<{ factorId: string; secret: string; uri: string }> {
    const secret = generateTotpSecret();

    const factorId = await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) =>
        this.credentials.createFactor(tx, {
          userId: input.userId,
          kind: 'totp',
          label: input.label,
          secret,
        }),
    );

    return {
      factorId,
      secret,
      uri: totpUri({
        secret,
        accountName: input.accountName,
        issuer: this.options.totpIssuer,
      }),
    };
  }

  /**
   * Finish TOTP enrolment, and issue the recovery codes in the same transaction.
   *
   * Together, because a confirmed factor with no recovery codes is an account one lost phone
   * away from being unrecoverable, and the moment a person is looking at the setup screen is
   * the only moment they will reliably write the codes down.
   *
   * The returned codes are shown once and never again. Nothing stores them in plaintext, so
   * there is nowhere to show them from a second time — which is what makes `ID-05`'s
   * "Regenerating invalidates the old set immediately" a fact rather than a promise.
   */
  async confirmTotpFactor(input: {
    userId: string;
    factorId: string;
    code: string;
    context: SignInContext;
  }): Promise<{ recoveryCodes: readonly string[] }> {
    const generated = generateRecoveryCodes();

    const accepted = await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<boolean> => {
        const factor = await this.credentials.findFactor(tx, input.factorId);
        // The ownership check. Without it, a caller could confirm someone else's pending
        // factor by guessing an id — and a confirmed factor they hold the secret for is a
        // second factor on another person's account.
        if (!factor || factor.userId !== input.userId || factor.disabledAt !== null) return false;

        const result = verifyTotp({
          secret: factor.secret,
          code: input.code,
          atMs: this.now(),
          lastAcceptedCounter: factor.lastAcceptedCounter,
        });
        if (!result.ok) return false;

        const confirmed = await this.credentials.confirmFactor(tx, factor.id, result.counter);
        if (!confirmed) return false;

        await this.credentials.replaceRecoveryCodes(tx, input.userId, generated.hashes);
        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.factorEnrolled,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return true;
      },
    );

    if (!accepted) {
      await this.record(input.context, {
        userId: input.userId,
        action: AUTHENTICATION_ACTIONS.factorEnrolled,
        outcome: 'failed',
        reason: 'mfa_bad_code',
      });
      throw new AuthenticationRejectedError('invalid_credentials', 'mfa_bad_code');
    }

    return { recoveryCodes: generated.codes };
  }

  /** Issue a fresh set of recovery codes, invalidating whatever came before. */
  async regenerateRecoveryCodes(input: {
    userId: string;
    context: SignInContext;
  }): Promise<{ recoveryCodes: readonly string[] }> {
    const generated = generateRecoveryCodes();

    await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        await this.credentials.replaceRecoveryCodes(tx, input.userId, generated.hashes);
        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
      },
    );

    return { recoveryCodes: generated.codes };
  }

  /** Remove a second factor. Soft-disabled, so the removal itself stays answerable. */
  async disableFactor(input: {
    userId: string;
    factorId: string;
    context: SignInContext;
  }): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        const factor = await this.credentials.findFactor(tx, input.factorId);
        if (!factor || factor.userId !== input.userId) return false;

        const disabled = await this.credentials.disableFactor(tx, factor.id);
        if (!disabled) return false;

        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.factorDisabled,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return true;
      },
    );
  }

  /** The factors a person holds, for the security screen. No secrets, ever. */
  async listFactors(input: {
    userId: string;
    correlationId: string;
  }): Promise<readonly { id: string; kind: string; label: string; confirmedAt: Date | null }[]> {
    const rows = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.listAllFactors(db, input.userId),
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      confirmedAt: row.confirmedAt,
    }));
  }

  /** How many recovery codes are still usable. `ID-05` shows "8 unused of 10". */
  async countUsableRecoveryCodes(input: {
    userId: string;
    correlationId: string;
  }): Promise<number> {
    const rows = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.listUsableRecoveryCodes(db, input.userId),
    );
    return rows.length;
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Append one row to the pre-tenant security log, in a transaction of its own.
   *
   * Separate from whatever it describes, deliberately. A failed sign-in has no transaction to
   * join — nothing was written — and a failure recorded inside a transaction that then rolled
   * back would be a failure with no record. `AuditService` joins its caller's transaction for
   * the opposite reason: it describes a change, and the record must not outlive a change that
   * did not commit.
   */
  private async record(
    context: SignInContext,
    input: {
      userId: string | null;
      action: AuthenticationAction;
      outcome: 'succeeded' | 'failed';
      reason: AuthenticationReason | null;
    },
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) =>
        this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: input.action,
          outcome: input.outcome,
          reason: input.reason,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          correlationId: context.correlationId,
        }),
    );
  }
}
