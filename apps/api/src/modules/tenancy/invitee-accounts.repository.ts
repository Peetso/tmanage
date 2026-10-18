import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { users } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The account half of an invitation registration (ACC-01): the `users` row for somebody who
 * followed an invitation link and has never had an account.
 *
 * Only the invitation's own address is ever written — the caller passes the row's `email`,
 * never anything from the request body — so a token holder can create the one account the
 * invitation was addressed to and nothing else. `email_verified_at` is set now: holding the
 * 256-bit token that was mailed to the address is proof of the mailbox, the same claim
 * `FirstOwnerRepository` makes for the setup token.
 */

/** `uq_users_email` refused the insert: an account already uses the invitation's address. */
export class InviteeAccountExistsError extends Error {
  override name = 'InviteeAccountExistsError';
  constructor() {
    super('An account already uses this address.');
  }
}

export interface NewInviteeAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
}

export class InviteeAccountsRepository {
  async insertUser(runner: IdentityQueryRunner, user: NewInviteeAccount): Promise<void> {
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
          emailVerifiedAt: sql`current_timestamp(3)`,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error, 'uq_users_email')) throw new InviteeAccountExistsError();
      throw error;
    }
  }
}

/**
 * Whether a driver error is the named unique key. Unwrap Drizzle's error first, then require
 * both the `ER_DUP_ENTRY` code and the constraint name — `FirstOwnerRepository`'s rule.
 */
export function isDuplicateKey(error: unknown, constraint: string): boolean {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const candidate = unwrapped as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return candidate.code === 'ER_DUP_ENTRY' && message.includes(constraint);
}
