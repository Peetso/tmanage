import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { serializeForLog } from '../../common/observability/logger.js';
import type { CredentialsRepository } from './credentials.repository.js';
import {
  CHALLENGE_TTL_SECONDS,
  signChallengeToken,
  verifyChallengeToken,
} from './challenge-token.js';
import type { ChallengeClaims } from './challenge-token.js';
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
import { BEARER_CREDENTIALS_REVOKER, type BearerCredentialCutoff } from './bearer-credentials.js';
import type { SignInAbuseControl, SignInAbuseReason } from './sign-in-abuse-control.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { openResetSignInGrant } from './reset-sign-in-grant.js';
import { ApiError } from '../../common/http/errors.js';
import type { SignInPolicyGate } from './sign-in-policy.repository.js';
import type { MfaCodeMailer } from '../../common/email/mfa-code-email.js';
import { EMAIL_FACTOR_KIND, TOTP_FACTOR_KIND } from './credentials.repository.js';
import { EmailCodesRepository } from './email-codes.repository.js';
import {
  EMAIL_CODE_RESEND_GAP_MS,
  EMAIL_CODE_TTL_SECONDS,
  emailCodeBinding,
  emailCodeMatches,
  generateEmailCode,
  hashEmailCode,
  maskEmailAddress,
  type EmailCodePurpose,
  type EmailCodeSendBudget,
} from './email-code.js';

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
 * - Both address-keyed budgets are worth **only as much as the address is scarce**, and D09
 *   narrowed that rather than removing it. `main.ts` no longer sets `trustProxy: true`: trust
 *   comes from `TRUSTED_PROXY_ADDRESSES`, and unset means trust nobody, so a caller reaching
 *   the origin directly is counted by the socket peer and cannot rotate the source key by
 *   writing a header. What remains evadable is a caller behind a **misconfigured** trusted
 *   proxy: `request.ip` is the right-most untrusted `X-Forwarded-For` entry verbatim, so that
 *   caller chooses it wherever the proxy forwards the client's header untouched, prepends its
 *   own observation rather than appending it, or is named through a trusted range broad enough
 *   to contain real clients. An **appending** proxy is not one of those cases — its own
 *   observation lands at the right-hand end and ends the walk there — and an earlier version of
 *   this comment had that exactly backwards. The source+account key goes with the source key
 *   wherever the address is chosen, because that key is `sa:<ip>:<hash>` and *contains* the
 *   address. An earlier version of this comment also claimed the account key was not evadable
 *   that way; it is, and the final review of 2026-09-07 was right to call that the wrong claim
 *   in the safe-sounding direction. Against such a caller what holds is the global key and the
 *   **durable per-user lockout** above (5 failures in 900 s) — the lockout being the one that
 *   actually catches a grind against a named account, and `docs/runbooks/deploy.md` being where
 *   the operator is given the measured table and the three shapes to avoid. Even in a correctly
 *   configured deployment, abundance is untouched:
 *   one IPv6 /64 holds 2^64 authentic addresses (`docs/implementation-status.md` follow-up 6,
 *   open). So read both address-keyed budgets as a cost bound on honest traffic rather than as
 *   a defence against a determined attacker.
 * - The **global key is a deployment-wide refusal lever**, and it is only ever *crossed* by
 *   attempts that were admitted. Not "charged only by" them: a refusal charges the key that
 *   refused it, so a global refusal does charge `g` — on a budget already past its limit, which
 *   moves no verdict. What a refused attempt never charges is a budget it did not reach. That
 *   is what keeps the global boundary out of one address's reach: a single source is refused by
 *   its own key long before it could spend a global budget of 3000 in 300 s, and a refused
 *   attempt charges only the key that refused it — nothing wider, and, since the two-phase
 *   charge of `7cc9c16`, nothing narrower either. The route that
 *   remains is, again, address abundance — one attacker who can look like thousands of
 *   addresses, from behind a misconfigured trusted proxy or across an IPv6 /64, has every
 *   attempt admitted, and can spend the global budget and refuse everybody until the window
 *   turns.
 *   `sign-in-abuse-control.ts` carries the full argument and the sizing.
 *
 * The second limitation — the counter-not-a-lock race — is untouched.
 */

/** The identity tables this service reaches. Enforced by `TenantDatabase.identity*`. */
const IDENTITY_TABLES = [
  'users',
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  // MFAOPTIONS (0360): the mailed second-step codes.
  'user_mfa_email_codes',
  'authentication_events',
  // `D05d`. The notice queue. Declared on every identity unit of work rather than only on
  // the four that write it, because the alternative is a second list to keep in step with
  // the first, and a missing declaration fails at run time rather than at compile time.
  'credential_change_notices',
] as const;

/**
 * `D06`. Recorded on `sessions.revoked_reason` for every session a password replacement ends.
 * A lifecycle reason, not a security finding: the person chose the change.
 */
export const PASSWORD_CHANGE_REVOCATION_REASON = 'password_changed';

/**
 * `I-1`. Recorded on `sessions.revoked_reason` for a session a person ends themselves from the
 * device/session list — whether one named device or every other one. A lifecycle reason, and
 * a deliberate one: distinct from `password_changed` (a cutoff that is a side effect of a
 * credential change) and from `refresh_reuse_detected` (a security finding the person did not
 * choose). It says the holder pressed the lever.
 */
export const USER_SESSION_REVOCATION_REASON = 'user_revoked';

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
  /** `I-1`: a session a person ended themselves from the device/session list. */
  sessionRevoked: 'session_revoked',
  /** MFAOPTIONS: the method a sign-in asks for first was changed. A credential change. */
  mfaDefaultChanged: 'mfa_default_changed',
} as const;

export type AuthenticationAction =
  (typeof AUTHENTICATION_ACTIONS)[keyof typeof AUTHENTICATION_ACTIONS];

/**
 * `D05d`. The actions that mean **somebody changed the credentials on this account** — the
 * four the owner has to be able to find out about, and the whole of what
 * {@link AuthenticationService.listCredentialChanges} asks the table for.
 *
 * The four that are absent are absent for a reason each. `passwordSignIn`, `mfaChallenge` and
 * `recoveryCode` are uses of a credential, not changes to one: a sign-in history is a
 * different screen with a different privacy question, and this list is not the place to start
 * one. `reauthentication` is the proof demanded *before* a change, so it is either redundant
 * with the row beside it or, when refused, a failure — and failures are excluded by outcome.
 *
 * A `const` beside the vocabulary rather than a filter at the call site, so that adding a
 * fifth credential-changing action puts the question "does the owner need to know?" in front
 * of whoever adds it.
 */
export const CREDENTIAL_CHANGE_ACTIONS = [
  AUTHENTICATION_ACTIONS.passwordSet,
  AUTHENTICATION_ACTIONS.factorEnrolled,
  AUTHENTICATION_ACTIONS.factorDisabled,
  AUTHENTICATION_ACTIONS.recoveryCodesIssued,
  // MFAOPTIONS. Which method is asked for first changes what an intruder holding the session
  // would be asked for, so the owner is told.
  AUTHENTICATION_ACTIONS.mfaDefaultChanged,
] as const;

/** One entry on `ID-05`'s security event receipt. No reason, no address, no device. */
export interface CredentialChange {
  readonly id: string;
  readonly action: AuthenticationAction;
  readonly occurredAt: Date;
}

/**
 * One factor as `GET /v1/auth/factors` returns it on the wire — the shape `apps/web` reads
 * (`apps/web/src/lib/api/auth.ts EnrolledFactor`).
 *
 * Distinct from what {@link AuthenticationService.listFactors} returns internally, whose
 * `confirmedAt` is a `Date`: the controller serialises that to an ISO string (or `null` while
 * enrolment is unfinished), and this view names the serialised shape so `contracts:check` can
 * pair it. Naming it here rather than in the controller keeps it under `*.service.ts`, which is
 * where the gate enumerates response views.
 */
export interface EnrolledFactorView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly confirmedAt: string | null;
  /** MFAOPTIONS: the method a sign-in asks for first. */
  readonly isDefault: boolean;
}

/**
 * MFAOPTIONS. What `POST /v1/auth/mfa/email-code` and `POST /v1/auth/factors/email` answer after a
 * code was mailed: the address masked (`p•••@domain`), when a new code may be asked for, and how
 * long this one works. Never the code.
 */
export interface EmailCodeSentView {
  readonly sentTo: string;
  readonly resendAfterSeconds: number;
  readonly expiresInSeconds: number;
}

/** MFAOPTIONS. Where a mailed code goes, and in which language. */
interface MailContact {
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
}

/** MFAOPTIONS. `POST /v1/auth/factors/email`: the pending row and where its code went. */
export interface EmailFactorStartedView extends EmailCodeSentView {
  readonly factorId: string;
}

/**
 * MFAOPTIONS. Turning the e-mail method on was refused before any code was sent, for a reason the
 * signed-in person can act on: the address was never verified, or the method is already on.
 */
export class EmailFactorUnavailableError extends Error {
  constructor(readonly reason: 'email_not_verified' | 'already_enabled' | 'mail_unavailable') {
    super(reason);
    this.name = 'EmailFactorUnavailableError';
  }
}

/** MFAOPTIONS. The two methods that finish a challenge with a six-digit code. */
export type SecondFactorMethod = 'totp' | 'email';

/** How much history the receipt carries. Bounded here rather than by the caller. */
export const CREDENTIAL_CHANGE_LIMIT = 50;

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
  // N01 (wave 11). On a *succeeded* password sign-in row only: the correct password was let
  // through a full lockout window by a reset sign-in grant (`reset-sign-in-grant.ts`).
  | 'reset_grant'
  // ---- platform-admin v2 · PA-06 ---- A platform admin disabled the account (0247). The caller
  // hears the ordinary `invalid_credentials`; only this row says why.
  | 'account_disabled'
  // R18-e (56-25). A correct password refused because the organization's sign-in policy does not
  // allow passwords. Excluded from the lockout count (`NON_CREDENTIAL_FAILURE_REASONS`).
  | 'policy_method_not_allowed'
  // MFAOPTIONS. The sign-in challenge took five wrong e-mail codes and is dead.
  | 'mfa_challenge_dead'
  // MFAOPTIONS. A code was asked for again inside 30 s, or past five sends in an hour.
  | 'mfa_email_too_soon'
  | 'mfa_email_over_budget'
  // `D08`. Which source budget refused, in the abuse control's own words — reused rather
  // than retyped, so the two lists cannot drift apart.
  | SignInAbuseReason;

/** What the caller is told. Deliberately coarse — see the note at the top of the file. */
export type SignInRejection = 'invalid_credentials' | 'rate_limited';

/**
 * The three ways a password credential check ends once the password has been verified.
 *
 * - `admit` — the password was right, so the person is who they say they are.
 * - `locked_out` — the password was wrong *and* the durable window is already full.
 * - `reject` — the password was wrong and the window is not yet full (an ordinary failure,
 *   the row that moves the account towards the lockout next time).
 */
export type VerifyFirstDecision = 'admit' | 'locked_out' | 'reject';

/**
 * `C-1` — the durable lockout's ordering, made a pure function so the property that closes the
 * finding is provable without a database.
 *
 * The finding: the lockout was consulted **before** the password was verified, so once a hostile
 * source had spent `maxFailuresInWindow` wrong guesses against a known account, the account
 * holder's own **correct** password was refused with `locked_out` for the rest of the window —
 * and a wrong guess every window held it shut indefinitely, with no self-service way out (the
 * same window gates `confirmReauthentication`, the only door to a password change). x14 bounded
 * the source that could arm it but recorded the real close as this ordering change.
 *
 * Verify first, then charge: a correct password is admitted whatever the window says — it is
 * never charged and can never trip a lockout — so a wrong password can no longer deny a right
 * one. Only the failing path consults the window, and there it throttles exactly as before:
 * a wrong password at or above the threshold is `locked_out`, below it an ordinary `reject`.
 *
 * **F20 (wave 9) reversed the "a correct credential bypasses the window" half.** Admitting a
 * right guess through a full window meant the lockout never changed whether *any* guess
 * succeeded - it only relabelled wrong ones - so an attacker rotating source addresses could keep
 * guessing a password or a six-digit code and the first right guess signed in while the account
 * was nominally locked. Now a full window refuses every guess, right or wrong, without admitting
 * it.
 *
 * **N01 (wave 10): the holder's way out.** Password reset by email (`password-reset.service.ts`)
 * never consults this window, and since N01 it also ends the lockout: `countRecentFailures`
 * counts only failures at or after the latest succeeded `password_set` row, which the reset (or a
 * password change) writes in its own transaction. Before that, the reset changed the password
 * but the old wrong guesses still filled the window, so one wrong guess every few minutes kept
 * the account shut even for the new password. The window still never counts its own
 * `locked_out` refusals, so without a reset it drains once the guessing stops.
 *
 * **N01 (wave 11): a guesser could re-fill the window seconds after the reset.** So the browser
 * that completed the reset holds a sealed, single-use reset sign-in grant
 * (`reset-sign-in-grant.ts`), and `resetGrantValid` says it was presented, opened, names this
 * account and this reset, and no sign-in has succeeded since. A full window with the **correct**
 * password **and** a valid grant is the one combination that changes: `admit`. Everything else is
 * as before - a wrong password with a grant is still `reject` / `locked_out` and is recorded, and
 * a right password without one still meets F20's refusal. The second factor is not this
 * function's business and is never skipped. `confirmReauthentication` always passes `false`.
 */
export function decideVerifyFirst(input: {
  readonly passwordCorrect: boolean;
  readonly failuresInWindow: number;
  readonly maxFailuresInWindow: number;
  readonly resetGrantValid: boolean;
}): VerifyFirstDecision {
  if (input.failuresInWindow >= input.maxFailuresInWindow) {
    return input.passwordCorrect && input.resetGrantValid ? 'admit' : 'locked_out';
  }
  return input.passwordCorrect ? 'admit' : 'reject';
}

/**
 * F01 (wave 9). How recent a sign-in must be for it to count as fresh proof of the person when a
 * **first** password is attached to an account that has none (a Google-created account). Ten
 * minutes: long enough to sign in with Google and open Preferences, short enough that a session
 * stolen later - or a bearer token, which has no session row at all - cannot attach a durable
 * password.
 */
export const FIRST_PASSWORD_FRESH_SIGN_IN_SECONDS = 600;

/**
 * F01 (wave 9). A first password was asked for from a session that is not a fresh sign-in. The
 * controller maps it to `401 reauthentication_required` (audit code `reauth_required`); the
 * Preferences screen tells the person to sign in with Google again and then set the password.
 */
export class FreshSignInRequiredError extends Error {
  constructor() {
    super('fresh_sign_in_required');
    this.name = 'FreshSignInRequiredError';
  }
}

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
  /**
   * R18-e (56-25). The organization sign-in policy, consulted only after a CORRECT password (so
   * the refusal is no e-mail-existence oracle). Absent (unit suites, the platform admin's own
   * service) = no policy check; `identity.module.ts` always wires it.
   */
  readonly signInPolicy?: Pick<SignInPolicyGate, 'check'>;
  /**
   * MFAOPTIONS. How a two-step code is mailed, and the send limits (`email-code.ts`). Absent (unit
   * suites that never mail) = the e-mail method cannot be sent or turned on: it fails closed with
   * `mail_unavailable`, it never skips the second step.
   */
  readonly emailCodes?: {
    readonly mailer: Pick<MfaCodeMailer, 'enabled' | 'deliver'>;
    readonly budget: EmailCodeSendBudget;
  };
}

export interface SignInContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId: string;
  /** R12 (0280). The password sign-in's automation signal, stamped on the events it writes. */
  readonly automation?: {
    readonly score: number;
    readonly reasons: readonly string[];
    readonly clientHints: string | null;
  };
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
    /**
     * F19 (wave 9): the bearer cutoff - personal access tokens and AI app grants - that a password
     * change and "sign out other sessions" apply beside the session cutoff. Stateless default.
     */
    private readonly bearerCutoff: BearerCredentialCutoff = BEARER_CREDENTIALS_REVOKER,
    /** MFAOPTIONS. Mailed second-step codes. Stateless, like `SessionsRepository`. */
    private readonly emailCodeStore: Pick<
      EmailCodesRepository,
      'create' | 'findOpen' | 'recordWrongAttempt' | 'spend' | 'isExhausted'
    > = new EmailCodesRepository(),
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
    /**
     * N01 (wave 11). The sealed reset sign-in grant from the `tm_reset_grant` cookie, as the
     * controller read it; never from the body. See {@link decideVerifyFirst}.
     */
    resetGrant?: string | undefined;
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

    // N01 (wave 11). An HMAC and a clock read, no I/O: a forged, tampered or expired grant is
    // `undefined` here and changes nothing below.
    const grant =
      input.resetGrant === undefined
        ? undefined
        : openResetSignInGrant(input.resetGrant, this.options.sessionSecret, this.now());

    const found = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (db) => {
        const user = await this.credentials.findUserIdByEmail(db, email);
        if (!user) return null;
        const [stored, failures, resetGrantValid, standing] = await Promise.all([
          this.credentials.findPassword(db, user.id),
          this.credentials.countRecentFailures(db, user.id, this.options.failureWindowSeconds),
          grant !== undefined && grant.userId === user.id
            ? this.resetGrantStillOpen(db, user.id, grant.passwordSetAt)
            : Promise.resolve(false),
          this.sessions.findStanding(db, user.id),
        ]);
        return { user, stored, failures, resetGrantValid, standing };
      },
    );

    // The wasted work that keeps the timing flat, and — since C-1 — it runs *before* the
    // durable window is consulted. `verifyPassword` returns false rather than throwing on a
    // hash it cannot use, so this is a plain Argon2 run and nothing else, taken for every
    // attempt so an unknown account and a locked one are indistinguishable by timing.
    const storedHash = found?.stored?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const correct = await verifyPassword(storedHash, password);

    // Verify first, then decide (C-1, F20). The password has been checked above; only now is the
    // durable window consulted. A full window refuses right and wrong guesses alike (F20), so the
    // lockout really stops a guesser; the holder clears it by resetting the password by email,
    // because the window counts only failures since the latest password change (N01).
    const decision = decideVerifyFirst({
      passwordCorrect: Boolean(found?.stored) && correct,
      failuresInWindow: found?.failures ?? 0,
      maxFailuresInWindow: this.options.maxFailuresInWindow,
      resetGrantValid: found?.resetGrantValid ?? false,
    });

    if (decision !== 'admit') {
      const reason: AuthenticationReason =
        decision === 'locked_out'
          ? 'locked_out'
          : !found
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
      throw new AuthenticationRejectedError(
        decision === 'locked_out' ? 'rate_limited' : 'invalid_credentials',
        reason,
      );
    }

    // `admit` is returned only when the password was correct, which requires both `found` and a
    // stored hash; the guard re-states that for the type-checker and fails closed if it ever
    // does not hold.
    if (!found || !found.stored) {
      throw new AuthenticationRejectedError('invalid_credentials', 'bad_password');
    }
    const userId = found.user.id;
    // ---- platform-admin v2 · PA-06 ---- A disabled account (0247) is refused with the same
    // neutral answer as a wrong password, and only after the password was checked, so the answer
    // says nothing to someone who does not know it. The row names the cause.
    if (found.standing?.disabledAt) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.passwordSignIn,
        outcome: 'failed',
        reason: 'account_disabled',
      });
      throw new AuthenticationRejectedError('invalid_credentials', 'account_disabled');
    }
    // R18-e (56-25). Only now, after the right password: a person every one of whose
    // organizations forbids passwords is refused, told which methods to use, and the row says why.
    // A failed read throws (fail closed: no session).
    const policyRefusal = await this.options.signInPolicy?.check(
      userId,
      'password',
      context.correlationId,
    );
    if (policyRefusal) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.passwordSignIn,
        outcome: 'failed',
        reason: 'policy_method_not_allowed',
      });
      throw signInMethodNotAllowed(policyRefusal);
    }
    const currentHash = found.stored.passwordHash;
    // N01 (wave 11): only a grant that actually carried the attempt through a full window is
    // named on the row. Either way the succeeded row written below is what spends the grant.
    const admittedByGrant = found.failures >= this.options.maxFailuresInWindow;

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
        reason: admittedByGrant ? 'reset_grant' : null,
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
    // N01 (wave 12). The succeeded row above spends the grant for the password step, so the
    // challenge carries it on: only when the grant really admitted this attempt through a full
    // window does the signed challenge name the grant's reset, and only then may the code step
    // pass a full window - once, for this user, while that reset is still the latest.
    const resetGrantPasswordSetAt =
      admittedByGrant && grant !== undefined && grant.userId === userId
        ? grant.passwordSetAt
        : undefined;
    return {
      status: 'mfa_required',
      challengeToken: signChallengeToken(
        resetGrantPasswordSetAt === undefined
          ? { userId, expiresAt }
          : { userId, expiresAt, resetGrantPasswordSetAt },
        this.options.sessionSecret,
      ),
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
    /**
     * MFAOPTIONS. Which kind of code this is. Only a choice between the person's own **enabled**
     * methods: the server lists them from the database and refuses a method the person does not
     * hold, so no value here can skip or downgrade the second step.
     */
    method?: SecondFactorMethod;
    context: SignInContext;
  }): Promise<AuthenticatedOutcome> {
    const { challengeToken, code, context } = input;
    const method: SecondFactorMethod = input.method ?? 'totp';

    // F20 (wave 9): the challenge token is verified first - an HMAC and a clock read, no I/O -
    // so the abuse control below can be keyed on the account the token names as well as on the
    // source. Before, this step carried no account key at all, so its only per-account bound was
    // the durable window, which a correct guess bypassed.
    const verified = verifyChallengeToken(challengeToken, this.options.sessionSecret, this.now());

    // `D08`. Still ahead of every read and every row, because this route is `@Public()` and
    // writes a row for every attempt too.
    const verdict = this.options.abuseControl.admit({
      ip: context.ip,
      account: verified.ok ? verified.claims.userId : undefined,
    });
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

    // F20 (wave 9): the durable window is read **before** the code is spent, as
    // `completeWithRecoveryCode` does. A full window refuses the attempt without evaluating the
    // code, so a right guess is no longer admitted while the account is locked; the holder's way
    // out is password reset by email, which never consults this window. `spendTotpCode` is
    // unchanged, so its counter compare-and-swap (replay protection) is untouched.
    const outcome = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<AuthenticationReason | null> => {
        // PA-06: disabled between the password step and this one (0247).
        if ((await this.sessions.findStanding(tx, userId))?.disabledAt) return 'account_disabled';
        const failures = await this.credentials.countRecentFailures(
          tx,
          userId,
          this.options.failureWindowSeconds,
        );
        if (
          failures >= this.options.maxFailuresInWindow &&
          !(await this.secondFactorGrantStillOpen(tx, userId, verified.claims))
        ) {
          return 'locked_out';
        }
        // MFAOPTIONS. Five wrong e-mail codes kill the challenge for every method.
        const binding = emailCodeBinding('sign_in', challengeToken ?? '');
        if (await this.emailCodeStore.isExhausted(tx, binding)) return 'mfa_challenge_dead';
        const factors = await this.credentials.listActiveFactors(tx, userId);
        return this.verifySecondFactor(tx, { userId, factors, method, code, binding });
      },
    );

    if (outcome !== null) {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.mfaChallenge,
        outcome: 'failed',
        reason: outcome,
      });
      // A dead challenge is answered like a lockout: waiting and signing in again is the fix.
      throw new AuthenticationRejectedError(
        outcome === 'locked_out' || outcome === 'mfa_challenge_dead'
          ? 'rate_limited'
          : 'invalid_credentials',
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
        // PA-06: disabled between the password step and this one (0247).
        if ((await this.sessions.findStanding(tx, userId))?.disabledAt) return 'account_disabled';
        const failures = await this.credentials.countRecentFailures(
          tx,
          userId,
          this.options.failureWindowSeconds,
        );
        if (
          failures >= this.options.maxFailuresInWindow &&
          !(await this.secondFactorGrantStillOpen(tx, userId, verified.claims))
        ) {
          return 'locked_out';
        }

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

  /**
   * N01 (wave 11). A reset sign-in grant that opened and names this account still counts only
   * while it belongs to the account's **latest** succeeded `password_set` row (a second reset or
   * a password change makes it stale) and while **no** sign-in has succeeded since that row (the
   * first one spends it). Both are reads of rows a guesser cannot write.
   */
  private async resetGrantStillOpen(
    db: IdentityQueryRunner,
    userId: string,
    grantPasswordSetAt: number,
  ): Promise<boolean> {
    const latest = await this.credentials.findLatestPasswordSetAt(db, userId);
    if (latest === null || latest.getTime() !== grantPasswordSetAt) return false;
    return !(await this.credentials.hasSucceededSignInSince(db, userId, latest));
  }

  /**
   * N01 (wave 12). Whether a challenge minted through a reset sign-in grant may still pass a full
   * window at the code step. Only a challenge that names the grant's reset qualifies (one minted
   * without the grant never does), and only while that reset is the account's latest succeeded
   * `password_set` row, no second factor has succeeded since it (the first success spends it), and
   * fewer second-factor failures than the window allows have been recorded since it - so the grant
   * cannot become an unmetered code oracle. Every row read here needs the challenge to write: a
   * guesser without the password and the grant cannot move any of these counts.
   */
  private async secondFactorGrantStillOpen(
    db: IdentityQueryRunner,
    userId: string,
    claims: ChallengeClaims,
  ): Promise<boolean> {
    const grantAt = claims.resetGrantPasswordSetAt;
    if (grantAt === undefined || claims.userId !== userId) return false;
    const latest = await this.credentials.findLatestPasswordSetAt(db, userId);
    if (latest === null || latest.getTime() !== grantAt) return false;
    const attempts = await this.credentials.countSecondFactorAttemptsSince(db, userId, latest);
    return attempts.succeeded === 0 && attempts.failed < this.options.maxFailuresInWindow;
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

    // Verify first, then decide (C-1, F20) — the same ordering and the same decision as
    // `signInWithPassword`: a full window refuses right and wrong passwords alike, so re-auth is
    // not an unmetered guessing oracle. The holder's way out of a full window is a password reset
    // by email, after which this count starts again from zero (N01).
    const correct = await verifyPassword(
      found.stored?.passwordHash ?? DUMMY_PASSWORD_HASH,
      password,
    );
    const decision = decideVerifyFirst({
      passwordCorrect: Boolean(found.stored) && correct,
      failuresInWindow: found.failures,
      maxFailuresInWindow: this.options.maxFailuresInWindow,
      // A reset sign-in grant opens only the sign-in route; re-authentication never takes one.
      resetGrantValid: false,
    });

    if (decision !== 'admit') {
      const reason: AuthenticationReason =
        decision === 'locked_out'
          ? 'locked_out'
          : !found.stored
            ? 'no_password_set'
            : 'bad_password';
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.reauthentication,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError(
        decision === 'locked_out' ? 'rate_limited' : 'invalid_credentials',
        reason,
      );
    }

    const outcome = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<AuthenticationReason | null> => {
        // MFAOPTIONS. Only an authenticator code is asked for here. A person whose only methods
        // are e-mail codes (and backup codes) re-authenticates with the password alone: the
        // session already passed their second step, and mailing a code for every change would
        // let a session holder spend the send budget the sign-in relies on.
        const factors = (await this.credentials.listActiveFactors(tx, userId)).filter(
          (factor) => factor.kind === TOTP_FACTOR_KIND,
        );
        if (factors.length === 0) return null;
        // F32 (wave 9): the code step gets the same durable lockout as `completeMfaChallenge`,
        // read before the code is spent. Without it a session holder who knew the password
        // could grind six-digit codes here bounded only by the in-process source budgets.
        const failures = await this.credentials.countRecentFailures(
          tx,
          userId,
          this.options.failureWindowSeconds,
        );
        if (failures >= this.options.maxFailuresInWindow) return 'locked_out';
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
      throw new AuthenticationRejectedError(
        outcome === 'locked_out' ? 'rate_limited' : 'invalid_credentials',
        outcome,
      );
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
   * `D05`: *replacing* a password needs fresh proof (the reauth token). Whether a row already
   * exists is read before the new value is hashed. A person with no password has none to
   * re-present, so F01 (wave 9) asks for the other proof they do have: a sign-in no older than
   * {@link FIRST_PASSWORD_FRESH_SIGN_IN_SECONDS} on this very session. Once a password exists,
   * it is the proof.
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
    const { existing, holder } = await this.database.identityRead(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (db) => ({
        existing: await this.credentials.findPassword(db, input.userId),
        holder: await this.credentials.findPasswordIdentifiers(db, input.userId),
      }),
    );
    if (existing !== null) {
      await this.requireReauth({
        userId: input.userId,
        sessionId: input.sessionId,
        reauthToken: input.reauthToken,
        action: AUTHENTICATION_ACTIONS.passwordSet,
        context: input.context,
      });
    } else {
      await this.requireFreshSignIn(input);
    }

    const screened = await screenPassword({
      password: input.password,
      // ACCOUNT item 4: the sign-up rules, identifiers included — a change from the profile was
      // screened without them, so a password made of the person's own name passed here only.
      identifiers: input.identifiers ?? [
        holder?.email.split('@')[0] ?? '',
        holder?.displayName ?? '',
      ],
      ...(this.options.breachedPasswordScreen
        ? { remoteScreen: this.options.breachedPasswordScreen }
        : {}),
    });

    if (screened.rejections.length > 0) {
      throw new PasswordRejectedError(screened.rejections, screened.remoteScreenUnavailable);
    }

    const hash = await hashPassword(input.password);
    const replacing = existing !== null;

    // F19 (wave 9): a replacement also ends every personal access token and AI app grant the
    // person holds - before the identity transaction (a failure refuses the change whole) and
    // again after it (closing the window in which a session about to be revoked could mint one).
    if (replacing) await this.cutBearerCredentials(input.userId, input.context.correlationId);

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
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.passwordSet,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
      },
    );
    if (replacing) await this.cutBearerCredentials(input.userId, input.context.correlationId);
  }

  /**
   * F01 (wave 9). The proof a **first** password needs. Before, a first password needed none -
   * any live principal could attach one, including a personal access token (no cookie, no
   * session row) and a stolen cookie session long after its sign-in. Now only a session row of
   * this user, still live, created no more than {@link FIRST_PASSWORD_FRESH_SIGN_IN_SECONDS} ago
   * by the database clock, counts: a Google-created account has just signed in with Google. The
   * refusal row uses `reauth_required`, which `countRecentFailures` never counts.
   */
  private async requireFreshSignIn(input: {
    userId: string;
    sessionId: string;
    context: SignInContext;
  }): Promise<void> {
    const fresh = await this.database.identityRead(
      { correlationId: input.context.correlationId, tables: ['sessions'] },
      (db) =>
        this.sessions.isEstablishedWithin(db, {
          sessionId: input.sessionId,
          userId: input.userId,
          maxAgeSeconds: FIRST_PASSWORD_FRESH_SIGN_IN_SECONDS,
        }),
    );
    if (fresh) return;
    await this.record(input.context, {
      userId: input.userId,
      action: AUTHENTICATION_ACTIONS.passwordSet,
      outcome: 'failed',
      reason: 'reauth_required',
    });
    throw new FreshSignInRequiredError();
  }

  /** F19 (wave 9). See `bearer-credentials.ts` for why this runs outside the identity transaction. */
  private async cutBearerCredentials(userId: string, correlationId: string): Promise<void> {
    await this.bearerCutoff.revokeAllForUser(this.database, { userId, correlationId });
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
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.factorEnrolled,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        // `D05d`. Two rows for one confirmation, because two different things happened and
        // the owner needs to be able to find out about the second one by name. The line above
        // records the enrolment; this one records that the recovery codes the person wrote
        // down at their last enrolment stopped working at this instant. Without it, the one
        // question `D05c`'s attack makes urgent — "when were my recovery codes last
        // replaced?" — is answered by the route that did the replacing with silence, because
        // `regenerateRecoveryCodes` was the only writer of `recovery_codes_issued` and this is
        // the other one. Same transaction as the `replaceRecoveryCodes` above it, so the
        // record and the destruction it describes cannot come apart — and, since `D05d`'s
        // second half, the notice too: this is the one route the attack takes, so it is the
        // one route where the owner's mail must not depend on anybody remembering.
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
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
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
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

        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.factorDisabled,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return true;
      },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Session revocation — I-1
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `I-1`. End one of this person's sessions, named by id — a device from the list, or the one
   * making the request.
   *
   * Behind fresh proof (`requireReauth`), checked **before** the ownership lookup exactly as
   * `disableFactor` is: a stolen access cookie must not be enough to evict the legitimate
   * holder's devices, and a missing token refuses the same whether or not the id names a real
   * session. Ownership is then checked inside the transaction that revokes, so the read and
   * the write see one consistent row; a session that is not this person's — or does not exist
   * — is answered the same way (`false` ⇒ 404), so the route cannot be used to probe session
   * ids.
   *
   * Revoking the session row ends its refresh credential with it, and nothing has to be done
   * to the tokens separately — the same reason `D06` gives for the password-change cutoff.
   * `SessionService.refresh` refuses a revoked session before it rotates, and `authenticate`
   * re-reads the row on every request, so the stateless access token dies with the same
   * revoke rather than living out its window.
   *
   * @returns `false` when nothing was revoked: the id is not this person's, does not exist, or
   * the session was already ended (a second click, or a concurrent password change).
   */
  async revokeSession(input: {
    userId: string;
    sessionId: string;
    targetSessionId: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<boolean> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.sessionRevoked,
      context: input.context,
    });

    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES, 'sessions'] },
      async (tx) => {
        const target = await this.sessions.findById(tx, input.targetSessionId);
        // One answer for someone else's session and for one that does not exist.
        if (!target || target.session.userId !== input.userId) return false;

        const revoked = await this.sessions.revoke(
          tx,
          input.targetSessionId,
          USER_SESSION_REVOCATION_REASON,
        );
        // Idempotent: an already-revoked session records nothing a second time.
        if (!revoked) return false;

        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.sessionRevoked,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return true;
      },
    );
  }

  /**
   * `I-1`. End every *other* live session this person holds, keeping the one that just proved
   * itself — `22-SCREEN-BY-SCREEN` §3's "revoke all", and the lever a locked-out or
   * compromised holder needs when a stolen refresh cookie is being rotated against them.
   *
   * The same statement `D06` uses when a password is replaced (`revokeOthersForUser`), reached
   * here on purpose rather than as the side effect of changing a credential, and behind the
   * same fresh proof. The kept session is the one carrying that proof — the device the person
   * is holding. Refresh credentials end with each session row, so nothing is done to them
   * separately.
   *
   * @returns how many other sessions were ended; `0` is a legitimate outcome (there were none)
   * and is still recorded, because pressing the lever is itself worth a row in the log.
   */
  async revokeOtherSessions(input: {
    userId: string;
    sessionId: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<number> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.sessionRevoked,
      context: input.context,
    });

    // F19 (wave 9): "sign out other sessions" also ends every personal access token and AI app
    // grant - before and after the session cutoff, for the reason `setPassword` gives.
    await this.cutBearerCredentials(input.userId, input.context.correlationId);
    const ended = await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES, 'sessions'] },
      async (tx) => {
        const count = await this.sessions.revokeOthersForUser(
          tx,
          input.userId,
          input.sessionId,
          USER_SESSION_REVOCATION_REASON,
        );

        await this.credentials.recordAuthenticationEvent(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.sessionRevoked,
          outcome: 'succeeded',
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return count;
      },
    );
    await this.cutBearerCredentials(input.userId, input.context.correlationId);
    return ended;
  }

  /** The factors a person holds, for the security screen. No secrets, ever. */
  async listFactors(input: { userId: string; correlationId: string }): Promise<
    readonly {
      id: string;
      kind: string;
      label: string;
      confirmedAt: Date | null;
      isDefault: boolean;
    }[]
  > {
    const rows = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.listAllFactors(db, input.userId),
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      confirmedAt: row.confirmedAt,
      isDefault: row.isDefault,
    }));
  }

  /**
   * MFAOPTIONS. The address an e-mail code would go to, masked, and whether it was ever proved —
   * what the security screen needs to offer (or explain why it cannot offer) the e-mail method.
   */
  async describeMailContact(input: {
    userId: string;
    correlationId: string;
  }): Promise<{ address: string; verified: boolean }> {
    const contact = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (db) => this.credentials.findMailContact(db, input.userId),
    );
    return {
      address: contact === null ? '' : maskEmailAddress(contact.email),
      verified: contact?.emailVerifiedAt != null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MFAOPTIONS — the e-mail code method and the default method
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mail a code that finishes this sign-in challenge. Reachable only with a valid challenge token
   * (the password was right), so the answer discloses nothing an outsider could not already know.
   * The person must hold a confirmed e-mail method: the server decides, never the client.
   *
   * Limits: 30 s between sends and five an hour per person and per source
   * ({@link EmailCodeSendBudget}); a dead challenge (five wrong codes) takes no new code. A
   * refused send writes nothing and charges nothing.
   */
  async sendSignInEmailCode(input: {
    challengeToken: string | undefined;
    context: SignInContext;
  }): Promise<EmailCodeSentView> {
    const { challengeToken, context } = input;
    const verified = verifyChallengeToken(challengeToken, this.options.sessionSecret, this.now());
    if (!verified.ok || challengeToken === undefined) {
      const reason: AuthenticationReason =
        !verified.ok && verified.rejection === 'expired'
          ? 'challenge_expired'
          : 'challenge_invalid';
      await this.record(context, {
        userId: null,
        action: AUTHENTICATION_ACTIONS.mfaChallenge,
        outcome: 'failed',
        reason,
      });
      throw new AuthenticationRejectedError('invalid_credentials', reason);
    }
    const userId = verified.claims.userId;
    const binding = emailCodeBinding('sign_in', challengeToken);

    const found = await this.database.identityRead(
      { correlationId: context.correlationId, tables: [...IDENTITY_TABLES] },
      async (db): Promise<{ factorId: string; contact: MailContact } | AuthenticationReason> => {
        if ((await this.sessions.findStanding(db, userId))?.disabledAt) return 'account_disabled';
        if (await this.emailCodeStore.isExhausted(db, binding)) return 'mfa_challenge_dead';
        const factor = (await this.credentials.listActiveFactors(db, userId)).find(
          (row) => row.kind === EMAIL_FACTOR_KIND,
        );
        const contact = await this.credentials.findMailContact(db, userId);
        if (!factor || !contact) return 'mfa_no_factor';
        return { factorId: factor.id, contact };
      },
    );
    if (typeof found === 'string') {
      await this.record(context, {
        userId,
        action: AUTHENTICATION_ACTIONS.mfaChallenge,
        outcome: 'failed',
        reason: found,
      });
      throw new AuthenticationRejectedError('invalid_credentials', found);
    }

    return this.mailCode({
      userId,
      factorId: found.factorId,
      purpose: 'sign_in',
      binding,
      contact: found.contact,
      context,
    });
  }

  /**
   * Begin turning the e-mail method on: behind fresh proof (`D05`), only for a verified address,
   * and only once (a second call while it is pending re-sends to the same pending row). The method
   * authorises nothing until {@link confirmEmailFactor} has seen the mailed code.
   */
  async beginEmailFactor(input: {
    userId: string;
    sessionId: string;
    reauthToken?: string | undefined;
    context: SignInContext;
  }): Promise<EmailFactorStartedView> {
    await this.requireReauth({
      userId: input.userId,
      sessionId: input.sessionId,
      reauthToken: input.reauthToken,
      action: AUTHENTICATION_ACTIONS.factorEnrolled,
      context: input.context,
    });
    if (!this.options.emailCodes?.mailer.enabled) {
      throw new EmailFactorUnavailableError('mail_unavailable');
    }

    const prepared = await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        const contact = await this.credentials.findMailContact(tx, input.userId);
        if (contact === null || contact.emailVerifiedAt === null) {
          return 'email_not_verified' as const;
        }
        const active = await this.credentials.listActiveFactors(tx, input.userId);
        if (active.some((factor) => factor.kind === EMAIL_FACTOR_KIND)) {
          return 'already_enabled' as const;
        }
        const pending = await this.credentials.findPendingEmailFactor(tx, input.userId);
        const factorId =
          pending?.id ??
          (await this.credentials.createEmailFactor(tx, {
            userId: input.userId,
            label: 'E-mail',
          }));
        return { factorId, contact };
      },
    );
    if (typeof prepared === 'string') throw new EmailFactorUnavailableError(prepared);

    const sent = await this.mailCode({
      userId: input.userId,
      factorId: prepared.factorId,
      purpose: 'enrol',
      binding: emailCodeBinding('enrol', `${input.sessionId}.${prepared.factorId}`),
      contact: prepared.contact,
      context: input.context,
    });
    return { factorId: prepared.factorId, ...sent };
  }

  /**
   * Finish turning the e-mail method on with the mailed code. Same gate and same records as
   * {@link confirmTotpFactor}: the enrolment is a credential change with its notice, in one
   * transaction. Backup codes are issued only when the person has none left; an existing set is
   * kept (the list returned is then empty, and the screen says the old codes still work).
   */
  async confirmEmailFactor(input: {
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
    const binding = emailCodeBinding('enrol', `${input.sessionId}.${input.factorId}`);

    const outcome = await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx): Promise<{ issued: boolean } | null> => {
        const factor = await this.credentials.findFactor(tx, input.factorId);
        // Ownership, kind and state. One answer for someone else's id and for a wrong code.
        if (
          !factor ||
          factor.userId !== input.userId ||
          factor.kind !== EMAIL_FACTOR_KIND ||
          factor.disabledAt !== null ||
          factor.confirmedAt !== null
        ) {
          return null;
        }
        if ((await this.spendEmailCode(tx, binding, input.code)) !== null) return null;
        if (!(await this.credentials.confirmCodelessFactor(tx, factor.id))) return null;

        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.factorEnrolled,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        const usable = await this.credentials.listUsableRecoveryCodes(tx, input.userId);
        if (usable.length > 0) return { issued: false };
        await this.credentials.replaceRecoveryCodes(tx, input.userId, generated.hashes);
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return { issued: true };
      },
    );

    if (outcome === null) {
      await this.record(input.context, {
        userId: input.userId,
        action: AUTHENTICATION_ACTIONS.factorEnrolled,
        outcome: 'failed',
        reason: 'mfa_bad_code',
      });
      throw new AuthenticationRejectedError('invalid_credentials', 'mfa_bad_code');
    }
    return { recoveryCodes: outcome.issued ? generated.codes : [] };
  }

  /**
   * Choose the method a sign-in asks for first. Behind fresh proof, recorded as a credential
   * change with its notice. `false` (404) for an id that is not one of the person's live,
   * confirmed factors.
   */
  async setDefaultFactor(input: {
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
      action: AUTHENTICATION_ACTIONS.mfaDefaultChanged,
      context: input.context,
    });

    return this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      async (tx) => {
        const changed = await this.credentials.setDefaultFactor(tx, input.userId, input.factorId);
        if (!changed) return false;
        await this.credentials.recordCredentialChange(tx, {
          userId: input.userId,
          action: AUTHENTICATION_ACTIONS.mfaDefaultChanged,
          correlationId: input.context.correlationId,
          ip: input.context.ip ?? null,
          userAgent: input.context.userAgent ?? null,
        });
        return true;
      },
    );
  }

  /**
   * Charge the send budget, store the code's hash bound to `binding`, and mail it. The budget is
   * charged only once everything else said yes; a refusal stores and sends nothing.
   */
  private async mailCode(input: {
    userId: string;
    factorId: string;
    purpose: EmailCodePurpose;
    binding: string;
    contact: MailContact;
    context: SignInContext;
  }): Promise<EmailCodeSentView> {
    const emailCodes = this.options.emailCodes;
    if (!emailCodes?.mailer.enabled) throw new EmailFactorUnavailableError('mail_unavailable');

    const verdict = emailCodes.budget.admit({ userId: input.userId, ip: input.context.ip });
    if (verdict !== 'admitted') {
      throw new AuthenticationRejectedError(
        'rate_limited',
        verdict === 'too_soon' ? 'mfa_email_too_soon' : 'mfa_email_over_budget',
      );
    }

    const code = generateEmailCode();
    await this.database.identityTransaction(
      { correlationId: input.context.correlationId, tables: [...IDENTITY_TABLES] },
      (tx) =>
        this.emailCodeStore.create(tx, {
          userId: input.userId,
          factorId: input.factorId,
          purpose: input.purpose,
          bindingHash: input.binding,
          codeHash: hashEmailCode(code, input.binding, this.options.sessionSecret),
        }),
    );
    // Outside the transaction: a slow mail server must not hold a pooled connection. A failed
    // send is not retried here; the person asks again after the 30-second pause.
    await emailCodes.mailer.deliver({
      to: input.contact.email,
      displayName: input.contact.displayName,
      code,
      purpose: input.purpose,
      ttlMinutes: EMAIL_CODE_TTL_SECONDS / 60,
      locale: input.contact.locale,
    });
    return {
      sentTo: maskEmailAddress(input.contact.email),
      resendAfterSeconds: EMAIL_CODE_RESEND_GAP_MS / 1000,
      expiresInSeconds: EMAIL_CODE_TTL_SECONDS,
    };
  }

  /**
   * The second-factor seam: one place decides which of the person's **enabled** methods a code
   * is checked against. The method is the caller's choice only among what the database lists;
   * a method the person does not hold is `mfa_no_factor`, never a pass.
   */
  private async verifySecondFactor(
    tx: IdentityQueryRunner,
    input: {
      userId: string;
      factors: readonly {
        id: string;
        kind: string;
        secret: string;
        lastAcceptedCounter: number | null;
      }[];
      method: SecondFactorMethod;
      code: string;
      binding: string;
    },
  ): Promise<AuthenticationReason | null> {
    if (input.method === 'email') {
      const holdsEmail = input.factors.some((factor) => factor.kind === EMAIL_FACTOR_KIND);
      return holdsEmail ? this.spendEmailCode(tx, input.binding, input.code) : 'mfa_no_factor';
    }
    const totp = input.factors.filter((factor) => factor.kind === TOTP_FACTOR_KIND);
    return totp.length === 0 ? 'mfa_no_factor' : this.spendTotpCode(tx, totp, input.code);
  }

  /**
   * Check a mailed code against the one open code of its binding, in constant time, and spend
   * it. A wrong code counts one attempt; the fifth kills the binding.
   */
  private async spendEmailCode(
    tx: IdentityQueryRunner,
    binding: string,
    code: string,
  ): Promise<AuthenticationReason | null> {
    const open = await this.emailCodeStore.findOpen(tx, binding);
    if (open === null) return 'mfa_bad_code';
    if (!emailCodeMatches(open.codeHash, code, binding, this.options.sessionSecret)) {
      const counted = await this.emailCodeStore.recordWrongAttempt(tx, open);
      return counted === 'dead' ? 'mfa_challenge_dead' : 'mfa_bad_code';
    }
    return (await this.emailCodeStore.spend(tx, open.id)) ? null : 'mfa_replayed';
  }

  /**
   * `D05d`. What has been done to this person's credentials, newest first — `ID-05`'s
   * "security event receipt".
   *
   * This is the whole of the answer to the gap: the record was always written, in the same
   * transaction as the change, and nothing could read it. An owner whose recovery codes were
   * replaced by somebody holding their session learned about it when their own codes stopped
   * working; now the date is on their own security screen.
   *
   * ## Not behind fresh proof, deliberately
   *
   * Every *change* on this surface is behind `D05`'s re-authentication. This read is not, and
   * the asymmetry is the point: it is what a worried person opens, and a screen that demands
   * a password before it will say whether the password was changed is a screen that is harder
   * to reach than the attack it reports. It also gives away nothing an attacker holding the
   * session does not have — the actions it lists are ones they performed.
   *
   * ## What it hands back
   *
   * The action and the time, and nothing else. Not `reason`, which migration 0004 forbids
   * returning. Not `ip` or `user_agent`, and that omission is a judgement rather than an
   * oversight: this read is reachable from any live session, including the stolen one `D05`
   * exists to bound, and the addresses and devices the *owner* signs in from are not
   * something to hand that holder. What raises the alarm is "your recovery codes were
   * replaced on the 12th" when the owner did no such thing; the address is not needed to
   * raise it, and an operator investigating afterwards reads the table.
   */
  async listCredentialChanges(input: {
    userId: string;
    correlationId: string;
  }): Promise<readonly CredentialChange[]> {
    const rows = await this.database.identityRead(
      { correlationId: input.correlationId, tables: [...IDENTITY_TABLES] },
      (db) =>
        this.credentials.listCredentialChanges(
          db,
          input.userId,
          CREDENTIAL_CHANGE_ACTIONS,
          CREDENTIAL_CHANGE_LIMIT,
        ),
    );

    return rows.map((row) => ({
      id: row.id,
      // The read asked for exactly this closed list, so the column cannot hold anything else.
      action: row.action as AuthenticationAction,
      occurredAt: row.occurredAt,
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
        // A database error here can carry the DSN, so it is redacted through the OBS-001 seam.
        serializeForLog(error),
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
          automationScore: context.automation?.score ?? null,
          automationReasons: context.automation?.reasons ?? null,
          clientHints: context.automation?.clientHints ?? null,
        }),
    );
  }
}

/**
 * R18-e (56-25). The refusal a person gets when their organization's sign-in policy does not allow
 * the method they used: 403 `method_not_allowed`, the details naming the allowed methods and the
 * organization (`use`, `organization`). Given only after the credential was proved.
 */
export function signInMethodNotAllowed(refusal: {
  readonly use: readonly string[];
  readonly organization: string;
}): ApiError {
  return new ApiError(
    403,
    'method_not_allowed',
    'Your company does not allow this way of signing in.',
    [
      { field: 'use', message: refusal.use.join(',') },
      { field: 'organization', message: refusal.organization },
    ],
    'sign_in_policy:method_not_allowed',
  );
}
