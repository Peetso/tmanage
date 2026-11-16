import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userMfaEmailCodes } from '../../common/database/schema.js';
import type { UserMfaEmailCodeRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_SECONDS } from './email-code.js';
import type { EmailCodePurpose } from './email-code.js';

/**
 * MFAOPTIONS. Storage for mailed second-step codes (`user_mfa_email_codes`, migration 0360).
 *
 * Like `CredentialsRepository`, every method takes the identity runner of the caller's unit of
 * work, and the database owns the clock: `expires_at` is written and compared as the server's
 * `current_timestamp(3)`, so two API processes with skewed clocks agree on whether a code is
 * still good. Only hashes arrive here (`email-code.ts`); nothing in this file sees a code.
 *
 * A row is never deleted by the API. Spent, replaced, expired and dead rows stay as evidence
 * and are erased with the person (`ACCOUNT_ERASURE_TABLES`).
 */
export class EmailCodesRepository {
  /**
   * Store a freshly mailed code. Any code still open for the same binding is retired first, in
   * the same unit of work, so a resend leaves exactly one code that works.
   */
  async create(
    runner: IdentityQueryRunner,
    input: {
      readonly userId: string;
      readonly factorId: string;
      readonly purpose: EmailCodePurpose;
      readonly bindingHash: string;
      readonly codeHash: string;
    },
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .update(userMfaEmailCodes)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(
        and(eq(userMfaEmailCodes.bindingHash, input.bindingHash), isNull(userMfaEmailCodes.usedAt)),
      );
    await db.insert(userMfaEmailCodes).values({
      id: uuidv7(),
      userId: input.userId,
      factorId: input.factorId,
      purpose: input.purpose,
      bindingHash: input.bindingHash,
      codeHash: input.codeHash,
      attempts: 0,
      createdAt: sql`current_timestamp(3)`,
      expiresAt: sql`date_add(current_timestamp(3), interval ${EMAIL_CODE_TTL_SECONDS} second)`,
    });
  }

  /** The one code that can still finish this binding: unspent and not expired. */
  async findOpen(
    runner: IdentityQueryRunner,
    bindingHash: string,
  ): Promise<UserMfaEmailCodeRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(userMfaEmailCodes)
      .where(
        and(
          eq(userMfaEmailCodes.bindingHash, bindingHash),
          isNull(userMfaEmailCodes.usedAt),
          sql`${userMfaEmailCodes.expiresAt} > current_timestamp(3)`,
        ),
      )
      .orderBy(desc(userMfaEmailCodes.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Count one wrong guess against the open code. The guess that reaches
   * {@link EMAIL_CODE_MAX_ATTEMPTS} also spends the row, which kills the binding (see
   * {@link isExhausted}). A compare-and-swap on the attempt count read moments ago, so two
   * concurrent wrong guesses cannot both be counted as the fourth.
   */
  async recordWrongAttempt(
    runner: IdentityQueryRunner,
    row: Pick<UserMfaEmailCodeRow, 'id' | 'attempts'>,
  ): Promise<'counted' | 'dead'> {
    const next = row.attempts + 1;
    const dead = next >= EMAIL_CODE_MAX_ATTEMPTS;
    await tenantDrizzle(runner)
      .update(userMfaEmailCodes)
      .set(dead ? { attempts: next, usedAt: sql`current_timestamp(3)` } : { attempts: next })
      .where(
        and(
          eq(userMfaEmailCodes.id, row.id),
          eq(userMfaEmailCodes.attempts, row.attempts),
          isNull(userMfaEmailCodes.usedAt),
        ),
      );
    return dead ? 'dead' : 'counted';
  }

  /**
   * Spend the code: single use. A compare-and-swap on `used_at IS NULL` and on the expiry, so a
   * second request presenting the same code at the same instant spends nothing and is refused.
   */
  async spend(runner: IdentityQueryRunner, id: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(userMfaEmailCodes)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(userMfaEmailCodes.id, id),
          isNull(userMfaEmailCodes.usedAt),
          sql`${userMfaEmailCodes.expiresAt} > current_timestamp(3)`,
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Whether this binding has used up its wrong guesses. A dead sign-in challenge takes no new
   * code and no method finishes it; the person signs in again from the password.
   */
  async isExhausted(runner: IdentityQueryRunner, bindingHash: string): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: userMfaEmailCodes.id })
      .from(userMfaEmailCodes)
      .where(
        and(
          eq(userMfaEmailCodes.bindingHash, bindingHash),
          gte(userMfaEmailCodes.attempts, EMAIL_CODE_MAX_ATTEMPTS),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
