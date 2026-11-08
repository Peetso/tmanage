import { and, asc, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  personAllocations,
  personCapacity,
  personTimeOff,
  projects,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Org-wide reads for the People capacity, time-off and allocations screens (A13). The per-person
 * endpoints (x170 capacity, x325 time off) and the per-project allocations endpoint (x171) answer one
 * person or one project at a time; these three reads give the screens one call each. Read-only, no
 * new table. Every statement binds every tenant table to `context.organizationId` (the tenant guard
 * throws on a missing predicate), and every read is bounded by {@link OVERVIEW_ROW_LIMIT}.
 */

/** The most rows one overview read returns: the screens page nothing, so the read is capped. */
export const OVERVIEW_ROW_LIMIT = 500;

export interface RosterRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly weeklyHours: number | null;
  readonly effectiveFrom: string | null;
}

export interface OverviewAllocationRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly membershipId: string;
  readonly displayName: string;
  readonly percent: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly status: string;
  readonly hoursPerWeek: number | null;
  readonly note: string | null;
}

export interface OverviewTimeOffRow {
  readonly id: string;
  readonly personUserId: string;
  readonly displayName: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly kind: string;
  readonly note: string | null;
}

/** An inclusive date window, both ends `YYYY-MM-DD`. */
export interface OverviewWindow {
  readonly from: string;
  readonly to: string;
}

export class PeopleOverviewRepository {
  /** Active members (never the hidden support role), by name, with their weekly capacity if set. */
  async roster(runner: TenantQueryRunner, context: TenantContext): Promise<RosterRow[]> {
    const org = context.organizationId;
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        weeklyHours: personCapacity.weeklyHours,
        effectiveFrom: personCapacity.effectiveFrom,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(
        personCapacity,
        and(
          eq(personCapacity.organizationId, org),
          eq(personCapacity.membershipId, memberships.id),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, org),
          eq(memberships.status, 'active'),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE),
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.id))
      .limit(OVERVIEW_ROW_LIMIT);
    return rows.map((row) => ({
      ...row,
      weeklyHours: row.weeklyHours === null ? null : Number(row.weeklyHours),
    }));
  }

  /** Every allocation overlapping the window (an open end overlaps), with project and person names. */
  async allocations(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: OverviewWindow,
  ): Promise<OverviewAllocationRow[]> {
    const org = context.organizationId;
    const rows = await tenantDrizzle(runner)
      .select({
        id: personAllocations.id,
        projectId: personAllocations.projectId,
        projectName: projects.name,
        membershipId: personAllocations.membershipId,
        displayName: users.displayName,
        percent: personAllocations.percent,
        startDate: personAllocations.startDate,
        endDate: personAllocations.endDate,
        status: personAllocations.status,
        hoursPerWeek: personAllocations.hoursPerWeek,
        note: personAllocations.note,
      })
      .from(personAllocations)
      .innerJoin(
        projects,
        and(eq(projects.organizationId, org), eq(projects.id, personAllocations.projectId)),
      )
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, org),
          eq(memberships.id, personAllocations.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(personAllocations.organizationId, org),
          or(isNull(personAllocations.startDate), lte(personAllocations.startDate, window.to)),
          or(isNull(personAllocations.endDate), gte(personAllocations.endDate, window.from)),
        ),
      )
      .orderBy(asc(users.displayName), asc(projects.name), asc(personAllocations.id))
      .limit(OVERVIEW_ROW_LIMIT);
    return rows.map((row) => ({
      ...row,
      percent: Number(row.percent),
      hoursPerWeek: row.hoursPerWeek === null ? null : Number(row.hoursPerWeek),
    }));
  }

  /** Every time-off entry overlapping the window, with the person's name, by start date. */
  async timeOff(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: OverviewWindow,
  ): Promise<OverviewTimeOffRow[]> {
    const org = context.organizationId;
    return tenantDrizzle(runner)
      .select({
        id: personTimeOff.id,
        personUserId: personTimeOff.personUserId,
        displayName: users.displayName,
        startsOn: personTimeOff.startsOn,
        endsOn: personTimeOff.endsOn,
        kind: personTimeOff.kind,
        note: personTimeOff.note,
      })
      .from(personTimeOff)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, org),
          eq(memberships.userId, personTimeOff.personUserId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(personTimeOff.organizationId, org),
          lte(personTimeOff.startsOn, window.to),
          gte(personTimeOff.endsOn, window.from),
        ),
      )
      .orderBy(asc(personTimeOff.startsOn), asc(personTimeOff.id))
      .limit(OVERVIEW_ROW_LIMIT);
  }
}
