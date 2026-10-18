import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberProfiles,
  memberships,
  personAllocations,
  personCapacity,
  projects,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { CLOSED_STATES } from './portfolio.repository.js';

/**
 * POR-03 (portfolio capacity) reads. No table of its own: weekly capacity (x170), allocations
 * (x171) and the member profile's `department` (x216) give the by-discipline load; unowned open work
 * gives the unstaffed commitments. Every statement carries the acting tenant's predicate, and every
 * join an `organization_id` equality, so the guard sees the tenant reach every tenant table. Work-item
 * reads take the caller's visible-project allowlist and short-circuit on an empty one.
 */

export interface CapacityMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly weeklyHours: number;
  /** `'YYYY-MM-DD'` the capacity figure takes effect. */
  readonly effectiveFrom: string;
  /** The member's discipline (`member_profiles.department`), or `null` when none is set. */
  readonly department: string | null;
}

export interface CapacityAllocationRow {
  readonly membershipId: string;
  readonly percent: number;
}

export interface UnstaffedWorkRow {
  readonly workItemId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly dueAt: Date | null;
}

export interface WeekWorkRow {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly audience: string;
}

export const UNSTAFFED_SHOWN = 3;

export class PortfolioCapacityRepository {
  /** Active members with a capacity row, with their discipline. */
  async members(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly CapacityMemberRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: personCapacity.membershipId,
        userId: memberships.userId,
        weeklyHours: personCapacity.weeklyHours,
        effectiveFrom: personCapacity.effectiveFrom,
        department: memberProfiles.department,
      })
      .from(personCapacity)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, personCapacity.organizationId),
          eq(memberships.id, personCapacity.membershipId),
        ),
      )
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.organizationId, memberships.organizationId),
          eq(memberProfiles.userId, memberships.userId),
        ),
      )
      .where(
        and(
          eq(personCapacity.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      )
      .orderBy(asc(personCapacity.membershipId));
    return rows.map((row) => ({
      ...row,
      weeklyHours: Number(row.weeklyHours),
      department: row.department?.trim() ? row.department.trim() : null,
    }));
  }

  /** Allocations whose `[start_date, end_date]` window overlaps `[weekStart, weekEnd]`. */
  async allocations(
    runner: TenantQueryRunner,
    context: TenantContext,
    weekStart: string,
    weekEnd: string,
  ): Promise<readonly CapacityAllocationRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({ membershipId: personAllocations.membershipId, percent: personAllocations.percent })
      .from(personAllocations)
      .where(
        and(
          eq(personAllocations.organizationId, context.organizationId),
          or(isNull(personAllocations.startDate), lte(personAllocations.startDate, weekEnd)),
          or(isNull(personAllocations.endDate), gte(personAllocations.endDate, weekStart)),
        ),
      );
    return rows.map((row) => ({ membershipId: row.membershipId, percent: Number(row.percent) }));
  }

  /** Open, unowned work in the visible projects: the total, and the first few by due date. */
  async unstaffed(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<{ readonly total: number; readonly items: readonly UnstaffedWorkRow[] }> {
    if (projectIds.length === 0) return { total: 0, items: [] };
    const db = tenantDrizzle(runner);
    const where = and(
      eq(workItems.organizationId, context.organizationId),
      inArray(workItems.projectId, [...projectIds]),
      isNull(workItems.ownerUserId),
      isNull(workItems.deletedAt),
      notInArray(workItems.state, [...CLOSED_STATES]),
    );
    const [totals] = await db.select({ total: count() }).from(workItems).where(where);
    const items = await db
      .select({
        workItemId: workItems.id,
        title: workItems.title,
        projectId: workItems.projectId,
        projectName: projects.name,
        dueAt: workItems.dueAt,
      })
      .from(workItems)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, workItems.organizationId),
          eq(projects.id, workItems.projectId),
        ),
      )
      .where(where)
      .orderBy(sql`${workItems.dueAt} is null`, asc(workItems.dueAt), asc(workItems.id))
      .limit(UNSTAFFED_SHOWN);
    return { total: Number(totals?.total ?? 0), items };
  }

  /** Open, owned work in the visible projects due inside `[from, to)`. */
  async weekWork(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<readonly WeekWorkRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        ownerUserId: workItems.ownerUserId,
        projectId: workItems.projectId,
        audience: workItems.audience,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          inArray(workItems.projectId, [...projectIds]),
          isNotNull(workItems.ownerUserId),
          isNull(workItems.deletedAt),
          notInArray(workItems.state, [...CLOSED_STATES]),
          gte(workItems.dueAt, from),
          lt(workItems.dueAt, to),
        ),
      );
    return rows.flatMap((row) =>
      row.ownerUserId ? [{ ...row, ownerUserId: row.ownerUserId }] : [],
    );
  }
}
