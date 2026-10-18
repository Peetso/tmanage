import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { passwordResetTokens, users } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * `password_reset_tokens` (0204, ACC-02). Every statement compares time **in the database** —
 * `expires_at` is written as `now + 30 minutes` and read as `> now` on the same clock — because
 * the application clock and the database clock are different clocks, the lesson `invitations`
 * already records. No method returns a `token_hash`.
 */

export interface ResetTarget {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
}

export class PasswordResetRepository {
  /** The account an address names, or `null`. Lower-cased the way sign-in looks it up. */
  async findAccount(runner: IdentityQueryRunner, email: string): Promise<ResetTarget | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Retire every unused link this person holds, so only the newest one works. */
  async retireOpen(runner: IdentityQueryRunner, userId: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(passwordResetTokens)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  }

  async create(
    runner: IdentityQueryRunner,
    input: { readonly userId: string; readonly tokenHash: string; readonly ttlMinutes: number },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(passwordResetTokens)
      .values({
        id: uuidv7(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: sql`date_add(current_timestamp(3), interval ${input.ttlMinutes} minute)`,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /** The person a live (unused, unexpired) link belongs to, or `null`. */
  async findLive(runner: IdentityQueryRunner, tokenHash: string): Promise<ResetTarget | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        locale: users.locale,
      })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, sql`current_timestamp(3)`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Spend a link. The compare-and-set is what makes it single-use: two requests racing with one
   * link both find it live, and exactly one of them updates it. `false` means it was already
   * spent or has just expired.
   */
  async spend(runner: IdentityQueryRunner, tokenHash: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(passwordResetTokens)
      .set({ usedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, sql`current_timestamp(3)`),
        ),
      );
    return result[0].affectedRows === 1;
  }
}
