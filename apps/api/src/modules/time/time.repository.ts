import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  orgFinanceProfiles,
  orgPolicies,
  projects,
  timeTimers,
  workItems,
} from '../../common/database/schema.js';
import type { TimeTimerRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { parseTimePolicy } from './time-rules.js';
import type { TimePolicy } from './time-rules.js';

/**
 * 52-01 — storage for the running timer (`time_timers`, 0265) and the org settings the timer reads
 * (rounding from `org_finance_profiles`, auto-stop and presence from `org_policies`). Every
 * statement carries the `organization_id` from the caller's context; no input type names an
 * organization or a person. The entries themselves are written by `WorkTimeLogsRepository`.
 */

/** Presence answers at most this many running timers. */
export const MAX_ACTIVE_TIMERS = 200;

export interface NewTimer {
  readonly membershipId: string;
  readonly userId: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
  readonly billable: boolean;
  readonly startedAt: Date;
}

export class TimeRepository {
  /** The membership's running timer, locked FOR UPDATE inside a transaction when asked. */
  async findTimer(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    lock = false,
  ): Promise<TimeTimerRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(timeTimers)
      .where(
        and(
          eq(timeTimers.organizationId, context.organizationId),
          eq(timeTimers.membershipId, membershipId),
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insertTimer(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewTimer,
  ): Promise<TimeTimerRow> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(timeTimers).values({
      id,
      organizationId: context.organizationId,
      membershipId: input.membershipId,
      userId: input.userId,
      workItemId: input.workItemId,
      projectId: input.projectId,
      note: input.note,
      billable: input.billable,
      startedAt: input.startedAt,
      lastHeartbeatAt: input.startedAt,
      createdAt: input.startedAt,
    });
    const row = await this.findTimer(runner, context, input.membershipId);
    if (!row) throw new Error('timer vanished immediately after insert');
    return row;
  }

  /** Remove one timer by id; the count tells a concurrent stop that it lost. */
  async deleteTimer(
    runner: TenantQueryRunner,
    context: TenantContext,
    timerId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(timeTimers)
      .where(
        and(eq(timeTimers.organizationId, context.organizationId), eq(timeTimers.id, timerId)),
      );
    return result[0].affectedRows;
  }

  async touchHeartbeat(
    runner: TenantQueryRunner,
    context: TenantContext,
    timerId: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(timeTimers)
      .set({ lastHeartbeatAt: at })
      .where(
        and(eq(timeTimers.organizationId, context.organizationId), eq(timeTimers.id, timerId)),
      );
  }

  /** Running timers in the organization, optionally on one project, oldest first, bounded. */
  async listRunning(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
  ): Promise<readonly TimeTimerRow[]> {
    const scope = eq(timeTimers.organizationId, context.organizationId);
    return tenantDrizzle(runner)
      .select()
      .from(timeTimers)
      .where(projectId === null ? scope : and(scope, eq(timeTimers.projectId, projectId)))
      .orderBy(asc(timeTimers.startedAt), asc(timeTimers.id))
      .limit(MAX_ACTIVE_TIMERS);
  }

  /** Whether a project id names a live project of this tenant. */
  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  /** Whether the work item row still exists (a purged item drops out of the entry). */
  async workItemExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(eq(workItems.organizationId, context.organizationId), eq(workItems.id, workItemId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** `org_finance_profiles.rounding_minutes`, or `null` before the first finance save. */
  async roundingMinutes(runner: TenantQueryRunner, context: TenantContext): Promise<number | null> {
    const rows = await tenantDrizzle(runner)
      .select({ roundingMinutes: orgFinanceProfiles.roundingMinutes })
      .from(orgFinanceProfiles)
      .where(eq(orgFinanceProfiles.organizationId, context.organizationId))
      .limit(1);
    return rows[0]?.roundingMinutes ?? null;
  }

  /** The time keys of the organization's policy document (defaults when there is none). */
  async timePolicy(runner: TenantQueryRunner, context: TenantContext): Promise<TimePolicy> {
    const rows = await tenantDrizzle(runner)
      .select({ policy: sql<unknown>`${orgPolicies.policyJson}` })
      .from(orgPolicies)
      .where(eq(orgPolicies.organizationId, context.organizationId))
      .limit(1);
    return parseTimePolicy(rows[0]?.policy ?? null);
  }
}
