import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItems } from '../../common/database/schema.js';
import type { PersonCapacityRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { MemberDirectoryEntry } from '../tenancy/memberships.repository.js';
import { CapacityHeatmapRepository } from '../people/capacity-heatmap.repository.js';
import { OPEN_LOAD_STATES, PersonLoadRepository } from '../people/person-load.repository.js';
import { PersonCapacityRepository } from '../people/capacity.repository.js';

/**
 * A14 — the reads and the one write behind the Insights "workload in hours" view.
 *
 * It adds no table: weekly capacity lives in `person_capacity` (x170), estimates in
 * `work_item_estimates` (x258), owners on `work_items`. Every statement is tenant-scoped through the
 * guard. The existing people repositories are reused as-is (imported, not edited).
 */

/** The open, owned work one week of the view may count. Bounded so a large tenant never scans everything. */
export const MAX_WORKLOAD_HOURS_ITEMS = 5000;
/** Members listed at most; matches the membership directory's page ceiling. */
export const MAX_WORKLOAD_HOURS_MEMBERS = 200;

export interface WorkloadHoursItemRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly audience: WorkItemRow['audience'];
  readonly state: string;
  readonly ownerUserId: string;
  readonly dueAt: Date | null;
  readonly deletedAt: Date | null;
}

export class WorkloadHoursRepository {
  constructor(
    private readonly members = new MembershipsRepository(),
    private readonly heatmap = new CapacityHeatmapRepository(),
    private readonly load = new PersonLoadRepository(),
    private readonly capacity = new PersonCapacityRepository(),
  ) {}

  /** The tenant's active members with their display names. */
  async listMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly MemberDirectoryEntry[]> {
    return this.members.listWithNames(runner, context, { limit: MAX_WORKLOAD_HOURS_MEMBERS });
  }

  /** One member, tenant-scoped — null for an unknown or cross-tenant id. */
  async findMember(runner: TenantQueryRunner, context: TenantContext, membershipId: string) {
    return this.members.findById(runner, context, membershipId);
  }

  /** Every member's current weekly capacity. */
  async listCapacity(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly PersonCapacityRow[]> {
    return this.heatmap.listCapacity(runner, context);
  }

  /**
   * Open, owned, not-deleted work that is due by `windowEnd` (overdue included) or has no due date.
   * Undated work is returned so the service can report it apart from the week's planned hours.
   */
  async listOpenOwnedItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowEnd: Date,
  ): Promise<readonly WorkloadHoursItemRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: workItems.id,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        ownerUserId: workItems.ownerUserId,
        dueAt: workItems.dueAt,
        deletedAt: workItems.deletedAt,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          isNotNull(workItems.ownerUserId),
          inArray(workItems.state, [...OPEN_LOAD_STATES]),
          isNull(workItems.deletedAt),
          or(isNull(workItems.dueAt), lte(workItems.dueAt, windowEnd)),
        ),
      )
      .limit(MAX_WORKLOAD_HOURS_ITEMS);
    return rows.filter((row): row is WorkloadHoursItemRow => row.ownerUserId !== null);
  }

  /** Remaining estimate minutes per work item (override, else estimate minus logged). */
  async remainingMinutes(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (workItemIds.length === 0) return new Map();
    return this.load.estimatesFor(runner, context, workItemIds);
  }

  /** Upsert one member's weekly hours; the tenant comes from the context. */
  async setCapacity(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly membershipId: string;
      readonly weeklyHours: number;
      readonly effectiveFrom: string;
    },
  ): Promise<PersonCapacityRow> {
    return this.capacity.set(runner, context, input);
  }
}
