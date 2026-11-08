import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings, workItems } from '../../common/database/schema.js';
import type { MeetingRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { MY_DAY_STATES } from './my-day.repository.js';
import { isDoerOf } from '../work/work-item-assignees.repository.js';

/**
 * HOME-01's Pulse/Focus read half — the two tenant-scoped reads the Focus summary counts over.
 *
 * A distinct repository from {@link MyDayRepository}/{@link WaitingRepository} so this slice adds
 * no method to them and shares nothing they touch: it reads the acting user's own open work (for
 * the open-work and due-today counts) and the tenant's meetings that start inside a day window (for
 * the meetings-today count). Both reads carry the `organization_id` predicate — identical to the
 * sibling reads — so a cross-tenant row is never selected here; {@link HomePulseService} authorizes
 * each row again on top of it, and the work read is already narrowed to the acting user's own rows.
 */
export class HomePulseRepository {
  /**
   * Every open work item this user owns in this tenant, soft-deleted rows excluded.
   *
   * The same predicate and open-state set as {@link MyDayRepository.listOwnedOpen} — reusing
   * {@link MY_DAY_STATES} so "open work" means exactly what My Day means — over the org+owner index
   * (`ix_work_items_org_owner_state_due`). Read-only; the day-window test for due-today is applied
   * by {@link HomePulseService} over `now`, which is not a column.
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
          isDoerOf(context, ownerUserId), // C26: every doer, not only the lead
          inArray(workItems.state, [...MY_DAY_STATES]),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.id));
  }

  /**
   * Every meeting in this tenant that starts within `[from, to)`, oldest first then by id.
   *
   * Tenant scope is the `organization_id` predicate, and the half-open `starts_at` window is the
   * day the Focus summary counts (computed from `now` by {@link HomePulseService}); the predicate is
   * covered by `ix_meetings_org_project` on its leading `organization_id` column. The relation gate
   * — is the acting principal a reader of this meeting's project — is applied by
   * {@link HomePulseService} (`work.read` over the project, exactly as `MeetingsService.list`), so a
   * meeting in a project the caller cannot read never lifts the count even though it is in-window in
   * their tenant. A tenant's meetings-in-a-day set is bounded, so no page cursor for this read.
   */
  async listMeetingsInWindow(
    runner: TenantQueryRunner,
    context: TenantContext,
    from: Date,
    to: Date,
  ): Promise<readonly MeetingRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, context.organizationId),
          gte(meetings.startsAt, from),
          lt(meetings.startsAt, to),
        ),
      )
      .orderBy(asc(meetings.startsAt), asc(meetings.id));
  }
}
