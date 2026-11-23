import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientOrganizations,
  projectClients,
  retainerPeriods,
  retainerProjects,
  retainers,
  timePeriodLocks,
  workItemTimeLogs,
  workItems,
} from '../../common/database/schema.js';
import type { RetainerPeriodRow, RetainerRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-06 — storage for `retainers`, `retainer_projects`, `retainer_periods` (0299) and the reads
 * around them (client links, time-log SUMs, 52-03 locks). Every statement carries the
 * `organization_id` predicate; another organization's row is simply absent. No policy here.
 */

export type RetainerChange = Partial<
  Omit<RetainerRow, 'id' | 'organizationId' | 'clientOrganizationId' | 'createdBy' | 'createdAt'>
>;

export interface RetainerEntryRow {
  readonly id: string;
  readonly spentOn: string;
  readonly minutes: number;
  readonly loggedBy: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly audience: string | null;
  readonly itemDeleted: boolean;
  /** 2026-11-23 time trust: typed in or corrected, not measured by the timer. */
  readonly addedByHand: boolean;
}

export interface LockRow {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unlockedAt: Date | null;
}

export class RetainersRepository {
  async clientExists(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: clientOrganizations.id })
      .from(clientOrganizations)
      .where(
        and(
          eq(clientOrganizations.organizationId, organizationId),
          eq(clientOrganizations.id, clientOrganizationId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The projects shared with this client organization (`project_clients`). */
  async clientProjectIds(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: projectClients.projectId })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, organizationId),
          eq(projectClients.clientOrganizationId, clientOrganizationId),
        ),
      )
      .orderBy(asc(projectClients.projectId))
      .limit(500);
    return rows.map((r) => r.projectId);
  }

  async insert(runner: TenantQueryRunner, row: RetainerRow): Promise<void> {
    await tenantDrizzle(runner).insert(retainers).values(row);
  }

  async find(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<RetainerRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(retainers)
      .where(and(eq(retainers.organizationId, organizationId), eq(retainers.id, id)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    change: RetainerChange,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(retainers)
      .set(change)
      .where(and(eq(retainers.organizationId, organizationId), eq(retainers.id, id)));
  }

  /** A client's retainers, newest first (ids are UUIDv7). */
  async listForClient(
    runner: TenantQueryRunner,
    organizationId: string,
    clientOrganizationId: string,
    clientVisibleOnly = false,
  ): Promise<readonly RetainerRow[]> {
    const predicates = [
      eq(retainers.organizationId, organizationId),
      eq(retainers.clientOrganizationId, clientOrganizationId),
    ];
    if (clientVisibleOnly) predicates.push(eq(retainers.clientVisible, true));
    return tenantDrizzle(runner)
      .select()
      .from(retainers)
      .where(and(...predicates))
      .orderBy(desc(retainers.id))
      .limit(200);
  }

  /** The covered project ids of each retainer. */
  async projectsOf(
    runner: TenantQueryRunner,
    organizationId: string,
    retainerIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const out = new Map<string, string[]>();
    if (retainerIds.length === 0) return out;
    const rows = await tenantDrizzle(runner)
      .select({ retainerId: retainerProjects.retainerId, projectId: retainerProjects.projectId })
      .from(retainerProjects)
      .where(
        and(
          eq(retainerProjects.organizationId, organizationId),
          inArray(retainerProjects.retainerId, [...retainerIds]),
        ),
      )
      .orderBy(asc(retainerProjects.projectId));
    for (const row of rows) {
      const list = out.get(row.retainerId) ?? [];
      list.push(row.projectId);
      out.set(row.retainerId, list);
    }
    return out;
  }

  /**
   * Of `projectIds`, those another not-ended retainer covers. The cover rows are read FOR UPDATE
   * (next-key locks on `ix_retainer_projects_project`), so two racing saves serialise here.
   */
  async coveredElsewhere(
    runner: TenantQueryRunner,
    organizationId: string,
    projectIds: readonly string[],
    exceptRetainerId: string | null,
  ): Promise<readonly string[]> {
    if (projectIds.length === 0) return [];
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(retainerProjects.organizationId, organizationId),
      inArray(retainerProjects.projectId, [...projectIds]),
    ];
    if (exceptRetainerId !== null)
      predicates.push(ne(retainerProjects.retainerId, exceptRetainerId));
    const covers = await db
      .select({ retainerId: retainerProjects.retainerId, projectId: retainerProjects.projectId })
      .from(retainerProjects)
      .where(and(...predicates))
      .for('update');
    if (covers.length === 0) return [];
    const live = await db
      .select({ id: retainers.id })
      .from(retainers)
      .where(
        and(
          eq(retainers.organizationId, organizationId),
          inArray(retainers.id, [...new Set(covers.map((c) => c.retainerId))]),
          ne(retainers.state, 'ended'),
        ),
      );
    const liveIds = new Set(live.map((r) => r.id));
    return [...new Set(covers.filter((c) => liveIds.has(c.retainerId)).map((c) => c.projectId))];
  }

  async replaceProjects(
    runner: TenantQueryRunner,
    organizationId: string,
    retainerId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(retainerProjects)
      .where(
        and(
          eq(retainerProjects.organizationId, organizationId),
          eq(retainerProjects.retainerId, retainerId),
        ),
      );
    if (projectIds.length === 0) return;
    await db
      .insert(retainerProjects)
      .values(
        projectIds.map((projectId) => ({ id: uuidv7(), organizationId, retainerId, projectId })),
      );
  }

  async insertPeriod(runner: TenantQueryRunner, row: RetainerPeriodRow): Promise<void> {
    await tenantDrizzle(runner).insert(retainerPeriods).values(row);
  }

  /** Newest first. */
  async periods(
    runner: TenantQueryRunner,
    organizationId: string,
    retainerId: string,
    limit: number,
  ): Promise<readonly RetainerPeriodRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(retainerPeriods)
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainerPeriods.retainerId, retainerId),
        ),
      )
      .orderBy(desc(retainerPeriods.periodStart))
      .limit(limit);
  }

  async findPeriod(
    runner: TenantQueryRunner,
    organizationId: string,
    retainerId: string,
    periodId: string,
  ): Promise<RetainerPeriodRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(retainerPeriods)
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainerPeriods.retainerId, retainerId),
          eq(retainerPeriods.id, periodId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** An hours edit moves the open period's allowance with it (closed periods are history). */
  async setOpenAllowance(
    runner: TenantQueryRunner,
    organizationId: string,
    retainerId: string,
    allowanceMinutes: number,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(retainerPeriods)
      .set({ allowanceMinutes })
      .where(
        and(
          eq(retainerPeriods.organizationId, organizationId),
          eq(retainerPeriods.retainerId, retainerId),
          eq(retainerPeriods.state, 'open'),
        ),
      );
  }

  /**
   * Read-time attribution: every minute logged on the covered projects with `spent_on` inside the
   * period (both ends inclusive). Uses `ix_witl_project_day`. The worker runs the same SUM.
   */
  async usedMinutes(
    runner: TenantQueryRunner,
    organizationId: string,
    projectIds: readonly string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<number> {
    if (projectIds.length === 0) return 0;
    const rows = await tenantDrizzle(runner)
      .select({ used: sql<string | number | null>`COALESCE(SUM(${workItemTimeLogs.minutes}), 0)` })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, organizationId),
          inArray(workItemTimeLogs.projectId, [...projectIds]),
          gte(workItemTimeLogs.spentOn, periodStart),
          lte(workItemTimeLogs.spentOn, periodEnd),
          // 0410 time trust: only the minutes that count (no waiting, refused or replaced time).
          eq(workItemTimeLogs.counted, true),
        ),
      );
    return Number(rows[0]?.used ?? 0);
  }

  /** Open 52-03 locks overlapping the window. */
  async locksOverlapping(
    runner: TenantQueryRunner,
    organizationId: string,
    from: string,
    to: string,
  ): Promise<readonly LockRow[]> {
    return tenantDrizzle(runner)
      .select({
        periodStart: timePeriodLocks.periodStart,
        periodEnd: timePeriodLocks.periodEnd,
        unlockedAt: timePeriodLocks.unlockedAt,
      })
      .from(timePeriodLocks)
      .where(
        and(
          eq(timePeriodLocks.organizationId, organizationId),
          lte(timePeriodLocks.periodStart, to),
          gte(timePeriodLocks.periodEnd, from),
          isNull(timePeriodLocks.unlockedAt),
        ),
      )
      .limit(500);
  }

  /** The entries attributed to a period, newest id first, with the item's title and audience. */
  async entries(
    runner: TenantQueryRunner,
    organizationId: string,
    projectIds: readonly string[],
    periodStart: string,
    periodEnd: string,
    cursor: string | null,
    limit: number,
  ): Promise<readonly RetainerEntryRow[]> {
    if (projectIds.length === 0) return [];
    const predicates = [
      eq(workItemTimeLogs.organizationId, organizationId),
      inArray(workItemTimeLogs.projectId, [...projectIds]),
      gte(workItemTimeLogs.spentOn, periodStart),
      lte(workItemTimeLogs.spentOn, periodEnd),
      eq(workItemTimeLogs.counted, true),
    ];
    if (cursor !== null) predicates.push(lt(workItemTimeLogs.id, cursor));
    const rows = await tenantDrizzle(runner)
      .select({
        id: workItemTimeLogs.id,
        spentOn: workItemTimeLogs.spentOn,
        minutes: workItemTimeLogs.minutes,
        loggedBy: workItemTimeLogs.loggedBy,
        projectId: workItemTimeLogs.projectId,
        source: workItemTimeLogs.source,
        title: workItems.title,
        audience: workItems.audience,
        deletedAt: workItems.deletedAt,
      })
      .from(workItemTimeLogs)
      .leftJoin(
        workItems,
        and(
          eq(workItems.organizationId, organizationId),
          eq(workItems.id, workItemTimeLogs.workItemId),
        ),
      )
      .where(and(...predicates))
      .orderBy(desc(workItemTimeLogs.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      spentOn: r.spentOn,
      minutes: Number(r.minutes),
      loggedBy: r.loggedBy,
      projectId: r.projectId,
      title: r.title ?? null,
      audience: r.audience ?? null,
      itemDeleted: r.deletedAt != null,
      addedByHand: r.source === 'manual' || r.source === 'correction',
    }));
  }
}
