import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
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
 * or a leftover plaintext one refuses a sign-in rather than quietly permitting it.
 */

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
    return rows.map((row) => this.open(row));
  }

  /** Every factor a person holds, confirmed or not, for the security screen. */
  async listAllFactors(
    runner: IdentityQueryRunner,
    userId: string,
  ): Promise<readonly UserMfaFactorRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userMfaFactors)
      .where(and(eq(userMfaFactors.userId, userId), isNull(userMfaFactors.disabledAt)))
      .orderBy(desc(userMfaFactors.createdAt));
    return rows.map((row) => this.open(row));
  }

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
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
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
          gte(
            authenticationEvents.occurredAt,
            sql`date_sub(now(3), interval ${windowSeconds} second)`,
          ),
        ),
      );
    return Number(rows[0]?.failures ?? 0);
  }
}
