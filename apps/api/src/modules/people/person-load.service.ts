import { authorize, localDateOf } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { PersonLoadRepository } from './person-load.repository.js';
import { buildPersonLoad, weekBuckets } from './workload-hours.js';
import type { LoadAllocation, LoadItem, PersonLoadWeek } from './workload-hours.js';

/**
 * 53-08 (R20-b) — one person's load per week, computed server-side for the reader.
 *
 * Gate: `work.read` on the route (`people.view` is not a capability key; the capacity heatmap reads
 * the same way), plus the org-scoped `authorize()` here — a client principal is a 403. The member is
 * resolved tenant-scoped first (unknown or cross-tenant → 404). Each work item and allocation is
 * judged with the same per-row `work.read` check the work views apply: what the reader may read is
 * itemised by project; everything else only adds to `otherProjectsHours` (no project id, no title).
 * The window is validated (≤ 26 weeks) before any read. Hours only — no score, no ranking.
 */

export interface PersonLoadView {
  readonly membershipId: string;
  /** The first bucket's Monday. */
  readonly from: string;
  readonly to: string;
  readonly weeks: readonly PersonLoadWeek[];
}

const MS_PER_DAY = 86_400_000;

export class PersonLoadService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: PersonLoadRepository,
    private readonly memberships: Pick<MembershipsRepository, 'findById'>,
  ) {}

  async load(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
    fromRaw: unknown,
    toRaw: unknown,
  ): Promise<PersonLoadView> {
    if (principal.kind === 'client' || !this.mayReadOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'person_load_denied');
    }
    const weeks = weekBuckets(fromRaw, toRaw);
    const first = weeks[0];
    const last = weeks[weeks.length - 1];
    if (first === undefined || last === undefined) {
      throw new ApiError(400, 'validation_failed', 'from is invalid');
    }
    const from = first.weekStart;
    const to = last.weekEnd;

    return this.database.read(context, async (runner) => {
      const membership = await this.memberships.findById(runner, context, membershipId);
      if (!membership) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'membership_not_visible',
        );
      }

      const calendar = await this.repository.orgCalendar(runner, context);
      // Pad a day either side so an instant near midnight in the org's zone is not missed.
      const windowStart = new Date(Date.parse(`${from}T00:00:00Z`) - MS_PER_DAY);
      const windowEnd = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * MS_PER_DAY);
      const rows = await this.repository.listOpenItemsForOwner(
        runner,
        context,
        membership.userId,
        windowStart,
        windowEnd,
      );
      const estimates = await this.repository.estimatesFor(
        runner,
        context,
        rows.map((row) => row.id),
      );
      const capacity = await this.repository.capacityFor(runner, context, membership.id);
      const allocations = await this.repository.allocationsFor(
        runner,
        context,
        membership.id,
        from,
        to,
      );
      const timeOff = await this.repository.timeOffFor(
        runner,
        context,
        membership.userId,
        from,
        to,
      );

      const items: LoadItem[] = rows.map((row) => ({
        projectId: row.projectId,
        readable: this.mayReadProject(principal, context, row.projectId, row.audience),
        startOn: row.startAt === null ? null : localDateOf(row.startAt, calendar.timeZone),
        dueOn: row.dueAt === null ? null : localDateOf(row.dueAt, calendar.timeZone),
        estimateMinutes: estimates.get(row.id) ?? null,
      }));
      const loadAllocations: LoadAllocation[] = allocations.map((row) => ({
        projectId: row.projectId,
        readable: this.mayReadProject(principal, context, row.projectId, 'internal'),
        status: row.status === 'tentative' ? 'tentative' : 'confirmed',
        percent: row.percent,
        hoursPerWeek: row.hoursPerWeek === null ? null : Number(row.hoursPerWeek),
        startDate: row.startDate,
        endDate: row.endDate,
      }));

      const result = buildPersonLoad({
        weeks,
        items,
        allocations: loadAllocations,
        capacity:
          capacity === null
            ? null
            : { weeklyHours: capacity.weeklyHours, effectiveFrom: capacity.effectiveFrom },
        timeOff: timeOff.map((row) => ({ startsOn: row.startsOn, endsOn: row.endsOn })),
        calendar,
      });
      return { membershipId: membership.id, from, to, weeks: result.weeks };
    });
  }

  private mayReadOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /** The per-row read decision the work views make (open, not-deleted rows are `active`). */
  private mayReadProject(
    principal: Principal,
    context: TenantContext,
    projectId: string,
    audience: string,
  ): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: audience as 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
