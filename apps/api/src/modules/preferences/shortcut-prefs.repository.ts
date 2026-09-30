import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { userShortcutPrefs } from '../../common/database/schema.js';
import type { UserShortcutPrefRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PRF keyboard shortcuts (x286, module 20) — a member's own shortcut-override store: list their
 * overrides, rebind one action, reset one action, and nothing else.
 *
 * Every method names a membership. There is no `list(context)` that returns a studio's overrides: an
 * override row is one member's, and a method without a `membershipId` parameter would be the one place
 * that rule could be dropped — the same shape `home_widget_prefs` and `a11y_preferences` take for
 * their per-membership reads.
 *
 * ## The rebind is one upsert; the reset is one scoped delete
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against
 * `uq_user_shortcut_prefs_org_membership_action`, so two rebinds racing for one `(member, action)`
 * serialise on the unique key rather than on a row this code read first — a lost update is not
 * expressible. {@link remove} deletes only the caller's own `(organization, membership, action)` row,
 * so it can never touch another member's override; it is idempotent (no row is still a success).
 */
export class ShortcutPrefsRepository {
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<UserShortcutPrefRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(userShortcutPrefs)
      .where(
        and(
          eq(userShortcutPrefs.organizationId, context.organizationId),
          eq(userShortcutPrefs.membershipId, membershipId),
        ),
      );
  }

  /** Create or replace this member's override of one action. Idempotent by the unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    actionKey: string,
    chord: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userShortcutPrefs)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        actionKey,
        chord,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          chord,
        },
      });
  }

  /** Reset one action to its default by removing this member's own override. Idempotent. */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    actionKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(userShortcutPrefs)
      .where(
        and(
          eq(userShortcutPrefs.organizationId, context.organizationId),
          eq(userShortcutPrefs.membershipId, membershipId),
          eq(userShortcutPrefs.actionKey, actionKey),
        ),
      );
  }
}
