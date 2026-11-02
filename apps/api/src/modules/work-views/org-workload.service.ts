import { authorize, localDateOf } from '@tmanage/domain';
import type { Principal, WorkingCalendar } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { PersonLoadRepository } from '../people/person-load.repository.js';
import { buildPersonLoad, weekBuckets } from '../people/workload-hours.js';
import type { LoadAllocation, LoadItem } from '../people/workload-hours.js';
import {
  PEOPLE_PAGE_SIZE,
  buildOrgWorkload,
  cutPage,
  parsePage,
  requireScope,
} from './org-workload-rules.js';
import type { OrgWorkloadView } from './org-workload-rules.js';
import type { OrgWorkloadRepository, WorkloadItemRow } from './org-workload.repository.js';

/**
 * 53-08 part 2a (R21-a) — the org-wide workload grid, computed server-side per reader.
 *
 * Gate: `work.read` on the route plus the org-scoped `authorize()` here (`people.view` is not a
 * capability key — the heatmap and the person load read the same way); a client principal is a 403.
 * Scope, cursor and the ≤ 26-week window are validated before any read. A `project:<id>` scope is
 * resolved tenant-scoped first: unknown or cross-tenant → 404 (never 403). Every item and allocation
 * is judged with the work views' per-row `work.read` rule for THIS reader: readable work is itemised
 * by project, the rest only adds to the person's `otherProjectsHours`; owner-less unreadable work is
 * dropped entirely. The reads are batched per page (one statement per table), never per person.
 */

const MS_PER_DAY = 86_400_000;

export interface OrgWorkloadQuery {
  readonly scope?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly cursor?: unknown;
}

export interface OrgWorkloadResponse extends OrgWorkloadView {
  readonly scope: string;
  readonly from: string;
  readonly to: string;
}

export class OrgWorkloadService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: OrgWorkloadRepository,
    private readonly personLoad: Pick<PersonLoadRepository, 'estimatesFor' | 'orgCalendar'>,
    private readonly projects: Pick<ProjectsRepository, 'findById'>,
  ) {}

  async grid(
    context: TenantContext,
    principal: Principal,
    query: OrgWorkloadQuery,
  ): Promise<OrgWorkloadResponse> {
    if (principal.kind === 'client' || !this.mayReadOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'org_workload_denied');
    }
    const scope = requireScope(query.scope);
    const { afterMembershipId } = parsePage(query.cursor);
    const weeks = weekBuckets(query.from, query.to);
    const first = weeks[0];
    const last = weeks[weeks.length - 1];
    if (first === undefined || last === undefined) {
      throw new ApiError(400, 'validation_failed', 'from is invalid');
    }
    const from = first.weekStart;
    const to = last.weekEnd;
    // Pad a day either side so an instant near midnight in the org's zone is not missed.
    const window = {
      start: new Date(Date.parse(`${from}T00:00:00Z`) - MS_PER_DAY),
      end: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * MS_PER_DAY),
    };

    return this.database.read(context, async (runner) => {
      if (scope.kind === 'project') {
        const project = await this.projects.findById(runner, context, scope.projectId);
        if (project === null) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
        }
      }

      const members = await this.repository.listInternalMembers(runner, context, {
        afterMembershipId,
        limit: PEOPLE_PAGE_SIZE + 1,
      });
      const { page, nextCursor } = cutPage(members);
      const userIds = page.map((m) => m.userId);
      const membershipIds = page.map((m) => m.membershipId);

      const calendar = await this.personLoad.orgCalendar(runner, context);
      const ownedRows = await this.repository.listOpenItemsForOwners(
        runner,
        context,
        userIds,
        scope,
        window,
      );
      const unassignedRows = await this.repository.listOpenUnassignedItems(
        runner,
        context,
        scope,
        window,
      );
      const estimates = await this.personLoad.estimatesFor(runner, context, [
        ...ownedRows.map((row) => row.id),
        ...unassignedRows.map((row) => row.id),
      ]);
      const capacities = await this.repository.capacitiesFor(runner, context, membershipIds);
      const allocations = await this.repository.allocationsFor(
        runner,
        context,
        membershipIds,
        scope,
        from,
        to,
      );
      const timeOff = await this.repository.timeOffFor(runner, context, userIds, from, to);

      const toItem = (row: WorkloadItemRow): LoadItem =>
        this.loadItem(principal, row, estimates, calendar);

      const people = page.map((member) => {
        const capacity = capacities.find((row) => row.membershipId === member.membershipId);
        const items = ownedRows.filter((row) => row.ownerUserId === member.userId).map(toItem);
        const loadAllocations: LoadAllocation[] = allocations
          .filter((row) => row.membershipId === member.membershipId)
          .map((row) => ({
            projectId: row.projectId,
            readable: this.mayReadProject(principal, context, row.projectId),
            status: row.status === 'tentative' ? 'tentative' : 'confirmed',
            percent: row.percent,
            hoursPerWeek: row.hoursPerWeek === null ? null : Number(row.hoursPerWeek),
            startDate: row.startDate,
            endDate: row.endDate,
          }));
        const load = buildPersonLoad({
          weeks,
          items,
          allocations: loadAllocations,
          capacity:
            capacity === undefined
              ? null
              : { weeklyHours: capacity.weeklyHours, effectiveFrom: capacity.effectiveFrom },
          timeOff: timeOff
            .filter((row) => row.personUserId === member.userId)
            .map((row) => ({ startsOn: row.startsOn, endsOn: row.endsOn })),
          calendar,
        });
        return { ...member, load };
      });

      const view = buildOrgWorkload({
        weeks,
        people,
        unassigned: unassignedRows.map(toItem).filter((item) => item.readable),
        calendar,
        nextCursor,
      });
      return {
        scope: scope.kind === 'org' ? 'org' : `project:${scope.projectId}`,
        from,
        to,
        ...view,
      };
    });
  }

  private loadItem(
    principal: Principal,
    row: WorkloadItemRow,
    estimates: ReadonlyMap<string, number>,
    calendar: WorkingCalendar,
  ): LoadItem {
    return {
      projectId: row.projectId,
      readable: this.mayRead(principal, row),
      startOn: row.startAt === null ? null : localDateOf(row.startAt, calendar.timeZone),
      dueOn: row.dueAt === null ? null : localDateOf(row.dueAt, calendar.timeZone),
      estimateMinutes: estimates.get(row.id) ?? null,
    };
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

  /** The work views' per-row rule (work-views.service.ts `mayRead`), copied: it is private there. */
  private mayRead(principal: Principal, row: WorkloadItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.deletedAt
          ? 'soft_deleted'
          : row.state === 'archived'
            ? 'archived'
            : 'active',
      },
    }).allowed;
  }

  /** An allocation's project, judged as internal active work (work-views `mayReadProject`). */
  private mayReadProject(principal: Principal, context: TenantContext, projectId: string): boolean {
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
}
