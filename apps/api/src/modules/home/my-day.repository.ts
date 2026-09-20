import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItems } from '../../common/database/schema.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * HOME-03's read half — the acting user's own open work across every project, read-only.
 *
 * ## Why this lives here and not in the work module
 *
 * The work list read (`WorkItemsRepository.list`) filters by `projectId`/`state`/`audience`
 * but never by owner, and slice x88 is editing that repository. To stay disjoint from it, the
 * My Day read is its own repository against the same `work_items` table — it adds no method to
 * the work module and shares nothing that x88 touches.
 *
 * ## The predicate is exactly the org+owner index
 *
 * The query filters `organization_id` + `owner_user_id` + an open-state set, which is what
 * `ix_work_items_org_owner_state_due` (`organization_id, owner_user_id, state, due_at`) covers.
 * Tenant scope is the `organization_id` predicate — identical to the sibling work reads — so a
 * cross-tenant row is never selected here; the service authorizes each row again on top of it.
 */

/**
 * The states a My Day list shows: open work only. `done` and `archived` are landed work — they
 * are not "what needs you today", and a `done` item with a past `due_at` would otherwise rank
 * as overdue. Kept as a filter (not a `NOT IN`) so the third index column is used.
 */
export const MY_DAY_STATES: readonly WorkItemState[] = WORK_ITEM_STATES.filter(
  (state) => state !== 'done' && state !== 'archived',
);

export class MyDayRepository {
  /**
   * Every open work item this user owns in this tenant, soft-deleted rows excluded.
   *
   * Ordered by `due_at` then `id` for a stable read; the ranking reason and My-Day order are
   * applied by {@link HomeService} over `now`, which is not a column. Read-only — no page cursor
   * for this first slice; a user's own open work is bounded, and paging is the HOME follow-up.
   */
  async listOwnedOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserId: string,
  ): Promise<readonly WorkItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.ownerUserId, ownerUserId),
          inArray(workItems.state, [...MY_DAY_STATES]),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.dueAt), asc(workItems.id));
  }
}
