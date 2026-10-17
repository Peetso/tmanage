import { eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, organizations, users } from '../../common/database/schema.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * First-owner setup — the two statements the `/setup` path needs that nothing else issues.
 *
 * TManage has no public sign-up, and until this file nothing in the API created a `users` row,
 * so a fresh production install had no way to reach its first organisation owner. The setup
 * route closes that gap once: it is enabled only while `SETUP_TOKEN` is set and the install is
 * empty, and this repository answers "is it empty?" and writes the person.
 *
 * ## Why no new table
 *
 * "Setup has already happened" is not a fact that needs storing, because it is already true of
 * the data: an install with an organisation or an owner membership has been set up. Reading
 * that from `organizations` and `memberships` means the guard cannot disagree with reality — a
 * restored backup, or an organisation provisioned some other way, closes the door just as a
 * completed setup does — and avoids a fifth place in the schema registry for a single flag.
 *
 * ## Where these run
 *
 * Both methods run inside `TenantDatabase.firstOwnerTransaction`, under the advisory lock that
 * transaction takes before anything else. That lock, not anything here, is what stops two
 * concurrent setup requests from both seeing zero and both succeeding: the second waits, then
 * counts again and finds the first one's rows.
 *
 * ## The database owns the clock
 *
 * As in `CredentialsRepository`, every timestamp written is `current_timestamp(3)`.
 */

/** The address is already a user's. Setup refuses rather than attaching to that account. */
export class FirstOwnerEmailTakenError extends Error {
  constructor() {
    super('That email address is already registered');
    this.name = 'FirstOwnerEmailTakenError';
  }
}

export interface NewOwnerUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
}

export class FirstOwnerRepository {
  /**
   * How many organisations, and how many owner memberships, exist across the whole install.
   *
   * Two separate statements rather than one with subqueries, so each touches a single declared
   * table on the bootstrap path. `COUNT(*)` can come back from the driver as a number or a
   * string depending on its settings, so both are coerced.
   */
  async countExisting(
    runner: BootstrapQueryRunner,
  ): Promise<{ readonly organizations: number; readonly owners: number }> {
    const db = tenantDrizzle(runner);
    const orgRows = await db.select({ n: sql<unknown>`count(*)` }).from(organizations);
    const ownerRows = await db
      .select({ n: sql<unknown>`count(*)` })
      .from(memberships)
      .where(eq(memberships.role, 'owner'));
    return {
      organizations: Number(orgRows[0]?.n ?? 0),
      owners: Number(ownerRows[0]?.n ?? 0),
    };
  }

  /**
   * Insert the first owner's `users` row.
   *
   * The email is stored trimmed and lower-cased, because sign-in looks it up that way
   * (`CredentialsRepository.findUserIdByEmail`); a mixed-case row would be an account nobody
   * could sign in to. `email_verified_at` is set now: whoever holds the setup token has proved
   * control of the install, which is the stronger claim.
   *
   * A duplicate on `uq_users_email` becomes {@link FirstOwnerEmailTakenError}, detected the same
   * way `OrganizationsRepository` detects a taken slug — unwrap Drizzle's error first, then
   * require both the `ER_DUP_ENTRY` code and the constraint name.
   */
  async insertUser(runner: IdentityQueryRunner, user: NewOwnerUser): Promise<void> {
    try {
      await tenantDrizzle(runner)
        .insert(users)
        .values({
          id: user.id,
          email: user.email.trim().toLowerCase(),
          displayName: user.displayName,
          locale: user.locale,
          timezone: user.timezone,
          emailVerifiedAt: sql`current_timestamp(3)`,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateEmail(error)) throw new FirstOwnerEmailTakenError();
      throw error;
    }
  }
}

/** Whether a driver error is the `uq_users_email` unique key. See `isDuplicateSlug`. */
function isDuplicateEmail(error: unknown): boolean {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const candidate = unwrapped as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return candidate.code === 'ER_DUP_ENTRY' && message.includes('uq_users_email');
}
