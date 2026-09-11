import { and, desc, eq, gte, isNull, notInArray, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  authenticationEvents,
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
 * The reasons a `failed` row can carry that are **not** a credential failure.
 *
 * {@link CredentialsRepository.countRecentFailures} excludes exactly these, and the header there
 * gives the argument for each. In one line: the three {@link SIGN_IN_ABUSE_REASONS} are refusals
 * written in front of the password check (N-2), and `locked_out` is the row the lockout writes
 * about itself (A-1) — a consequence of the count, never an input to it.
 *
 * `'locked_out'` is spelled here rather than imported because the union it belongs to lives in
 * `authentication.service.ts`, which imports *this* file; the string is asserted against the
 * service's behaviour by the database case that drives a real lockout, not by the type.
 */
const NON_CREDENTIAL_FAILURE_REASONS = [...SIGN_IN_ABUSE_REASONS, 'locked_out'] as const;

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
 * These are `utf8mb4` columns, and MySQL and MariaDB both count `VARCHAR(n)` in *characters*
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
    await tenantDrizzle(runner)
      .insert(authenticationEvents)
      .values({
        id: uuidv7(),
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
   * office address (or, while D09 stands, anyone at all) could hold the per-source or global key
   * over budget, and five of the named user's own re-authentications across the windows that fit
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
   */
  async countRecentFailures(
    runner: IdentityQueryRunner,
    userId: string,
    windowSeconds: number,
  ): Promise<number> {
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
          gte(
            authenticationEvents.occurredAt,
            sql`date_sub(now(3), interval ${windowSeconds} second)`,
          ),
        ),
      );
    return Number(rows[0]?.failures ?? 0);
  }
}
