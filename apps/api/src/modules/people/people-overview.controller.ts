import { Controller, Get, Inject, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PeopleOverviewRepository } from './people-overview.repository.js';
import type {
  OverviewAllocationRow,
  OverviewTimeOffRow,
  OverviewWindow,
} from './people-overview.repository.js';

/**
 * People overview (A13): the org-wide reads behind `/people/capacity`, `/people/time-off` and
 * `/people/allocations`. Writes stay on the existing per-person and per-project endpoints (capacity
 * PUT under `project.manage`, time-off POST/DELETE under `org.manage`, allocations under
 * `project.manage`), so this controller adds no write and no new capability.
 *
 * Every route sits behind `work.read` (internal-only; no client role holds it) and then the org-scoped
 * deny-by-default `authorize()` the route guard cannot make. The allocations list is narrowed further
 * per project: a member without organization-wide scope sees only allocations on projects
 * `authorize()` lets them read, the same relation check the per-project list makes.
 *
 * The static `people/capacity`, `people/time-off` and `people/allocations` paths win over the
 * parametric `people/:membershipId` profile route in the router, so they never reach it.
 */

/** One member's row on the capacity screen. No `organizationId`: the tenant id is never echoed. */
export interface CapacityRosterEntry {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  /** Null when no capacity has been set for the member. */
  readonly weeklyHours: number | null;
  readonly effectiveFrom: string | null;
  /** Sum of confirmed allocation percents overlapping the current week. */
  readonly allocatedPercent: number;
  /** Sum of tentative allocation percents overlapping the current week. */
  readonly tentativePercent: number;
  /** True when a time-off entry overlaps the current week. */
  readonly awayThisWeek: boolean;
}

export interface CapacityRoster {
  /** The Monday and Sunday of the current week, `YYYY-MM-DD`. */
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly members: readonly CapacityRosterEntry[];
}

export type OverviewAllocation = OverviewAllocationRow;
export type OverviewTimeOff = OverviewTimeOffRow;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The default list window: today and the next 90 days. */
export const DEFAULT_WINDOW_DAYS = 90;
/** The widest window a caller may ask for, so a read can never become an unbounded scan. */
export const MAX_WINDOW_DAYS = 366;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Monday-to-Sunday week (UTC) containing `now`. */
export function currentWeek(now: Date): OverviewWindow {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = utc - ((new Date(utc).getUTCDay() + 6) % 7) * MS_PER_DAY;
  return { from: isoDay(monday), to: isoDay(monday + 6 * MS_PER_DAY) };
}

/**
 * Parse the optional `?from&to` window. Neither: today plus {@link DEFAULT_WINDOW_DAYS}. Both: two
 * ISO dates with `from <= to` and at most {@link MAX_WINDOW_DAYS} apart. Anything else is a 400 with
 * no read.
 */
export function parseWindow(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): OverviewWindow {
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';
  if (!hasFrom && !hasTo) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { from: isoDay(today), to: isoDay(today + DEFAULT_WINDOW_DAYS * MS_PER_DAY) };
  }
  const invalid = (field: string, message: string): ApiError =>
    new ApiError(400, 'validation_failed', 'The date window is invalid', [{ field, message }]);
  if (!hasFrom || !ISO_DATE.test(from as string)) {
    throw invalid('from', 'must be an ISO-8601 date (YYYY-MM-DD), given together with to');
  }
  if (!hasTo || !ISO_DATE.test(to as string)) {
    throw invalid('to', 'must be an ISO-8601 date (YYYY-MM-DD), given together with from');
  }
  const start = Date.parse(`${from as string}T00:00:00Z`);
  const end = Date.parse(`${to as string}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw invalid('to', 'must be a real date on or after from');
  }
  if ((end - start) / MS_PER_DAY > MAX_WINDOW_DAYS) {
    throw invalid('to', `must be at most ${MAX_WINDOW_DAYS} days after from`);
  }
  return { from: from as string, to: to as string };
}

/** Fold the week's allocations and time off into the roster rows. Pure. */
export function foldRoster(
  roster: readonly {
    membershipId: string;
    userId: string;
    displayName: string;
    weeklyHours: number | null;
    effectiveFrom: string | null;
  }[],
  allocations: readonly Pick<OverviewAllocationRow, 'membershipId' | 'percent' | 'status'>[],
  timeOff: readonly Pick<OverviewTimeOffRow, 'personUserId'>[],
): CapacityRosterEntry[] {
  const away = new Set(timeOff.map((entry) => entry.personUserId));
  return roster.map((member) => {
    let allocatedPercent = 0;
    let tentativePercent = 0;
    for (const allocation of allocations) {
      if (allocation.membershipId !== member.membershipId) continue;
      if (allocation.status === 'tentative') tentativePercent += allocation.percent;
      else allocatedPercent += allocation.percent;
    }
    return { ...member, allocatedPercent, tentativePercent, awayThisWeek: away.has(member.userId) };
  });
}

function mayRead(principal: Principal, context: TenantContext, projectId: string | null): boolean {
  return authorize({
    principal,
    capability: 'work.read',
    resource: {
      organizationId: context.organizationId,
      projectId,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
}

function requireOrgRead(principal: Principal, context: TenantContext): void {
  if (!mayRead(principal, context, null)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'people_overview_denied');
  }
}

@Controller('v1/organizations/:orgSlug/people')
export class PeopleOverviewController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PeopleOverviewRepository) private readonly repository: PeopleOverviewRepository,
  ) {}

  @Get('capacity')
  @RequireCapability('work.read')
  async capacity(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CapacityRoster> {
    requireOrgRead(principal, context);
    const week = currentWeek(new Date());
    const { roster, allocations, timeOff } = await this.database.read(context, async (runner) => ({
      roster: await this.repository.roster(runner, context),
      allocations: await this.repository.allocations(runner, context, week),
      timeOff: await this.repository.timeOff(runner, context, week),
    }));
    return {
      weekStart: week.from,
      weekEnd: week.to,
      members: foldRoster(roster, allocations, timeOff),
    };
  }

  @Get('time-off')
  @RequireCapability('work.read')
  async timeOff(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ readonly from: string; readonly to: string; readonly entries: OverviewTimeOff[] }> {
    const window = parseWindow(from, to, new Date());
    requireOrgRead(principal, context);
    const entries = await this.database.read(context, (runner) =>
      this.repository.timeOff(runner, context, window),
    );
    return { ...window, entries };
  }

  @Get('allocations')
  @RequireCapability('work.read')
  async allocations(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{
    readonly from: string;
    readonly to: string;
    readonly allocations: OverviewAllocation[];
  }> {
    const window = parseWindow(from, to, new Date());
    requireOrgRead(principal, context);
    const rows = await this.database.read(context, (runner) =>
      this.repository.allocations(runner, context, window),
    );
    const visible = new Map<string, boolean>();
    const allocations = rows.filter((row) => {
      let allowed = visible.get(row.projectId);
      if (allowed === undefined) {
        allowed = mayRead(principal, context, row.projectId);
        visible.set(row.projectId, allowed);
      }
      return allowed;
    });
    return { ...window, allocations };
  }
}
