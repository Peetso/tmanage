import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { a11yPreferences, clientA11yPreferences } from '../../common/database/schema.js';
import type {
  A11yPreferenceRow,
  A11yPreferences,
  ClientA11yPreferenceRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * A11Y-183's preferences store — read one member's accessibility settings, write them, and
 * nothing else (module 20 Preferences & accessibility, x183).
 *
 * Both methods name a membership. There is no `list(context)` that returns a studio's
 * preferences: a preference is one member's, and a method without a `membershipId` parameter
 * would be the one place that rule could be dropped — the same shape `home_pinned_items` takes
 * for its per-membership reads.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_a11y_preferences_org_membership`. Two saves racing for one member's row serialise on the
 * unique key rather than on a row this code read first, so a lost update is not expressible. The
 * insert path fills `id`; the update path leaves it alone and moves only the settings, and
 * `updated_at` follows by the column's `ON UPDATE`.
 */
export class A11yPreferencesRepository {
  async findForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<A11yPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(a11yPreferences)
      .where(
        and(
          eq(a11yPreferences.organizationId, context.organizationId),
          eq(a11yPreferences.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this member's settings in this studio. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    settings: A11yPreferences,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(a11yPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        a11yJson: settings,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          a11yJson: settings,
        },
      });
  }

  /**
   * PORTALA11Y (0357). The same read for a client portal user, keyed to their own client
   * membership (`client_a11y_preferences`): a client has no `memberships` row to key 0079 to.
   */
  async findForClientMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
  ): Promise<ClientA11yPreferenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientA11yPreferences)
      .where(
        and(
          eq(clientA11yPreferences.organizationId, context.organizationId),
          eq(clientA11yPreferences.clientMembershipId, clientMembershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace this client person's settings in this studio. Idempotent by the unique key. */
  async upsertForClientMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientMembershipId: string,
    settings: A11yPreferences,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(clientA11yPreferences)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        clientMembershipId,
        a11yJson: settings,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { a11yJson: settings } });
  }
}
