import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  authenticationEvents,
  credentialChangeNotices,
  userMfaFactors,
  userPasswords,
  userRecoveryCodes,
  users,
} from '../../common/database/schema.js';
import type {
  UserMfaFactorRow,
  UserPasswordRow,
  UserRecoveryCodeRow,
} from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { SIGN_IN_ABUSE_REASONS } from './sign-in-abuse-control.js';
import { orderedUuidv7 } from './ordered-id.js';
import { SeedCipherError } from './seed-cipher.js';
import type { SeedCipher } from './seed-cipher.js';

/**
 * Credential storage — ID-002's persistence half.
 *
 * Every method takes an {@link IdentityQueryRunner}, exactly as `SessionsRepository` does and
 * for the same reason: authentication runs before `25-AUTHORIZATION-AND-TENANT-ISOLATION`
 * §3's step 2 has decided which organization the request is about, so there is no tenant
 * predicate to apply. What replaces it is that this path can reach no tenant table at all.
 *
 * ## The database owns the clock, again
 *
 * Every timestamp written here is `current_timestamp(3)` and every comparison is `now(3)`,
 * evaluated by the server. The reason is the one `SessionsRepository` gives: two API
 * instances with skewed clocks must not disagree about whether a lockout window has passed,
 * and on the side that matters that disagreement appears as a lockout that is not enforced.
 *
 * ## No plaintext leaves or enters this file
 *
 * Passwords arrive already hashed by `password.ts`; recovery codes arrive already hashed by
 * `recovery-codes.ts`. A TOTP secret is the one credential stored recoverably, because the
 * algorithm needs it back — see the note on the column in migration 0004.
 *
 * ## The seed is encrypted here and nowhere else — D07 (2026-09-06)
 *
 * "Recoverably" used to mean the base32 seed went into the column exactly as the
 * authenticator produced it, so a dump or a backup disclosed every second factor. It now
 * means an `mfa1.` envelope from {@link SeedCipher}, and this class is the boundary: every
 * write encrypts, every read that hands a secret upward decrypts, and the service, `totp.ts`
 * and the controller above continue to see the base32 seed they always saw. One boundary
 * rather than a call at each use site, because the property that
 * matters — nothing above this line ever holds ciphertext, nothing below it ever holds a
 * seed — is only checkable if there is one line.
 *
 * A value that will not open is not swallowed. A `SeedCipherError` propagates out of the
 * read, and every caller here already fails closed on a repository error, so a tampered row
 * or a leftover plaintext one refuses a sign-in rather than quietly permitting it. The one
 * refinement is {@link CredentialsRepository.listActiveFactors}, which refuses when *no* row
 * of a person's factors opens rather than when the first one does not — the same closed door
 * for the account whose only factor is broken, held open for the account that still has a
 * working one.
 *
 * Which is why only the reads that *hand a seed upward* select the column at all. A read
 * whose caller discards the secret does not decrypt it and does not select it — see
 * {@link CredentialsRepository.listAllFactors} and
 * {@link CredentialsRepository.findFactorIdentity}. Two reasons, and the second is the one
 * that shows up in an incident: a seed is never materialised in memory for a screen that
 * shows none, and a row that will not open — a legacy plaintext one before the backfill has
 * run, an unknown key version, a tampered envelope — still lists and can still be removed,
 * instead of turning the security screen and the "remove this factor" route into a 500 at
 * exactly the moment someone needs them.
 */

/**
 * A factor as the security screen sees it: what it displays, and nothing else.
 *
 * A distinct type rather than `Omit<UserMfaFactorRow, 'secret'>` because it is the shape of a
 * `SELECT`, not a row with a field hidden — the seed is never fetched, so no later edit here
 * can accidentally start returning it.
 */
export type UserMfaFactorSummary = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly confirmedAt: Date | null;
};

/**
 * The four refusals `D05`'s gate writes when a credential-changing route is asked for without
 * fresh proof — `AuthenticationService.requireReauth`, and nowhere else.
 *
 * None of them is a credential guess, which is the only question this list asks:
 *
 * - `reauth_required` — no token was presented at all.
 * - `reauth_expired` — a token this server signed itself, correctly, whose TTL has passed.
 * - `reauth_wrong_session` — an authentic token whose claims name another session.
 * - `reauth_invalid` — malformed, or signed under another key. The only forgery of the four,
 *   and it is a forgery of an HMAC over `SESSION_SECRET`, not a guess at the low-entropy
 *   secret this counter exists to protect. A budget of five in 900 seconds is decisive
 *   against a human-chosen password or a six-digit code and meaningless against an HMAC, so
 *   the two do not belong in one.
 */
const REAUTH_FAILURE_REASONS = [
  'reauth_required',
  'reauth_invalid',
  'reauth_expired',
  'reauth_wrong_session',
] as const;

/**
 * The reasons a `failed` row can carry that are **not** a credential failure.
 *
 * {@link CredentialsRepository.countRecentFailures} excludes exactly these, and the header there
 * gives the argument for each. In one line: the three {@link SIGN_IN_ABUSE_REASONS} are refusals
 * written in front of the password check (N-2), and `locked_out` (A-1) and the four
 * {@link REAUTH_FAILURE_REASONS} (X2) are rows this counter's own gates write — a consequence
 * of the count, never an input to it.
 *
 * These strings are spelled here rather than imported because the union they belong to lives in
 * `authentication.service.ts`, which imports *this* file; they are asserted against the
 * service's behaviour by the database case that drives a real lockout, not by the type, and
 * against the union's own shape by `credentials.repository.test.ts`, which fails to compile if
 * a `reauth_*` reason is ever added without being weighed.
 */
export const NON_CREDENTIAL_FAILURE_REASONS = [
  ...SIGN_IN_ABUSE_REASONS,
  'locked_out',
  ...REAUTH_FAILURE_REASONS,
] as const;

/**
 * The widths of the two `authentication_events` columns a request header can reach.
 *
 * Both are from `migrations/0004_credentials.sql`: `ip VARCHAR(45)`, `user_agent
 * VARCHAR(255)`. They are spelled here rather than derived from the Drizzle schema because
 * the schema records a type, not a bound this file can read back at runtime.
 *
 * The database case in `test/id-002-credentials.db.test.ts` pins these numbers against the
 * real column, but in one direction only. It writes an over-long value and reads back exactly
 * this many characters, so narrowing either column below the number here breaks it — strict
 * mode turns the clamped value into `ER_DATA_TOO_LONG`. Widening a column does not break it,
 * because the clamp goes on cutting at the smaller number and the assertion goes on holding.
 * What is pinned is therefore "this constant has not grown past its column", which is the
 * direction that loses rows; a column that has grown past its constant only wastes width, and
 * nothing here would notice.
 *
 * 45 is the same number `sign-in-abuse-control.ts` clamps its in-memory source key to, and it
 * is that number for the same underlying reason — the width of this column, which is in turn
 * the exact length of an IPv4-mapped IPv6 literal. It is not the same operation: that file
 * cuts with `slice`, in UTF-16 units, so given an input carrying astral-plane characters the
 * two produce different strings, and its result can be shorter than 45 characters. That is
 * harmless there, because its output is a bucket key that never reaches a column and an
 * under-filled key is still a usable key, and it is why this file does not reuse it. What the
 * D08 follow-up recorded is closed on this side: the value that reaches the column is now
 * bounded before the insert. The wording in that file and in `docs/implementation-status.md`
 * still describes the state before this change and is corrected separately in this slice.
 */
const MAX_EVENT_IP_CHARACTERS = 45;
const MAX_EVENT_USER_AGENT_CHARACTERS = 255;

/**
 * Cut a header-derived value down to what its column will hold — in the unit the column
 * counts, which is not the unit JavaScript counts.
 *
 * ## Why clamp rather than reject
 *
 * Both values this is applied to arrive in request headers, and since `D09` both are
 * attacker-chosen in length: `User-Agent` always was, and behind a *configured* trusted proxy
 * `request.ip` is the last forwarded entry verbatim — `@fastify/proxy-addr` validates the
 * final element not at all. Under the strict mode this project runs, an over-long value is
 * `ER_DATA_TOO_LONG` and the whole `INSERT` fails. That insert is on the **failure** path of
 * sign-in, so the row destroyed is the one row that records a refused attempt: an enumeration
 * sweep could erase its own trace, one long header at a time, and turn each refusal into a
 * 500 while it did. A clamp keeps the row. Rejecting the value, or throwing a friendlier
 * error, keeps nothing — it loses the same row for a better-worded reason.
 *
 * Applied here, at the insert, rather than at each call site: there are a dozen callers on
 * three paths and the property wanted is "no value that reaches this table is over-long",
 * which is only checkable if there is one place it can be checked.
 *
 * ## Why code points and not `slice`
 *
 * These are `utf8mb4` columns, and MySQL counts `VARCHAR(n)` in *characters*
 * — one Unicode code point each, whether it encodes to one byte or four. JavaScript's
 * `String.prototype.slice` counts UTF-16 code units, which differs in two ways and only one
 * of them is harmless:
 *
 * - An astral-plane character (anything above U+FFFF) is two UTF-16 units and one MySQL
 *   character, so a `slice` under-fills the column. Merely wasteful.
 * - A `slice` can land **between** the two halves of a surrogate pair, and the half left
 *   behind is not a character at all. Nothing raises: mysql2 (3.23.3) maps this connection's
 *   `utf8mb4` charset to Node's `'utf8'` encoding and encodes every parameter with
 *   `Buffer.from(value, 'utf8')`, and Node substitutes U+FFFD for an unpaired surrogate
 *   before a byte leaves the process — `Buffer.from('\uD83D', 'utf8')` is `ef bf bd`. So the
 *   server is handed a perfectly valid string in which the character the slice cut has been
 *   replaced by `�`. That is the objection: this table records what arrived, and a clamp that
 *   is only allowed to *shorten* would instead be quietly rewriting a character. The value
 *   also comes out shorter than the bound, for the same reason as the case above.
 *
 * Iterating the string yields code points, never half of one, so the result is at most `max`
 * characters as the column counts them and every character in it is one that arrived. Two
 * things it deliberately does not do: it does not keep grapheme clusters whole (cutting a ZWJ
 * sequence yields a shorter, still valid string, and this is a log of what arrived rather
 * than text anyone reads), and it does not repair a lone surrogate that was already in the
 * input. The driver will render that one U+FFFD too, but it does so to a value the client
 * sent; a clamp asked to shorten a string has no business introducing a second substitution
 * of its own, and that is the silent normalisation this log must not do.
 *
 * The substitution is not taken on trust: a case in `test/id-002-credentials.db.test.ts`
 * sends a UTF-16-sliced value through this very insert to the real server and reads the
 * U+FFFD back out of the column.
 *
 * A value inside the bound is returned as it arrived, identically — no trimming, no case
 * folding, no validation of address shape. The `length` guard is the fast path and it is
 * exact in the direction that matters: a string's UTF-16 length is never *less* than its code
 * point count, so anything that passes it is certainly within the bound.
 *
 * Exported for its unit cases in `credentials.repository.test.ts`; nothing else calls it.
 */
export function clampToColumnCharacters(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.length <= max) {
    return value;
  }
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, max).join('');
}

/**
 * N01 (wave 10). The credential change that restarts the lockout count in
 * {@link CredentialsRepository.countRecentFailures}: a password set by reset or by change.
 */
const PASSWORD_SET_ACTION = 'password_set';

/**
 * N01 (wave 11). Every action whose `succeeded` row means "this person signed in": the password
 * step (also when it led to an MFA challenge), the code step, the recovery-code fallback and
 * Google. Spelled here for the cycle reason above (`AUTHENTICATION_ACTIONS` in
 * `authentication.service.ts`, `GOOGLE_SIGN_IN_ACTION` in `google-auth.service.ts`).
 */
const SIGN_IN_ACTIONS: readonly string[] = [
  'password_sign_in',
  'mfa_challenge',
  'recovery_code',
  'google_sign_in',
];

/**
 * The four actions that mean a credential *changed* — `D05d`, I1.
 *
 * Spelled here rather than imported from `authentication.service.ts` for the reason
 * {@link NON_CREDENTIAL_FAILURE_REASONS} is: the vocabulary's home is that file, and that file
 * imports this one, so importing it back would be a cycle. `authentication.service.ts` exports
 * `CREDENTIAL_CHANGE_ACTIONS` as the caller-facing list, and a unit case in
 * `authentication.credential-change-record.test.ts` asserts the two are identical set-for-set,
 * so this copy cannot drift from it unnoticed.
 *
 * It is used by {@link CredentialsRepository.recordAuthenticationEvent} to refuse a *succeeded*
 * row for any of these actions. Such a row is itself a credential change, and one written this
 * way would carry no notice — the exact shape `D05d` exists to forbid. The only writer of a
 * succeeded credential-change row is {@link CredentialsRepository.recordCredentialChange}, which
 * writes the log row and the notice together.
 */
const CREDENTIAL_CHANGE_ACTIONS: readonly string[] = [
  PASSWORD_SET_ACTION,
  'mfa_factor_enrolled',
  'mfa_factor_disabled',
  'recovery_codes_issued',
];

/**
 * Thrown when a *succeeded* credential-change row is asked of
 * {@link CredentialsRepository.recordAuthenticationEvent} directly — `D05d`, I1.
 *
 * The atomicity of "a change is recorded and its owner is notified" was a convention: every
 * caller happened to reach for {@link CredentialsRepository.recordCredentialChange}. A
 * convention is the shape that caused the incident this slice is about, so the guard turns it
 * into a construction — the write that records a credential change with no notice beside it is
 * not a write this repository will perform.
 */
export class CredentialChangeNoticeRequiredError extends Error {
  constructor(action: string) {
    super(
      `a succeeded '${action}' is a credential change and must be recorded through ` +
        `recordCredentialChange, so the owner's notice is written in the same unit of work`,
    );
    this.name = 'CredentialChangeNoticeRequiredError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Passwords
// ─────────────────────────────────────────────────────────────────────────────

export class CredentialsRepository {
  /**
   * The cipher is injected rather than built here, and it has no default.
   *
   * A default would have to invent a keyring, and the only keyring this file could invent
   * is one that is not the deployment's — which would encrypt seeds under a key nobody
   * keeps, and open none of the rows already stored. Constructing this class therefore
   * requires having decided where the key comes from; `identity.module.ts` decides.
   */
  constructor(private readonly seeds: SeedCipher) {}

  /** The password row for a user, or `null` when they have never set one. */
  async findPassword(runner: IdentityQueryRunner, userId: string): Promise<UserPasswordRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userPasswords)
      .where(eq(userPasswords.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Set or replace a password.
   *
   * An upsert rather than a read-then-branch, because the read-then-branch has a race: two
   * concurrent "set your password" requests both see no row and both insert, and one gets a
   * duplicate-key error at a moment when the caller has already been told it worked.
   * `set_at` moves on every write — it records when *this* password was chosen, not when the
   * person first had one.
   */
  async setPassword(
    runner: IdentityQueryRunner,
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userPasswords)
      .values({
        userId,
        passwordHash,
        setAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          passwordHash,
          setAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  /**
   * Replace the stored hash **only if it is still the one the caller verified against**.
   *
   * This is the re-hash path, and the predicate is what makes it safe to run outside the
   * transaction that verified the password. Between the verify and the re-hash the person
   * may have changed their password in another tab; without the compare-and-swap, this write
   * would silently reinstate the old one at the new cost parameters.
   *
   * Returns `false` when it did not apply, which is not an error — it means someone else got
   * there first, and their write is the one that should stand.
   */
  async rehashPassword(
    runner: IdentityQueryRunner,
    userId: string,
    expectedHash: string,
    nextHash: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userPasswords)
      .set({ passwordHash: nextHash, updatedAt: sql`current_timestamp(3)` })
      .where(and(eq(userPasswords.userId, userId), eq(userPasswords.passwordHash, expectedHash)));
    return result[0].affectedRows > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Second factors
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The factors that currently authorise anything: confirmed and not disabled.
   *
   * Unconfirmed factors are excluded deliberately. Whether MFA is *required* for a person is
   * decided by whether this list is empty, and counting a half-finished enrolment would lock
   * someone out of their own account because they opened the setup screen and closed the tab.
   *
   * ## One unopenable row must not cost a person their working one — D07 review
   *
   * Opening every row eagerly meant the first `SeedCipherError` in the list propagated, so
   * somebody holding a phone *and* a tablet was refused sign-in because the tablet's row was
   * left in plaintext by a backfill nobody ran. The rows that open are therefore collected
   * and the rest set aside.
   *
   * Set aside, not skipped. If rows existed and *none* opened, the first refusal is rethrown,
   * because silently returning an empty list would say "this person has no second factor" and
   * anyone able to write one column could then corrupt the only factor and reduce the account
   * to password-only. That is a live MFA bypass, and it is worse than the lockout. Failing
   * closed when nothing opens, and only then, keeps both properties: MFA is still demanded
   * whenever a factor exists, and a second working factor still signs the person in.
   *
   * Nothing is logged from here: this class holds no logger (it takes a query runner per call
   * and nothing else), and reaching for `console` inside the identity path would put factor
   * ids into a stream nobody has decided the retention of. The diagnostic that names these
   * rows is `pnpm --filter @tmanage/api mfa:seeds-status`, which reports them by id and
   * reason — see `docs/runbooks/deploy.md`.
   */
  async listActiveFactors(
    runner: IdentityQueryRunner,
    userId: string,
  ): Promise<readonly UserMfaFactorRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userMfaFactors)
      .where(
        and(
          eq(userMfaFactors.userId, userId),
          isNull(userMfaFactors.disabledAt),
          sql`${userMfaFactors.confirmedAt} is not null`,
        ),
      )
      .orderBy(desc(userMfaFactors.createdAt));

    const opened: UserMfaFactorRow[] = [];
    let firstRefusal: SeedCipherError | undefined;
    for (const row of rows) {
      try {
        opened.push(this.open(row));
      } catch (error) {
        // Only a refusal by the cipher is a set-aside row. Anything else is a fault in this
        // process rather than in the column, and swallowing it would hide it.
        if (!(error instanceof SeedCipherError)) throw error;
        firstRefusal ??= error;
      }
    }
    if (opened.length === 0 && firstRefusal !== undefined) throw firstRefusal;
    return opened;
  }

  /**
   * Every factor a person holds, confirmed or not, for the security screen.
   *
   * The four columns the screen displays, and not `secret`. The caller
   * (`authentication.service.ts`'s `listFactors`, "No secrets, ever") discards the seed, so
   * selecting it would only mean decrypting every one of a person's seeds to throw them
   * away — and making one unopenable row take the whole screen down with it. The narrower
   * return type is the point: the field is not there to be leaked or to fail.
   */
  async listAllFactors(
    runner: IdentityQueryRunner,
    userId: string,
  ): Promise<readonly UserMfaFactorSummary[]> {
    return tenantDrizzle(runner)
      .select({
        id: userMfaFactors.id,
        kind: userMfaFactors.kind,
        label: userMfaFactors.label,
        confirmedAt: userMfaFactors.confirmedAt,
      })
      .from(userMfaFactors)
      .where(and(eq(userMfaFactors.userId, userId), isNull(userMfaFactors.disabledAt)))
      .orderBy(desc(userMfaFactors.createdAt));
  }

  /**
   * Who owns a factor, for callers that act on the row without reading it.
   *
   * `disableFactor` needs the ownership check and nothing else; going through
   * {@link findFactor} for it would decrypt a seed it never looks at, and would refuse to
   * remove precisely the broken factor a person is trying to remove.
   */
  async findFactorIdentity(
    runner: IdentityQueryRunner,
    factorId: string,
  ): Promise<{ readonly id: string; readonly userId: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: userMfaFactors.id, userId: userMfaFactors.userId })
      .from(userMfaFactors)
      .where(eq(userMfaFactors.id, factorId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** One factor with its seed opened, for the paths that must verify a code against it. */
  async findFactor(
    runner: IdentityQueryRunner,
    factorId: string,
  ): Promise<UserMfaFactorRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userMfaFactors)
      .where(eq(userMfaFactors.id, factorId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.open(row);
  }

  /** Begin enrolment. The row exists and authorises nothing until `confirmFactor` succeeds. */
  async createFactor(
    runner: IdentityQueryRunner,
    input: { userId: string; kind: string; label: string; secret: string },
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(userMfaFactors)
      .values({
        id,
        userId: input.userId,
        kind: input.kind,
        label: input.label,
        // The seed the caller generated goes no further than this line in the clear.
        secret: this.seeds.encrypt(input.secret, { userId: input.userId }),
        createdAt: sql`current_timestamp(3)`,
      });
    return id;
  }

  /**
   * Turn a stored row into the row the rest of the application expects.
   *
   * The row's own `user_id` is the additional authenticated data, which is what makes a
   * ciphertext non-portable: copied into another person's row it fails here, because the id
   * this decrypt is asked for is not the id the tag covers. Reading the id from the row
   * rather than from the caller's argument matters — a caller that passed the wrong id would
   * otherwise be able to make the check pass.
   */
  private open(row: UserMfaFactorRow): UserMfaFactorRow {
    return { ...row, secret: this.seeds.decrypt(row.secret, { userId: row.userId }) };
  }

  /**
   * Finish enrolment.
   *
   * `confirmed_at IS NULL` in the predicate makes this a one-way door: a factor that is
   * already confirmed is not re-confirmed, so a replayed confirmation request cannot reset
   * `last_accepted_counter` and reopen the replay window the counter exists to close.
   */
  async confirmFactor(
    runner: IdentityQueryRunner,
    factorId: string,
    acceptedCounter: number,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userMfaFactors)
      .set({
        confirmedAt: sql`current_timestamp(3)`,
        lastAcceptedCounter: acceptedCounter,
        lastUsedAt: sql`current_timestamp(3)`,
      })
      .where(and(eq(userMfaFactors.id, factorId), isNull(userMfaFactors.confirmedAt)));
    return result[0].affectedRows > 0;
  }

  /**
   * Record that a code was accepted — the write that makes replay detection real.
   *
   * A compare-and-swap on the counter, not a plain assignment. Two requests presenting the
   * same code at the same instant both read `last_accepted_counter` as the previous value;
   * the `<` predicate means the second one updates nothing, and its caller is told the code
   * was replayed rather than being handed a second session from one code.
   *
   * `IS NULL OR <` rather than `COALESCE(..., -1) <`, because a NULL comparison in MySQL
   * yields NULL rather than true and the row would never match on a factor's first use.
   */
  async recordFactorUse(
    runner: IdentityQueryRunner,
    factorId: string,
    acceptedCounter: number,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userMfaFactors)
      .set({ lastAcceptedCounter: acceptedCounter, lastUsedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(userMfaFactors.id, factorId),
          isNull(userMfaFactors.disabledAt),
          sql`(${userMfaFactors.lastAcceptedCounter} is null or ${userMfaFactors.lastAcceptedCounter} < ${acceptedCounter})`,
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** Soft-disable. The row stays, because "removed on the 3rd" is a question worth answering. */
  async disableFactor(runner: IdentityQueryRunner, factorId: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userMfaFactors)
      .set({ disabledAt: sql`current_timestamp(3)` })
      .where(and(eq(userMfaFactors.id, factorId), isNull(userMfaFactors.disabledAt)));
    return result[0].affectedRows > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recovery codes
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issue a batch, revoking whatever came before it.
   *
   * Both halves in one call because `ID-05` states the guarantee in one sentence —
   * "Regenerating invalidates the old set immediately" — and a caller that could do the
   * insert without the revoke would leave twenty live codes where the screen promised ten.
   * The caller supplies the transaction; this method does not open one, so the revoke and the
   * insert commit together or not at all.
   */
  async replaceRecoveryCodes(
    runner: IdentityQueryRunner,
    userId: string,
    codeHashes: readonly string[],
  ): Promise<string> {
    const db = tenantDrizzle(runner);
    const batchId = uuidv7();

    await db
      .update(userRecoveryCodes)
      .set({ revokedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          isNull(userRecoveryCodes.usedAt),
          isNull(userRecoveryCodes.revokedAt),
        ),
      );

    if (codeHashes.length > 0) {
      await db.insert(userRecoveryCodes).values(
        codeHashes.map((codeHash) => ({
          id: uuidv7(),
          userId,
          batchId,
          codeHash,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
    }

    return batchId;
  }

  /** The codes a person could still present: this batch, unspent, unrevoked. */
  async listUsableRecoveryCodes(
    runner: IdentityQueryRunner,
    userId: string,
  ): Promise<readonly UserRecoveryCodeRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(userRecoveryCodes)
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          isNull(userRecoveryCodes.usedAt),
          isNull(userRecoveryCodes.revokedAt),
        ),
      );
  }

  /**
   * Spend one code, by id.
   *
   * `used_at IS NULL` is the whole of single-use. Two requests presenting the same code race
   * to this `UPDATE`; the database serialises them on the row lock and the second finds
   * nothing to update, so exactly one of them is told the code worked.
   */
  async consumeRecoveryCode(runner: IdentityQueryRunner, codeId: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userRecoveryCodes)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(and(eq(userRecoveryCodes.id, codeId), isNull(userRecoveryCodes.usedAt)));
    return result[0].affectedRows > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Users, by the identifier a person actually types
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Find a user by email.
   *
   * Lower-cased before the comparison because `users.email` is `utf8mb4_unicode_ci` — the
   * comparison is already case-insensitive at the database — but doing it here as well means
   * the behaviour does not silently depend on a collation someone could change in a later
   * migration. Only the id and the display name come back; this method is used on the
   * unauthenticated path and has no business returning a whole user row there.
   */
  async findUserIdByEmail(
    runner: IdentityQueryRunner,
    email: string,
  ): Promise<{ readonly id: string; readonly displayName: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The pre-tenant security log
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Append one attempt. Insert only — the table is append-only by trigger and by grant.
   *
   * `userId` is nullable and is `null` when the attempt named an address no account holds.
   * That row is the only trace an enumeration sweep leaves, so it is written rather than
   * skipped.
   *
   * `ip` and `userAgent` come from request headers and are clamped to their columns here —
   * see {@link clampToColumnCharacters} for why the row is kept rather than the write
   * refused, and why the count is in code points. Nothing else about either value is
   * touched: the log records what arrived.
   *
   * ## A succeeded credential change may not be written here — `D05d`, I1
   *
   * This method refuses a `succeeded` row whose action is one of
   * {@link CREDENTIAL_CHANGE_ACTIONS}. Such a row *is* a credential change, and recording one
   * without the notice beside it is the failure `D05d` exists to prevent — previously avoided
   * only because every caller happened to reach for {@link recordCredentialChange}. The refusal
   * makes atomicity a property of the type of write rather than of the author's memory: the one
   * way to record a succeeded credential change is {@link recordCredentialChange}, which writes
   * the log row (through {@link insertAuthenticationEvent}, below this guard) and the notice as
   * one unit. Failures are untouched — a refused attempt is not a change and carries no notice —
   * and so are the non-credential successes (`password_sign_in`, `mfa_challenge`, `recovery_code`,
   * `reauthentication`).
   */
  async recordAuthenticationEvent(
    runner: IdentityQueryRunner,
    input: {
      userId?: string | null;
      action: string;
      outcome: string;
      reason?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      correlationId?: string | null;
    },
  ): Promise<void> {
    if (input.outcome === 'succeeded' && CREDENTIAL_CHANGE_ACTIONS.includes(input.action)) {
      throw new CredentialChangeNoticeRequiredError(input.action);
    }
    await this.insertAuthenticationEvent(runner, input);
  }

  /**
   * The raw append, below the {@link recordAuthenticationEvent} guard.
   *
   * Private on purpose: the guard is the point. The sole legitimate writer of a `succeeded`
   * credential-change row — {@link recordCredentialChange} — reaches the insert here directly,
   * paired with the notice; nothing outside this file can. A refusal row still flows through
   * the public method, which lets any `failed` row (and any non-credential success) straight
   * through to here.
   */
  private async insertAuthenticationEvent(
    runner: IdentityQueryRunner,
    input: {
      userId?: string | null;
      action: string;
      outcome: string;
      reason?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      correlationId?: string | null;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(authenticationEvents)
      .values({
        // Ordered, not plain v7: readers sort by `occurred_at, id`, and rows one change
        // writes share a millisecond — see `ordered-id.ts`.
        id: orderedUuidv7(),
        userId: input.userId ?? null,
        action: input.action,
        outcome: input.outcome,
        reason: input.reason ?? null,
        ip: clampToColumnCharacters(input.ip, MAX_EVENT_IP_CHARACTERS),
        userAgent: clampToColumnCharacters(input.userAgent, MAX_EVENT_USER_AGENT_CHARACTERS),
        correlationId: input.correlationId ?? null,
        occurredAt: sql`current_timestamp(3)`,
      });
  }

  /**
   * `D05d`. Record a credential change **and** queue the notice that tells its owner —
   * one method, one unit of work, because the two must not be separable.
   *
   * ## Why this is not two calls at the call site
   *
   * It was, in the first draft, and that draft is the shape this repository has already been
   * burned by: a notification whose writer is a dependency the caller can hold or not hold
   * (`private readonly outbox?: OutboxEventsRepository` — see `work-items.service.ts:222`
   * and `conversations.service.ts:296`) is a notification that is silently absent wherever
   * somebody built the service without it, and that is an incident this repository has
   * actually had. The same failure in slower motion is a success path that records the
   * change and forgets the notice, because recording is the line that looks like the
   * important one.
   *
   * So there is no optional collaborator and no second call to forget. A caller that writes
   * the log row for a *change* writes the notice with it, or writes neither. Refusals keep
   * {@link recordAuthenticationEvent}: a refused attempt changed nothing, has nothing to
   * tell the owner about, and is written in a transaction of its own precisely because it
   * has no change to join.
   *
   * ## Both rows, and the change, commit together
   *
   * Like every method here this takes the caller's runner and cannot open a transaction of
   * its own — `24-EVENT-CATALOG` §2's producer rule, and the property that makes the notice
   * trustworthy in both directions. A notice that survived a rolled-back change would tell
   * the owner their password changed when it did not, which is a worse lie than silence; a
   * change that committed without its notice is the silence `D05d` is about.
   *
   * `occurred_at` and `available_at` are the server's clock, not this process's, for
   * `OutboxEventsRepository.append`'s reason: a notice stamped by a skewed application clock
   * could be born minutes in the future and sit undelivered while looking deliverable.
   */
  async recordCredentialChange(
    runner: IdentityQueryRunner,
    input: {
      userId: string;
      action: string;
      ip?: string | null;
      userAgent?: string | null;
      correlationId?: string | null;
    },
  ): Promise<void> {
    // The private insert, not the public {@link recordAuthenticationEvent}: this *is* the one
    // sanctioned writer of a succeeded credential-change row, and it pairs that row with the
    // notice below. Going through the public method would trip its own guard.
    await this.insertAuthenticationEvent(runner, {
      userId: input.userId,
      action: input.action,
      outcome: 'succeeded',
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
    });

    await tenantDrizzle(runner)
      .insert(credentialChangeNotices)
      .values({
        id: orderedUuidv7(),
        userId: input.userId,
        action: input.action,
        correlationId: input.correlationId ?? null,
        occurredAt: sql`current_timestamp(3)`,
        availableAt: sql`current_timestamp(3)`,
      });
  }

  /**
   * How many failures this user has accumulated inside the window.
   *
   * The window is expressed in the predicate as `occurred_at >= now(3) - INTERVAL n SECOND`,
   * so the server decides what "recent" means. Passing a `Date` computed in Node would make
   * the lockout depend on the API instance's clock, and the direction that fails is the one
   * where a slow clock silently widens the window an attacker gets.
   *
   * `13-ENGINEERING-EXECUTION-SPEC` §1 assumes Redis for rate limits. There is none here and
   * none on the shared host, so this counts rows. The two consequences are recorded in
   * `docs/implementation-status.md` rather than hidden: it costs a query per attempt, and it
   * counts per **user**, so it stops stuffing against one account and does not stop one
   * attempt each against a thousand.
   *
   * ## What a *credential* failure is — `D08`, N-2 (re-review of 2026-09-07)
   *
   * A `failed` row is not by itself evidence that somebody guessed wrong. The three
   * {@link SIGN_IN_ABUSE_REASONS} are written by `sign-in-abuse-control.ts` when an attempt was
   * refused **in front of** the password check: nothing was read, no hash was verified, and
   * nobody guessed anything. Two of those three budgets — the per-source key and the global
   * key — are spent by *everybody*, and `confirmReauthentication` records its refusal with the
   * session holder's real user id. It is worth being exact about who writes such a row, because
   * the obvious reading is wrong: a row naming a user only ever comes from that user's own
   * re-authentication being refused. What a third party supplies is the refusal, not the row —
   * by keeping a shared budget spent. So while these rows were counted, a colleague on the same
   * office address — or, while D09 stood, anyone at all, and since D09 anyone behind a
   * misconfigured trusted proxy (`docs/runbooks/deploy.md`) — could hold the per-source or global
   * key over budget, and five of the named user's own re-authentications across the windows that fit
   * inside 900 s would then lock that user out of their own account on traffic that was never
   * theirs.
   *
   * They are therefore excluded here and nowhere else. The row is still written, still names
   * the user and still carries its reason, so the operator trace
   * `migrations/0004_credentials.sql` asks for is untouched; it is only this counter that stops
   * reading it. `reason IS NULL` is kept explicitly, because `NOT IN` over a NULL is NULL and
   * would silently drop every failure that records no reason at all.
   *
   * ## The lockout's own row — `D08`, A-1 (four-lens review of `7cc9c16`, 2026-09-07)
   *
   * `locked_out` has exactly that shape and was not excluded with the other three. It is the row
   * `signInWithPassword` (and `confirmReauthentication`, and the two challenge paths) writes
   * against the victim's own user id *because* this count was already full — written in front of
   * the password check, with nothing read and nothing guessed. While it was counted, every
   * refusal pushed a fresh counted row into the very window the refusal was derived from, so the
   * lockout renewed itself: at the shipped defaults (five failures in 900 s, ten requests per
   * 300 s on the account key) roughly two attempts every five minutes hold an account shut
   * indefinitely — from a third party who knows the address, or from the victim's own retries,
   * who are being told that waiting is the fix.
   *
   * The invariant this predicate now holds is the one that was missing: **it counts credentials
   * that were presented and refused, and never a row it caused itself.** A `locked_out` row is a
   * consequence of the count, never an input to it — the same relation the three throttle
   * reasons have to it, reached by a different path. The audit trail is untouched once more: the
   * row is still written, still names the user, still carries `locked_out`, and only this
   * counter stops reading it.
   *
   * ## The gate's own rows — `D05`, X2 (2026-09-12)
   *
   * The four {@link REAUTH_FAILURE_REASONS} are the third instance of that shape, and the one
   * with an attacker attached. `AuthenticationService.requireReauth` writes a `failed` row
   * against the caller's user id every time it refuses one of the five credential-changing
   * routes — `password/set`, the two TOTP enrolment halves, `factors/:factorId`, and
   * `recovery-codes` — for want of fresh proof. Not one of those refusals read a credential:
   * see the note on the constant for what each of the four actually means.
   *
   * Who writes them is what made counting them a denial of service rather than an inaccuracy.
   * The refusal is reached from inside a live session, so somebody holding a stolen cookie
   * posts five ungated requests inside the window and fills the *owner's* lockout with rows
   * the owner never caused — and none of the five routes consults the `D08` bound, so there is
   * no ceiling on how many they can write. What that shuts is precisely the recovery: this
   * count is read by `signInWithPassword` **and** by `confirmReauthentication`, so the owner
   * can neither sign in nor mint the proof that would end the intruder's session or rotate
   * what they hold, while the intruder holds it shut for as long as they like.
   *
   * The invariant is unchanged and so is the remedy — the rows are still written, still name
   * the user, still carry their reason, because an attempt on a credential-changing route is
   * exactly the evidence an incident needs; only this counter stops reading them. What still
   * counts, and must, is the credential `confirmReauthentication` genuinely presents: a wrong
   * password there is `bad_password`, a wrong code `mfa_bad_code`, and both are outside this
   * list. Re-authentication is a password oracle and its lockout is untouched.
   *
   * ## A credential change starts the count again — N01 (security audit run 2, wave 10)
   *
   * F20 made a full window refuse right and wrong guesses alike, and the window never counts its
   * own `locked_out` rows, so one wrong guess every three minutes or so kept any known account
   * shut for as long as the guesser liked — and a completed password reset did not help, because
   * the five wrong guesses were still inside the 900 s window when the holder tried the new
   * password. Now only failures at or after the person's latest **succeeded** `password_set` row
   * count. That row is written by {@link recordCredentialChange} alone, in the same transaction as
   * the change, so it exists only when a reset by email (proof of the mailbox) or a password change
   * (behind this very window, through re-authentication) really committed. A guesser cannot write
   * it, so the F20 refusal of a right guess inside a full window is otherwise unchanged; what
   * changes is that the person who proves they hold the mailbox walks out of the lockout with the
   * password they just chose. With no such row the bound falls back to the window start, which is
   * the old predicate exactly. `>=` rather than `>`, so a failure stamped in the same millisecond
   * as the change still counts (the stricter direction). One indexed subquery on
   * `ix_authentication_events_user`, uncorrelated, valid on MariaDB and MySQL alike.
   */
  async countRecentFailures(
    runner: IdentityQueryRunner,
    userId: string,
    windowSeconds: number,
  ): Promise<number> {
    const windowStart = sql`date_sub(now(3), interval ${windowSeconds} second)`;
    const latestCredentialChange = tenantDrizzle(runner)
      .select({ at: sql`max(${authenticationEvents.occurredAt})` })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          eq(authenticationEvents.action, PASSWORD_SET_ACTION),
          eq(authenticationEvents.outcome, 'succeeded'),
        ),
      );
    const rows = await tenantDrizzle(runner)
      .select({ failures: sql<number>`count(*)` })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          eq(authenticationEvents.outcome, 'failed'),
          or(
            isNull(authenticationEvents.reason),
            notInArray(authenticationEvents.reason, [...NON_CREDENTIAL_FAILURE_REASONS]),
          ),
          gte(authenticationEvents.occurredAt, windowStart),
          gte(
            authenticationEvents.occurredAt,
            sql`coalesce((${latestCredentialChange}), ${windowStart})`,
          ),
        ),
      );
    return Number(rows[0]?.failures ?? 0);
  }

  /**
   * N01 (wave 11). When the person's latest **succeeded** `password_set` row was written - the
   * row a reset or a password change writes in its own transaction, and the bound
   * {@link countRecentFailures} counts from. `null` when there is none. A reset sign-in grant
   * (`reset-sign-in-grant.ts`) carries this value and is honoured only while it is still the
   * latest, so a second reset makes an older grant stale. One descending read on
   * `ix_authentication_events_user (user_id, occurred_at)`; valid on MariaDB and MySQL alike.
   */
  async findLatestPasswordSetAt(runner: IdentityQueryRunner, userId: string): Promise<Date | null> {
    const rows = await tenantDrizzle(runner)
      .select({ at: authenticationEvents.occurredAt })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          eq(authenticationEvents.action, PASSWORD_SET_ACTION),
          eq(authenticationEvents.outcome, 'succeeded'),
        ),
      )
      .orderBy(desc(authenticationEvents.occurredAt))
      .limit(1);
    return rows[0]?.at ?? null;
  }

  /**
   * N01 (wave 11). Whether the person has signed in successfully at or after `at` - by password
   * (including the password step of an MFA sign-in), by code, by recovery code or by Google.
   * This is what makes a reset sign-in grant single-use: the first succeeded sign-in after the
   * reset writes the row that answers `true` here, and nothing a guesser can do removes it.
   * `>=`, the stricter direction: a sign-in stamped in the reset's own millisecond spends it.
   * One indexed probe on `ix_authentication_events_user`, `LIMIT 1`, valid on MariaDB.
   */
  async hasSucceededSignInSince(
    runner: IdentityQueryRunner,
    userId: string,
    at: Date,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: authenticationEvents.id })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          eq(authenticationEvents.outcome, 'succeeded'),
          inArray(authenticationEvents.action, [...SIGN_IN_ACTIONS]),
          gte(authenticationEvents.occurredAt, at),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The credential changes this person's account has actually undergone — `D05d`.
   *
   * The second reader this table has ever had, and it is the one the account owner is behind.
   * Until now `authentication_events` was written by every credential route and read only by
   * {@link CredentialsRepository.countRecentFailures}, which means the answer to "did somebody
   * change my recovery codes" was already recorded and could not be asked. `ID-05` in
   * `22-SCREEN-BY-SCREEN-SPEC` asks for a "security event receipt"; this is the query behind
   * it.
   *
   * ## What it will not return
   *
   * `reason` is not selected. Migration 0004 is explicit — "Recorded here and NEVER returned
   * to the caller" — and a `SELECT` that never names the column cannot be edited later into
   * one that leaks it by way of a spread.
   *
   * `outcome` is fixed to `succeeded` rather than exposed. A refused attempt is a different
   * fact from a change, it is written by the refusal path in a transaction of its own, and
   * showing "recovery codes replaced" for something that was refused would raise an alarm
   * about nothing. The failures are still in the table for an operator.
   *
   * `actions` is a closed list supplied by the caller, for the reason
   * {@link NON_CREDENTIAL_FAILURE_REASONS} is spelled here rather than imported: the
   * vocabulary lives in `authentication.service.ts`, which imports this file. A sign-in, a
   * challenge and a re-authentication are not credential changes and cannot arrive through
   * this read even by mistake.
   *
   * `limit` is required and has no default. The index is
   * `ix_authentication_events_user (user_id, occurred_at)`, so the descending scan is cheap —
   * but a security screen is not a reason to hand back an unbounded history, and a default
   * would be this file inventing a page size for a screen it cannot see.
   */
  async listCredentialChanges(
    runner: IdentityQueryRunner,
    userId: string,
    actions: readonly string[],
    limit: number,
  ): Promise<readonly { id: string; action: string; occurredAt: Date }[]> {
    if (actions.length === 0) return [];

    return tenantDrizzle(runner)
      .select({
        id: authenticationEvents.id,
        action: authenticationEvents.action,
        occurredAt: authenticationEvents.occurredAt,
      })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          eq(authenticationEvents.outcome, 'succeeded'),
          inArray(authenticationEvents.action, [...actions]),
        ),
      )
      .orderBy(desc(authenticationEvents.occurredAt), desc(authenticationEvents.id))
      .limit(limit);
  }
}
