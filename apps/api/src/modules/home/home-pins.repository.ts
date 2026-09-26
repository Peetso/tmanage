import { and, asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documents, homePinnedItems, projects, workItems } from '../../common/database/schema.js';
import type { HomePinnedItemRow, HomePinTargetKind } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * HOME-05 follow-up's data half — a membership's Home pins, and the tenant-scoped target resolution
 * the pin write depends on.
 *
 * ## The resolution is the tenant boundary
 *
 * `target_id` carries no foreign key (the target table depends on `target_kind`), so a pin's tenant
 * safety is not an FK. It is that {@link resolveTarget} runs an `organization_id = context.
 * organizationId` predicate: a target in another tenant simply does not resolve, so the service
 * turns it into a 404 with no write, and a pin can never cite a row a different studio owns. The
 * resolve also returns the target's `projectId`, which the service authorises against so a pin can
 * only reference a target the caller can already reach (`25-AUTH-AND-TENANT-ISOLATION` §6).
 *
 * ## Pins are private to a membership
 *
 * Every read and the unpin are scoped by `membership_id = context.membershipId`, so one member never
 * sees or removes another's pins even inside the same tenant — the own-principal substance.
 */
export class HomePinsRepository {
  /**
   * The `projectId` of the target this pin names, if it exists in the acting tenant — otherwise
   * `undefined`. A `project` target is its own project; a `work` or `document` target carries a
   * `project_id`. The tenant predicate is the boundary: a cross-tenant id does not resolve.
   */
  async resolveTarget(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetKind: HomePinTargetKind,
    targetId: string,
  ): Promise<{ readonly projectId: string } | undefined> {
    const db = tenantDrizzle(runner);
    if (targetKind === 'project') {
      const rows = await db
        .select({ projectId: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, targetId)))
        .limit(1);
      return rows[0];
    }

    const table = targetKind === 'work' ? workItems : documents;
    const rows = await db
      .select({ projectId: table.projectId })
      .from(table)
      .where(and(eq(table.organizationId, context.organizationId), eq(table.id, targetId)))
      .limit(1);
    return rows[0];
  }

  /** The membership's existing pin of this target, if any — the duplicate probe. */
  async findPin(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    targetKind: HomePinTargetKind,
    targetId: string,
  ): Promise<HomePinnedItemRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(homePinnedItems)
      .where(
        and(
          eq(homePinnedItems.organizationId, context.organizationId),
          eq(homePinnedItems.membershipId, membershipId),
          eq(homePinnedItems.targetKind, targetKind),
          eq(homePinnedItems.targetId, targetId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Insert one pin for the acting membership. The id and tenant come from here, never from input. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly membershipId: string;
      readonly targetKind: HomePinTargetKind;
      readonly targetId: string;
    },
  ): Promise<HomePinnedItemRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(homePinnedItems)
      .values({
        id,
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        createdAt: sql`current_timestamp(3)`,
      });
    const row = await this.findPin(
      runner,
      context,
      input.membershipId,
      input.targetKind,
      input.targetId,
    );
    if (!row) throw new Error('home_pinned_items row vanished immediately after insert');
    return row;
  }

  /**
   * Delete the caller's own pin by id. Scoped by `membership_id = the acting membership`, so an id
   * that names another member's pin (or no pin) removes nothing and the service answers 404 — a pin
   * is private, so its existence is never disclosed to a member it does not belong to.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(homePinnedItems)
      .where(
        and(
          eq(homePinnedItems.organizationId, context.organizationId),
          eq(homePinnedItems.membershipId, membershipId),
          eq(homePinnedItems.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Every pin the acting membership holds in this tenant, newest first with id breaking ties for a
   * total, deterministic order (the `ix_home_pinned_items_org_membership` index's order).
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly HomePinnedItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(homePinnedItems)
      .where(
        and(
          eq(homePinnedItems.organizationId, context.organizationId),
          eq(homePinnedItems.membershipId, membershipId),
        ),
      )
      .orderBy(desc(homePinnedItems.createdAt), asc(homePinnedItems.id));
  }
}
