import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { CredentialsRepository } from './credentials.repository.js';
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
import { REAUTH_TTL_SECONDS, signReauthToken, verifyReauthToken } from './reauth-token.js';
import { findRecoveryCode, generateRecoveryCodes } from './recovery-codes.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';
import { SessionsRepository } from './sessions.repository.js';
import type { SignInAbuseControl, SignInAbuseReason } from './sign-in-abuse-control.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

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
 * `countRecentFailures` counts rows in `authentication_events` within a window — the rows that
 * record a credential being presented and refused, which is not every `failed` row. The three
 * throttle reasons `sign-in-abuse-control.ts` writes in front of the password check are
 * excluded there, and so is the `locked_out` row this file writes when the window is already
 * full: a row the count itself caused is never an input to it, or the lockout would renew
 * itself for as long as anyone kept knocking. `credentials.repository.ts` carries the argument
 * for both. Two honest limitations, both recorded in `docs/implementation-status.md`:
 *
 * - It is **per user**, not per source. It stops credential stuffing against one account and
 *   does nothing about one attempt each against a thousand accounts.
 * - Two attempts arriving together can both read a count below the threshold and both
 *   proceed. The window is a counter, not a lock. Closing that would need `SELECT … FOR
 *   UPDATE` on a row that does not exist yet, and the attacker's gain from the race is one
 *   extra guess.
 *
 * **D08 half-closes the first of those, and it is worth being precise about which half.**
 * `options.abuseControl` (see `sign-in-abuse-control.ts`) now bounds attempts by *where they
 * came from* — per address, per address-and-account, and globally — in front of every path
 * below that costs an Argon2 verify or a log row. What that does **not** buy:
 *
 * - It lives **in process**. The bound is memory in this Node process, not a row, so a
 *   restart forgets every window and **a second process would count separately**; the
 *   bootstrap profile runs **one** API process by design (`50-BOOTSTRAP` §3, `main.ts`), which
 *   is the only reason this is honest. Scale that out and the per-source budget multiplies by
 *   the process count.
 * - It is **bounded by D09**, which is unfixed: `main.ts` sets `trustProxy: true`, so
 *   `request.ip` is whatever `X-Forwarded-For` says. Anyone who can reach the origin directly,
 *   or set that header, can rotate the source key at will — and the source+account key with
 *   it, because that key is `sa:<ip>:<hash>` and *contains* the address. An earlier version of
 *   this comment claimed the account key was not evadable that way; it is, and the final
 *   review of 2026-09-07 was right to call that the wrong claim in the safe-sounding
 *   direction. While D09 stands, what holds against a caller who can set that header is the
 *   global key and the **durable per-user lockout** above (5 failures in 900 s) — and the
 *   lockout is the one that actually catches a grind against a named account. Read both
 *   address-keyed budgets as a cost bound on honest traffic, not as a defence against a
 *   determined attacker, until D09 lands.
 * - The **global key is a deployment-wide refusal lever**, and it is only ever *crossed* by
 *   attempts that were admitted. Not "charged only by" them: a refusal charges the key that
 *   refused it, so a global refusal does charge `g` — on a budget already past its limit, which
 *   moves no verdict. What a refused attempt never charges is a budget it did not reach. That
 *   is what keeps the global boundary out of one address's reach: a single source is refused by
 *   its own key long before it could spend a global budget of 3000 in 300 s, and a refused
 *   attempt charges only the key that refused it — nothing wider, and, since the two-phase
 *   charge of `7cc9c16`, nothing narrower either. The route that
 *   remains is, again, D09 — one attacker who can look like thousands of addresses has every
 *   attempt admitted, and can spend the global budget and refuse everybody until the window
 *   turns. `sign-in-abuse-control.ts` carries the full argument and the sizing.
 *
 * The second limitation — the counter-not-a-lock race — is untouched.
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
 * `D06`. Recorded on `sessions.revoked_reason` for every session a password replacement ends.
 * A lifecycle reason, not a security finding: the person chose the change.
 */
export const PASSWORD_CHANGE_REVOCATION_REASON = 'password_changed';

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
  /** `D05`: the fresh proof asked for before a credential-changing action. */
  reauthentication: 'reauthentication',
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
  | 'recovery_code_spent'
  | 'reauth_required'
  | 'reauth_invalid'
  | 'reauth_expired'
  | 'reauth_wrong_session'
  // `D08`. Which source budget refused, in the abuse control's own words — reused rather
  // than retyped, so the two lists cannot drift apart.
  | SignInAbuseReason;

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
  /**
   * `D08`. The source-based bound consulted in front of every password oracle in this file.
   *
   * **Required, and with no default**, for a reason worth stating rather than leaving to the
   * next reader. The only default this file could honestly supply is one that admits
   * everything — a control nobody chose, failing open, and indistinguishable at the call site
   * from a control that is working. Making it required turns the compiler into the thing that
   * finds every construction site: none of them can be built until someone has decided what
   * budget it runs on. `breachedPasswordScreen` above is the precedent for a collaborator
   * living in this interface rather than arriving as another constructor parameter.
   */
  readonly abuseControl: SignInAbuseControl;
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

/**
 * `D05`. A credential-changing action was asked for without fresh proof of the person.
 *
 * Its own class rather than an `AuthenticationRejectedError`, because the two mean different
 * things to a caller: that one says "you are not signed in", this one says "you are, and this
 * particular action needs you to prove it again". The controller maps it to `403
 * reauthentication_required`, which the client answers by asking for the password (and code)
 * and retrying with the token `confirmReauthentication` returns. The `reason` still goes to
 * the log only.
 */
export class ReauthenticationRequiredError extends Error {
  constructor(readonly reason: AuthenticationReason) {
    super('reauthentication_required');
    this.name = 'ReauthenticationRequiredError';
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

  /**
   * How many refusal rows this process has failed to write. See {@link recordRefusal}: the
   * only place a lost row is visible is the stderr line, and without a count every line reads
   * like the first one.
   */
  private lostRefusalRows = 0;

  constructor(
    private readonly database: TenantDatabase,
    private readonly options: AuthenticationOptions,
    /**
     * Required, with no default. D07 gave the repository a cipher, and the only default this
     * file could supply is one built from a keyring it invented — which would encrypt seeds
     * under a key the deployment does not keep. The caller that knows where the key comes
     * from constructs it: `identity.module.ts` in the application, the suite in a test.
     */
    credentials: CredentialsRepository,
    /** Injectable so a test can drive the TOTP window without waiting thirty seconds. */
    private readonly now: () => number = () => Date.now(),
    /** `D06`: the session cutoff a password replacement applies. Stateless, so the default is real. */
    private readonly sessions: SessionsRepository = new SessionsRepository(),
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

    // `D08`, and the ordering is the whole point: this runs before the user lookup, before
    // the Argon2 verify, and before any `record()` call, so a refused attempt costs three map
    // lookups and nothing else — no read, no 15 ms of CPU, and at most one row per key per
    // window (plus one per eviction from the control's refusing-key set, which its own
    // `createBudget` header prices) rather than one row per attempt. It sits **in front of**
    // the per-user lockout below, not instead of it: this one bounds a source, that one bounds
    // an account, and the account bound is the durable one that survives a restart.
    const verdict = this.options.abuseControl.admit({ ip: context.ip, account: email });
    if (!verdict.admitted) {
      if (verdict.firstRefusalInWindow) {
        // The crossing attempt only. The migration's own comment asks for the trace ("a burst
        // of them from one source is enumeration, and it is the only trace of it"); writing
        // every refusal would re-create the flood this finding is about.
        await this.recordRefusal(context, {
          userId: null,
          action: AUTHENTICATION_ACTIONS.passwordSignIn,
          reason: verdict.reason,
        });
      }
      throw new AuthenticationRejectedError('rate_limited', verdict.reason);
    }

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

    // `D08`. Ahead of the token verification, because this route is `@Public()` and writes a
    // row for every attempt too. No `account`: the caller names no address, and the user this
    // token claims is not known until it has been verified — so the source and global keys
    // are the two that apply here.
    const verdict = this.options.abuseControl.admit({ ip: context.ip });
    if (!verdict.admitted) {
      if (verdict.firstRefusalInWindow) {
        await this.recordRefusal(context, {
          userId: null,
          action: AUTHENTICATION_ACTIONS.mfaChallenge,
          reason: verdict.reason,
        });
      }
      throw new AuthenticationRejectedError('rate_limited', verdict.reason);
    }

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

        return this.spendTotpCode(tx, factors, code);
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

    // `D08`, for the same reason as `completeMfaChallenge`: `@Public()`, a row per attempt,
    // and no account to key on until the challenge token has been verified.
    const verdict = this.options.abuseControl.admit({ ip: context.ip });
    if (!verdict.admitted) {
      if (verdict.firstRefusalInWindow) {
        await this.recordRefusal(context, {
          userId: null,
          action: AUTHENTICATION_ACTIONS.recoveryCode,
          reason: verdict.reason,
        });
      }
      throw new AuthenticationRejectedError('rate_limited', verdict.reason);
    }

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
  // Re-authentication — `D05`
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Prove, from inside a live session, that the person holding it is the person it names.
   *
   * The password is verified with the same discipline as `signInWithPassword` — the lockout
   * window is shared, the dummy-hash verify keeps the no-password path as slow as the
   * wrong-password path — so this surface cannot become a second, unthrottled password oracle
   * beside the one sign-in already guards. If the account holds a confirmed factor, a code is
   * required as well and is spent through the same replay-protected loop `ID-02` uses.
   *
   * On success, mints a token bound to this `userId` **and** this `sessionId`. Nothing is
   * written except the log row; the token is the whole result.
   */
  async confirmReauthentication(input: {
    userId: string;
    sessionId: string;
    password: string;
    code?: string | undefined;
    context: SignInContext;
  }): Promise<{ reauthToken: string; expiresAt: Date }> {
    const { userId, sessionId, password, code, context } = input;

    // `D08`. This is the second password oracle in the file and it costs the same Argon2
    // verify, so it gets the same bound in front of the read — the session guard narrows who
    // can reach it, which is a reason to key it by `userId` rather than a reason to skip it.
    const verdict = this.options.abuseControl.admit({ ip: context.ip, account: userId });
    if (!verdict.admitted) {
      if (verdict.firstRefusalInWindow) {
        // Unlike the three `@Public()` routes, the user here is already established by the
        // session guard, so the row names them — the same `userId` the `locked_out` row below
        // carries, and an operator reading the two together should not have to guess. Named is
        // not counted: `countRecentFailures` excludes the three throttle reasons, so this row
        // cannot move its subject towards the lockout below. Before it did, the per-source and
        // global budgets — which anyone can spend — let a third party drive a named user into
        // their own 900-second lockout (re-review of 2026-09-07, N-2).
        await this.recordRefusal(context, {
          userId,
          action: AUTHENTICATION_ACTIONS.reauthentication,
          reason: verdict.reason,
        });
      }
      throw new AuthenticationRejectedError('rate_limited', verdict.reason);
    }

    const found = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (db) => {
        const [stored, failures] = await Promise.all([
          this.credentials.findPassword(db, userId),
          this.credentials.countRecentFailures(db, userId, this.options.failureWindowSeconds),
        ]);
        return { stored, failures };
      },
    );

    if (found.failures >= this.options.maxFailuresInWindow) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.reauthentication,
        outcome: 'failed',
        reason: 'locked_out',
      });
      throw new AuthenticationRejectedError('rate_limited', 'locked_out');
    }

    const correct = await verifyPassword(
      found.stored?.passwordHash ?? DUMMY_PASSWORD_HASH,
      password,
    );
    if (!found.stored || !correct) {
      const reason: AuthenticationReason = !found.stored ? 'no_password_set' : 'bad_password';
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.reauthentication,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError('invalid_credentials', reason);
    }

    const outcome = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<AuthenticationReason | null> => {
        const factors = await this.credentials.listActiveFactors(tx, userId);
        if (factors.length === 0) return null;
        // A factor exists, so the password alone is not the person. Treated as a wrong code
        // rather than a shape error: the response must not say whether a factor exists.
        if (code === undefined || code === '') return 'mfa_bad_code';
        return this.spendTotpCode(tx, factors, code);
      },
    );

    if (outcome !== null) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.reauthentication,
        outcome: 'failed',
        reason: outcome,
      });
      throw new AuthenticationRejectedError('invalid_credentials', outcome);
    }

    await this.record(context, {
      userId,
      action: AUTHENTICATION_ACTIONS.reauthentication,
      outcome: 'succeeded',
      reason: null,
    });

    const expiresAt = new Date(this.now() + REAUTH_TTL_SECONDS * 1000);
    return {
      reauthToken: signReauthToken({ userId, sessionId, expiresAt }, this.options.sessionSecret),
      expiresAt,
    };
  }

  /**
   * The gate in front of every credential-changing action.
   *
   * Verifies the token, then separately checks that its claims name the caller's own user
   * *and* session. A token minted for another session — even the same person's — is refused
   * with its own reason, so an incident reviewer can tell "no proof" from "someone else's
   * proof". Nothing is written on refusal beyond the log row; the caller has changed nothing.
   *
   * That row is written and never counted. `countRecentFailures` excludes all four `reauth_*`
   * reasons — the argument is in its header under "the gate's own rows" — because the party
   * who can produce them at will is whoever holds the session, not whoever knows the password.
   * While they counted, five refusals here locked the *owner* out of both `signInWithPassword`
   * and {@link AuthenticationService.confirmReauthentication}, which is to say out of every
   * means of ending the session that was writing them.
   */
  private async requireReauth(input: {
    userId: string;
    sessionId: string;
    reauthToken: string | undefined;
    action: AuthenticationAction;
    context: SignInContext;
  }): Promise<void> {
    const verified = verifyReauthToken(input.reauthToken, this.options.sessionSecret, this.now());

    let reason: AuthenticationReason | null = null;
    if (!verified.ok) {
      reason =
        verified.rejection === 'missing'
          ? 'reauth_required'
          : verified.rejection === 'expired'
            ? 'reauth_expired'
            : 'reauth_invalid';
    } else if (
      verified.claims.userId !== input.userId ||
      verified.claims.sessionId !== input.sessionId
    ) {
      reason = 'reauth_wrong_session';
    }

    if (reason === null) return;

    await this.record(input.context, {
      userId: input.userId,
      action: input.action,
      outcome: 'failed',
      reason,
    });
    throw new ReauthenticationRequiredError(reason);
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
   *
   * `D05`: *replacing* a password needs fresh proof; *setting the first one* does not. Whether
   * a row already exists is read before the new value is hashed. An invited person finishing
   * enrolment has no password to re-present, and demanding one would make the account
   * unusable rather than safer. Once a password exists, it is the proof.
   *
   * `D06`: replacing a password ends every *other* live session, in the same transaction as
   * the new hash. A password is replaced to recover from a suspected compromise as often as
   * for any other reason, and a session an intruder already holds is not ended by the
   * password it was opened with going stale — only by a cutoff. The session that carried the
   * proof is kept: it is the device the person is holding, and the change it just made is the
   * fresh proof `D06` asks for before a session survives. Refresh credentials end with the
   * session row (`SessionService.refresh` refuses a revoked session), so nothing has to be
   * done to them separately. A first password ends nothing: no session was ever opened
   * against a password that is now stale.
   */
  async setPassword(input: {
    userId: string;
    sessionId: string;
    password: string;
    reauthToken?: string | undefined;
    identifiers?: readonly string[];
    context: SignInContext;
  }): Promise<void> {
    const existing = await this.database.identityRead(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.findPassword(db, input.userId),
    );
    if (existing !== null) {
      await this.requireReauth({
        userId: input.userId,
        sessionId: input.sessionId,
        reauthToken: input.reauthToken,
        action: AUTHENTICATION_ACTIONS.passwordSet,
        context: input.context,
      });
    }

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
    const replacing = existing !== null;

    await this.database.identityTransaction(
      {
        correlationId: input.context.correlationId,
        tables: replacing ? [...IDENTITY_TABLES, 'sessions'] : [...IDENTITY_TABLES],
      },
      async (tx) => {
        await this.credentials.setPassword(tx, input.userId, hash);
        if (replacing) {
          await this.sessions.revokeOthersForUser(
            tx,
            input.userId,
            input.sessionId,
            PASSWORD_CHANGE_REVOCATION_REASON,
          );
        }
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
   *
   * `D05`, third clause: behind fresh proof, like every other credential-changing action.
   *
   * The gate that *has* to be here is the one on {@link confirmTotpFactor} — that is the
   * method which reaches `replaceRecoveryCodes`, and a gate on this method alone would close
   * nothing, because a caller can post to `/confirm` with an id it already holds. This one is
   * the second half of the pair, and it earns its place twice over. It refuses before a row
   * is written, so a session that cannot prove itself never leaves a pending factor behind;
   * and it refuses before the seed is generated and returned, so an account-bound secret is
   * not handed to a caller who has shown nothing but a cookie. It also fails at the point a
   * person can act on — asked for the password before the QR code, not after they have
   * scanned it.
   *
   * There is no first-time exemption of the kind {@link setPassword} has. The password is the
   * proof, and an account with no password cannot re-authenticate at all — but that is
   * already true of {@link disableFactor} and {@link regenerateRecoveryCodes}, and a second
   * factor guarding an account with no first one guards nothing.
   */
  async beginTotpEnrolment(input: {
    userId: string;
    sessionId: string;
    accountName: string;
    label: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<{ factorId: string; secret: string; uri: string }> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.factorEnrolled,
      context: input.context,
    });

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
   *
   * `D05`, third clause, and **this is the gate the finding was about**. Confirming issues a
   * new set of recovery codes over the top of whatever the account already had and returns
   * the new set to the caller, which is exactly what {@link regenerateRecoveryCodes} does and
   * has always been gated for. Without the gate here, anybody holding a live session — a
   * stolen cookie, an unattended browser, a shared machine — could destroy the owner's
   * recovery codes and read the replacements, and the owner's own copies would simply stop
   * working. A live session is not proof of the person; the password is.
   *
   * Checked **before** the ownership lookup, for the same reason {@link disableFactor} checks
   * before its own: the refusal for a missing token must not differ between a real factor id
   * and an invented one.
   */
  async confirmTotpFactor(input: {
    userId: string;
    sessionId: string;
    factorId: string;
    code: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<{ recoveryCodes: readonly string[] }> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.factorEnrolled,
      context: input.context,
    });

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

  /**
   * Issue a fresh set of recovery codes, invalidating whatever came before.
   *
   * `D05`: always behind fresh proof. Recovery codes only exist once a factor has been
   * confirmed, so there is no first-time case to exempt.
   */
  async regenerateRecoveryCodes(input: {
    userId: string;
    sessionId: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<{ recoveryCodes: readonly string[] }> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
      context: input.context,
    });

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

  /**
   * Remove a second factor. Soft-disabled, so the removal itself stays answerable.
   *
   * `D05`: always behind fresh proof, and checked **before** the ownership lookup, so the
   * refusal for a missing token is the same whether or not the id names a real factor.
   */
  async disableFactor(input: {
    userId: string;
    sessionId: string;
    factorId: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<boolean> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.factorDisabled,
      context: input.context,
    });

    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        // Ownership only. `findFactorIdentity` does not read the seed, so a factor whose
        // stored envelope will not open — the reason someone is most likely to be on this
        // screen — can still be removed.
        const factor = await this.credentials.findFactorIdentity(tx, input.factorId);
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
   * Check a TOTP code against every confirmed factor and spend the counter of the one that
   * matches. Returns the reason for a refusal, or `null` on success.
   *
   * Shared by `completeMfaChallenge` (`ID-02`) and `confirmReauthentication` (`D05`) so that
   * the two places a code is accepted cannot drift apart on replay protection. Extracted, not
   * rewritten: the loop is the one `completeMfaChallenge` has always run.
   */
  private async spendTotpCode(
    tx: IdentityQueryRunner,
    factors: readonly { id: string; secret: string; lastAcceptedCounter: number | null }[],
    code: string,
  ): Promise<AuthenticationReason | null> {
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
  }

  /**
   * `D08`. The one row a refusal writes — and never at the cost of the refusal itself.
   *
   * Everywhere else in this file a failed `record()` is allowed to propagate, and that is
   * right: the row is the only trace of what happened, and losing it silently would be worse
   * than a 500. On this path the priority is inverted. The **refusal is the control** — it is
   * the thing that stops the flood — and the row is a trace of it. Letting the write decide
   * whether the refusal is delivered would mean a database under load answers a throttled
   * caller with a 500 instead of the 429: a more expensive response, on the path that exists
   * to be cheap, at the moment the control is most needed. Worse, the 500 is a different
   * answer from the one every other refused caller gets, which is the disclosure this whole
   * design spends its effort avoiding.
   *
   * So the failure is reported on stderr in the idiom the rest of the API uses (the process's
   * log is the operator's; see `invitations.service.ts` and `file-scanner.ts` recording the
   * same shape of loss — this codebase has no structured logger, and `console.error` is what
   * `eslint.config.js` deliberately leaves open) and the caller still gets the refusal. What
   * is lost is one audit row, and the loss is named rather than silent.
   *
   * **What the line has to carry, and why** — N-5 (re-review of 2026-09-07). This write is
   * attempted at most once per key per window, so a log that has been failing for an hour
   * produces a handful of lines and no other symptom, while `authentication_events` quietly
   * stops carrying the enumeration trace `migrations/0004_credentials.sql` asks for. A reader
   * seeing one such line cannot tell it from the hundredth. So the line carries the running
   * count of refusal rows this process has lost and the correlation id of the attempt that
   * lost this one: a recurring failure reads as `(loss 84)` rather than as another isolated
   * blip, and the id ties it to the request. The counter is process memory and resets with the
   * process, exactly like the windows the control itself keeps. There is still **no other
   * signal** — no metric, no alert — and until the deployment has something that reads one,
   * the trace can go missing with only this line to say so.
   */
  private async recordRefusal(
    context: SignInContext,
    input: {
      userId: string | null;
      action: AuthenticationAction;
      reason: AuthenticationReason;
    },
  ): Promise<void> {
    try {
      await this.record(context, {
        userId: input.userId,
        action: input.action,
        outcome: 'failed',
        reason: input.reason,
      });
    } catch (error) {
      this.lostRefusalRows += 1;
      console.error(
        `[identity] recording a refused ${input.action} (${input.reason}) failed; the refusal still stands` +
          ` (loss ${String(this.lostRefusalRows)} in this process, correlation ${context.correlationId})`,
        error,
      );
    }
  }

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
