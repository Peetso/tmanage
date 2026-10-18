import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { users } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import { isDuplicateKey } from '../tenancy/invitee-accounts.repository.js';

/**
 * The `users` row a public sign-up creates.
 *
 * Unlike the invitee and first-owner inserts, `email_verified_at` stays NULL: nobody has proved
 * the mailbox yet (no token was mailed to it). Sign-in does not depend on the column, so the
 * account works at once — the open sign-up Peter asked for — and the column remains honest for
 * the day verification is required.
 */

/** `uq_users_email` refused the insert: an account already uses this address. */
export class SignupEmailTakenError extends Error {
  override name = 'SignupEmailTakenError';
  constructor() {
    super('An account already uses this address.');
  }
}

export interface NewSignupAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  /** True only when an identity provider has asserted the address (Google `email_verified`). */
  readonly emailVerified?: boolean;
}

export class SignupAccountsRepository {
  async insertUser(runner: IdentityQueryRunner, user: NewSignupAccount): Promise<void> {
    try {
      await tenantDrizzle(runner)
        .insert(users)
        .values({
          id: user.id,
          // Stored as sign-in looks it up (`CredentialsRepository.findUserIdByEmail`).
          email: user.email.trim().toLowerCase(),
          displayName: user.displayName,
          locale: user.locale,
          timezone: user.timezone,
          emailVerifiedAt: user.emailVerified === true ? sql`current_timestamp(3)` : null,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error, 'uq_users_email')) throw new SignupEmailTakenError();
      throw error;
    }
  }
}
