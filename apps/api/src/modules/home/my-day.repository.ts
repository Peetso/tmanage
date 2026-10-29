import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
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

/**
 * H2 (L5 NFR-04 miss). The most rows one My Day read returns. The list is a "what needs you today"
 * view, not an archive: the screen shows three cards and a grouped list, and a user with thousands
 * of open items was answered every one of them (p95 3.2 s at ~3,300 rows). The hero counts are not
 * capped — {@link MyDayRepository.countOwnedOpen} counts every open item in SQL.
 */
export const MY_DAY_LIMIT = 100;

/** The columns a My Day card needs: every `WorkItemView` field except the long `description`. */
const MY_DAY_COLUMNS = {
  id: workItems.id,
  organizationId: workItems.organizationId,
  projectId: workItems.projectId,
  type: workItems.type,
  title: workItems.title,
  state: workItems.state,
  ownerUserId: workItems.ownerUserId,
  audience: workItems.audience,
  startAt: workItems.startAt,
  dueAt: workItems.dueAt,
  completedAt: workItems.completedAt,
  version: workItems.version,
  createdAt: workItems.createdAt,
  updatedAt: workItems.updatedAt,
  deletedAt: workItems.deletedAt,
  // platform-admin v2 · PA-03 (0245): the rest of the soft-delete columns.
  deletedByUserId: workItems.deletedByUserId,
  deletedReason: workItems.deletedReason,
  purgeAfter: workItems.purgeAfter,
} as const;

/** One count group: open items of one project and audience (the two facts `work.read` needs). */
export interface MyDayCountRow {
  readonly projectId: string;
  readonly audience: WorkItemRow['audience'];
  readonly total: number;
  readonly overdue: number;
  readonly dueSoon: number;
}

export interface MyDayWindow {
  /** The instant "overdue" is measured against. */
  readonly now: Date;
  /** The last instant that still reads as due soon (`now` + the due-soon window). */
  readonly dueSoonCutoff: Date;
  /** The bound on rows returned; defaults to {@link MY_DAY_LIMIT}. */
  readonly limit?: number;
}

export class MyDayRepository {
  /**
   * The acting user's open work in My-Day order, bounded, soft-deleted rows excluded.
   *
   * Two bounded reads over `ix_work_items_org_owner_state_due`: first every dated item due by the
   * due-soon cutoff (overdue and due-soon, `due_at` then `id` — exactly the rank order), then, if
   * room is left, the rest by `id` (undated or due later — the "assigned" group's order). The
   * ranking reason is still applied by {@link HomeService} over `now`. `description` is not read:
   * a card never shows it, and it was most of the bytes.
   */
  async listOwnedOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserId: string,
    window: MyDayWindow,
  ): Promise<readonly WorkItemRow[]> {
    const limit = window.limit ?? MY_DAY_LIMIT;
    const db = tenantDrizzle(runner);
    const owned = and(
      eq(workItems.organizationId, context.organizationId),
      eq(workItems.ownerUserId, ownerUserId),
      inArray(workItems.state, [...MY_DAY_STATES]),
      isNull(workItems.deletedAt),
    );
    const pressing = await db
      .select(MY_DAY_COLUMNS)
      .from(workItems)
      .where(and(owned, lte(workItems.dueAt, window.dueSoonCutoff)))
      .orderBy(asc(workItems.dueAt), asc(workItems.id))
      .limit(limit);
    const rest =
      pressing.length >= limit
        ? []
        : await db
            .select(MY_DAY_COLUMNS)
            .from(workItems)
            .where(
              and(owned, or(isNull(workItems.dueAt), gt(workItems.dueAt, window.dueSoonCutoff))),
            )
            .orderBy(asc(workItems.id))
            .limit(limit - pressing.length);
    return [...pressing, ...rest].map((row) => ({ ...row, description: null }));
  }

  /**
   * HOME-01's personal-work counts over EVERY open owned item (not the bounded list), grouped by
   * the two columns `work.read` decides on, so the service can authorize each group exactly as it
   * authorizes a row. Overdue is `due_at < now`; due soon is `now <= due_at <= cutoff` — the same
   * boundaries `reasonFor` applies.
   */
  async countOwnedOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserId: string,
    window: MyDayWindow,
  ): Promise<readonly MyDayCountRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: workItems.projectId,
        audience: workItems.audience,
        total: sql<string>`count(*)`,
        // The comparisons go through drizzle's operators so the instants are bound with the
        // column's own encoder (UTC `DATETIME(3)` text), exactly as every other predicate here.
        overdue: sql<string>`sum(case when ${lt(workItems.dueAt, window.now)} then 1 else 0 end)`,
        dueSoon: sql<string>`sum(case when ${and(gte(workItems.dueAt, window.now), lte(workItems.dueAt, window.dueSoonCutoff))} then 1 else 0 end)`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.ownerUserId, ownerUserId),
          inArray(workItems.state, [...MY_DAY_STATES]),
          isNull(workItems.deletedAt),
        ),
      )
      .groupBy(workItems.projectId, workItems.audience);
    return rows.map((row) => ({
      projectId: row.projectId,
      audience: row.audience,
      total: Number(row.total),
      overdue: Number(row.overdue ?? 0),
      dueSoon: Number(row.dueSoon ?? 0),
    }));
  }
}
