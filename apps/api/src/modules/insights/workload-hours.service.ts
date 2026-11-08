import { ASSIGNABLE_INTERNAL_ROLES, authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkloadHoursItemRow, WorkloadHoursRepository } from './workload-hours.repository.js';

/**
 * A14 — Insights workload in hours, with editable weekly capacity per person.
 *
 * For each internal member: the **planned hours** this week (the remaining estimate of their open
 * work due in the next seven days, overdue included), the **unscheduled hours** (open work with no
 * due date, shown apart so it never inflates the week), and their **weekly capacity** in hours from
 * `person_capacity` (null when nobody has set it — never a guessed default).
 *
 * Reading is `report.view` plus an org-scoped `authorize()`; each work row is re-checked against
 * `work.read` on its own project, so a caller only counts the work they may see. Changing capacity
 * is owner/admin only: `org.manage` on the route and again here, and the member is resolved
 * tenant-scoped first (unknown or cross-tenant ⇒ 404 with no write).
 */

export const MAX_WEEKLY_HOURS = 168;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INTERNAL_ROLE_SET: ReadonlySet<string> = new Set(ASSIGNABLE_INTERNAL_ROLES);

export interface WorkloadHoursPerson {
  readonly membershipId: string;
  readonly displayName: string;
  readonly plannedHours: number;
  readonly unscheduledHours: number;
  /** Weekly capacity in hours; null when not set. */
  readonly capacityHours: number | null;
  /** `plannedHours / capacityHours`, null without a capacity above zero. */
  readonly utilisation: number | null;
  readonly overCapacity: boolean;
}

export interface WorkloadHoursView {
  readonly people: readonly WorkloadHoursPerson[];
  readonly totals: {
    readonly plannedHours: number;
    readonly capacityHours: number;
    readonly overCapacityCount: number;
  };
  /** Whether the caller may change weekly capacity (owner/admin). */
  readonly canEditCapacity: boolean;
  readonly weekStartsAt: string;
  readonly computedAt: string;
}

export interface WorkloadCapacityView {
  readonly membershipId: string;
  readonly weeklyHours: number;
  readonly effectiveFrom: string;
}

/** Minutes to hours, one decimal. */
function toHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

export class WorkloadHoursService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: WorkloadHoursRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(context: TenantContext, principal: Principal): Promise<WorkloadHoursView> {
    if (!this.mayActOrg(principal, context, 'report.view')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'workload_read_denied');
    }
    const now = this.now();
    const windowEnd = new Date(now.getTime() + WEEK_MS);

    const { members, capacity, items, remaining } = await this.database.read(
      context,
      async (runner) => {
        const memberRows = await this.repository.listMembers(runner, context);
        const capacityRows = await this.repository.listCapacity(runner, context);
        const itemRows = (
          await this.repository.listOpenOwnedItems(runner, context, windowEnd)
        ).filter((row) => this.mayReadItem(principal, row));
        const remainingById = await this.repository.remainingMinutes(
          runner,
          context,
          itemRows.map((row) => row.id),
        );
        return {
          members: memberRows,
          capacity: capacityRows,
          items: itemRows,
          remaining: remainingById,
        };
      },
    );

    const plannedByUser = new Map<string, number>();
    const unscheduledByUser = new Map<string, number>();
    for (const item of items) {
      const minutes = remaining.get(item.id) ?? 0;
      const target = item.dueAt === null ? unscheduledByUser : plannedByUser;
      target.set(item.ownerUserId, (target.get(item.ownerUserId) ?? 0) + minutes);
    }
    const capacityByMember = new Map(capacity.map((row) => [row.membershipId, row.weeklyHours]));

    const people: WorkloadHoursPerson[] = members
      .filter((member) => INTERNAL_ROLE_SET.has(member.role))
      .map((member) => {
        const plannedHours = toHours(plannedByUser.get(member.userId) ?? 0);
        const capacityHours = capacityByMember.get(member.membershipId) ?? null;
        const utilisation =
          capacityHours !== null && capacityHours > 0
            ? Math.round((plannedHours / capacityHours) * 100) / 100
            : null;
        return {
          membershipId: member.membershipId,
          displayName: member.displayName,
          plannedHours,
          unscheduledHours: toHours(unscheduledByUser.get(member.userId) ?? 0),
          capacityHours,
          utilisation,
          overCapacity: capacityHours !== null && plannedHours > capacityHours,
        };
      })
      .sort(
        (a, b) => b.plannedHours - a.plannedHours || a.displayName.localeCompare(b.displayName),
      );

    return {
      people,
      totals: {
        plannedHours: Math.round(people.reduce((sum, p) => sum + p.plannedHours, 0) * 10) / 10,
        capacityHours: people.reduce((sum, p) => sum + (p.capacityHours ?? 0), 0),
        overCapacityCount: people.filter((p) => p.overCapacity).length,
      },
      canEditCapacity: this.mayActOrg(principal, context, 'org.manage'),
      weekStartsAt: now.toISOString(),
      computedAt: now.toISOString(),
    };
  }

  /** Owner/admin only. Resolve the member first (404), then authorize (403), then validate (400). */
  async setCapacity(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
    rawHours: unknown,
  ): Promise<WorkloadCapacityView> {
    const effectiveFrom = this.now().toISOString().slice(0, 10);
    const row = await this.database.transaction(context, async (tx) => {
      const member = await this.repository.findMember(tx, context, membershipId);
      if (!member) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
      }
      if (!this.mayActOrg(principal, context, 'org.manage')) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'capacity_write_denied',
        );
      }
      const weeklyHours = validateWeeklyHours(rawHours);
      return this.repository.setCapacity(tx, context, { membershipId, weeklyHours, effectiveFrom });
    });
    return {
      membershipId: row.membershipId,
      weeklyHours: row.weeklyHours,
      effectiveFrom: row.effectiveFrom,
    };
  }

  private mayActOrg(principal: Principal, context: TenantContext, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private mayReadItem(principal: Principal, row: WorkloadHoursItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.deletedAt ? 'soft_deleted' : 'active',
      },
    }).allowed;
  }
}

/** An integer number of hours in [0, 168]; anything else is a 400 with no write. */
export function validateWeeklyHours(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_WEEKLY_HOURS
  ) {
    throw new ApiError(400, 'validation_failed', 'weeklyHours is invalid', [
      { field: 'weeklyHours', message: `must be an integer between 0 and ${MAX_WEEKLY_HOURS}` },
    ]);
  }
  return value;
}
