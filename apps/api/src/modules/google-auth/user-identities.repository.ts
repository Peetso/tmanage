import { uuidv7 } from '@tmanage/domain';
import { and, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userIdentities, users } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { isDuplicateKey } from '../tenancy/invitee-accounts.repository.js';

/** The tables every Google unit of work declares to the identity runner. */
export const GOOGLE_IDENTITY_TABLES = [
  'users',
  'user_passwords',
  'user_identities',
  'user_mfa_factors',
  'authentication_events',
] as const;

/** `uq_user_identities_*` refused the link: the Google account or the person is already linked. */
export class IdentityAlreadyLinkedError extends Error {
  override name = 'IdentityAlreadyLinkedError';
  constructor() {
    super('This Google account or this person is already linked.');
  }
}

/** `user_identities` (0205): a provider's stable subject linked to one person. */
export class UserIdentitiesRepository {
  async findUserBySubject(
    runner: IdentityQueryRunner,
    provider: string,
    subject: string,
  ): Promise<{ readonly userId: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The account using this address, with whether its owner ever proved the mailbox
   * (`email_verified_at`). A public password sign-up leaves it NULL; Google sign-in must not
   * merge into such an account (audit run 1, F03).
   */
  async findUserByEmail(
    runner: IdentityQueryRunner,
    email: string,
  ): Promise<{ readonly userId: string; readonly emailVerifiedAt: Date | null } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: users.id, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async link(
    runner: IdentityQueryRunner,
    input: { userId: string; provider: string; subject: string; email: string },
  ): Promise<void> {
    try {
      await tenantDrizzle(runner)
        .insert(userIdentities)
        .values({
          id: uuidv7(),
          userId: input.userId,
          provider: input.provider,
          subject: input.subject,
          email: input.email,
          createdAt: sql`current_timestamp(3)`,
          lastUsedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (
        isDuplicateKey(error, 'uq_user_identities_subject') ||
        isDuplicateKey(error, 'uq_user_identities_user_provider')
      ) {
        throw new IdentityAlreadyLinkedError();
      }
      throw error;
    }
  }

  async touch(runner: IdentityQueryRunner, provider: string, subject: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(userIdentities)
      .set({ lastUsedAt: sql`current_timestamp(3)` })
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)));
  }
}
