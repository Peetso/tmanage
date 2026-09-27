import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientRequests, inboxSnoozes, workItems } from '../../common/database/schema.js';
import type { InboxSnoozeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** The bundle object kinds a snooze can name — the inbox's two object bundles. */
export type SnoozeObjectType = 'work_item' | 'client_request';

/**
 * IN-01/IN-02's data half (x259) — a membership's inbox-bundle snoozes, and the tenant-scoped bundle
 * resolution the snooze write depends on.
 *
 * ## The resolution is the tenant boundary
 *
 * `bundle_id` carries no foreign key (the object it names lives in `work_items` or `client_requests`
 * per prefix), so a snooze's tenant safety is not an FK. It is that {@link resolveBundle} runs an
 * `organization_id = context.organizationId` predicate: a bundle whose object is in another tenant
 * simply does not resolve, so the service turns it into a 404 with no write, and a snooze can never
 * cite an object a different studio owns. The resolve also returns the object's `projectId`, which
 * the service authorises against so a snooze can only reference a bundle the caller can already reach
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION` §6) — the `home_pinned_items` posture (0050).
 *
 * ## Snoozes are private to a membership
 *
 * Every read, the upsert and the delete are scoped by `membership_id = context.membershipId`, so one
 * member never sees, moves or removes another's snoozes even inside the same tenant.
 */
export class InboxSnoozeRepository {
  /**
   * The `projectId` of the object this bundle names, if it exists in the acting tenant — otherwise
   * `undefined`. The tenant predicate is the boundary: a cross-tenant id does not resolve.
   */
  async resolveBundle(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectType: SnoozeObjectType,
    objectId: string,
  ): Promise<{ readonly projectId: string } | undefined> {
    const db = tenantDrizzle(runner);
    const table = objectType === 'work_item' ? workItems : clientRequests;
    const rows = await db
      .select({ projectId: table.projectId })
      .from(table)
      .where(and(eq(table.organizationId, context.organizationId), eq(table.id, objectId)))
      .limit(1);
    return rows[0];
  }

  /** The membership's existing snooze of this bundle, if any. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
  ): Promise<InboxSnoozeRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboxSnoozes)
      .where(
        and(
          eq(inboxSnoozes.organizationId, context.organizationId),
          eq(inboxSnoozes.membershipId, membershipId),
          eq(inboxSnoozes.bundleId, bundleId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Create or move this membership's snooze of one bundle. A single `INSERT ... ON DUPLICATE KEY
   * UPDATE` against `uq_inbox_snoozes_pin`, so a re-snooze moves `snoozed_until` in place rather than
   * creating a second row. The id and tenant come from here, never from input; the 0129 trigger pins
   * `(organization_id, membership_id, bundle_id)` at the engine on the update path.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
    snoozedUntil: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(inboxSnoozes)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        bundleId,
        snoozedUntil,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          snoozedUntil,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  /**
   * Delete the caller's own snooze of one bundle. Scoped by `membership_id = the acting membership`,
   * so a bundle another member snoozed (or one nobody snoozed) removes nothing and the service
   * answers 404 — a snooze is private, so its existence is never disclosed to a member it is not for.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bundleId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(inboxSnoozes)
      .where(
        and(
          eq(inboxSnoozes.organizationId, context.organizationId),
          eq(inboxSnoozes.membershipId, membershipId),
          eq(inboxSnoozes.bundleId, bundleId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Every snooze the acting membership holds in this tenant, by when it ends then id for a total,
   * deterministic order (the `ix_inbox_snoozes_org_membership` index's order).
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly InboxSnoozeRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(inboxSnoozes)
      .where(
        and(
          eq(inboxSnoozes.organizationId, context.organizationId),
          eq(inboxSnoozes.membershipId, membershipId),
        ),
      )
      .orderBy(asc(inboxSnoozes.snoozedUntil), asc(inboxSnoozes.id));
  }
}
