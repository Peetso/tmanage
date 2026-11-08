import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  personAllocations,
  personCapacity,
  personTimeOff,
  users,
  workItemAssignees,
  workItems,
} from '../../common/database/schema.js';
import type {
  PersonAllocationRow,
  PersonCapacityRow,
  PersonTimeOffRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { MAX_LOAD_ITEMS, OPEN_LOAD_STATES } from '../people/person-load.repository.js';
import type { WorkloadScope } from './org-workload-rules.js';

/**
 * 53-08 part 2a (R21-a) — the page-batched reads behind the org-wide workload grid. Read-only and
 * tenant-scoped on every statement (`organization_id = context.organizationId`, run through the
 * guard). Each read covers the whole people page at once (`IN (…)` over the page's user or
 * membership ids), so 50 people × 26 weeks is one round of a handful of statements, never one per
 * person. The per-person R20-b repository stays as it is; its estimate and calendar reads are reused
 * by the service.
 */

/** A page of open items for up to 50 owners: 50 × the per-person cap would be unbounded in practice. */
export const MAX_PAGE_LOAD_ITEMS = 20_000;

export interface WorkloadMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface WorkloadItemRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly ownerUserId: string | null;
  readonly audience: WorkItemRow['audience'];
  readonly state: string;
  readonly startAt: Date | null;
  readonly dueAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface LoadWindow {
  /** Instants; the caller pads a day either side for time zones. */
  readonly start: Date;
  readonly end: Date;
}

const itemColumns = {
  id: workItems.id,
  organizationId: workItems.organizationId,
  projectId: workItems.projectId,
  ownerUserId: workItems.ownerUserId,
  audience: workItems.audience,
  state: workItems.state,
  startAt: workItems.startAt,
  dueAt: workItems.dueAt,
  deletedAt: workItems.deletedAt,
};

function openItemPredicates(
  context: TenantContext,
  scope: WorkloadScope,
  window: LoadWindow,
): SQL[] {
  const predicates: SQL[] = [
    eq(workItems.organizationId, context.organizationId),
    inArray(workItems.state, [...OPEN_LOAD_STATES]),
    isNull(workItems.deletedAt),
    or(isNotNull(workItems.startAt), isNotNull(workItems.dueAt)) as SQL,
    or(isNull(workItems.startAt), lte(workItems.startAt, window.end)) as SQL,
    or(isNull(workItems.dueAt), gte(workItems.dueAt, window.start)) as SQL,
  ];
  if (scope.kind === 'project') predicates.push(eq(workItems.projectId, scope.projectId));
  return predicates;
}

export class OrgWorkloadRepository {
  /**
   * Active internal members after the keyset cursor, ordered by membership id. The hidden support
   * role never appears (PA-05). `limit` is the page size + 1; the extra row only proves a next page.
   */
  async listInternalMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly afterMembershipId: string | null; readonly limit: number },
  ): Promise<readonly WorkloadMemberRow[]> {
    const predicates: SQL[] = [
      eq(memberships.organizationId, context.organizationId),
      eq(memberships.status, 'active'),
      ne(memberships.role, PLATFORM_SUPPORT_ROLE),
    ];
    if (options.afterMembershipId !== null) {
      predicates.push(gt(memberships.id, options.afterMembershipId));
    }
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...predicates))
      .orderBy(asc(memberships.id))
      .limit(options.limit);
  }

  /** The page owners' open, not-deleted, dated items touching the window (scope-filtered). */
  async listOpenItemsForOwners(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserIds: readonly string[],
    scope: WorkloadScope,
    window: LoadWindow,
  ): Promise<readonly WorkloadItemRow[]> {
    if (ownerUserIds.length === 0) return [];
    const owned = await tenantDrizzle(runner)
      .select(itemColumns)
      .from(workItems)
      .where(
        and(
          ...openItemPredicates(context, scope, window),
          inArray(workItems.ownerUserId, [...ownerUserIds]),
        ),
      )
      .limit(MAX_PAGE_LOAD_ITEMS);
    // C26: an item with several doers counts for each of them, not only the lead. A non-lead
    // doer's copy carries the doer's user id in `ownerUserId`, which is what the page groups on.
    const shared = await tenantDrizzle(runner)
      .select({ ...itemColumns, ownerUserId: memberships.userId })
      .from(workItems)
      .innerJoin(
        workItemAssignees,
        and(
          eq(workItemAssignees.organizationId, workItems.organizationId),
          eq(workItemAssignees.workItemId, workItems.id),
          eq(workItemAssignees.role, 'doer'),
        ),
      )
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItemAssignees.organizationId),
          eq(memberships.id, workItemAssignees.membershipId),
        ),
      )
      .where(
        and(
          ...openItemPredicates(context, scope, window),
          inArray(memberships.userId, [...ownerUserIds]),
          or(isNull(workItems.ownerUserId), ne(workItems.ownerUserId, memberships.userId)),
        ),
      )
      .limit(MAX_PAGE_LOAD_ITEMS);
    return [...owned, ...shared];
  }

  /** Owner-less open items touching the window (scope-filtered), capped like one person's load. */
  async listOpenUnassignedItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: WorkloadScope,
    window: LoadWindow,
  ): Promise<readonly WorkloadItemRow[]> {
    return tenantDrizzle(runner)
      .select(itemColumns)
      .from(workItems)
      .where(and(...openItemPredicates(context, scope, window), isNull(workItems.ownerUserId)))
      .limit(MAX_LOAD_ITEMS);
  }

  /** Capacity rows for the page's memberships. */
  async capacitiesFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<readonly PersonCapacityRow[]> {
    if (membershipIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(personCapacity)
      .where(
        and(
          eq(personCapacity.organizationId, context.organizationId),
          inArray(personCapacity.membershipId, [...membershipIds]),
        ),
      );
  }

  /** The page's allocations overlapping `[from, to]` (date strings), scope-filtered. */
  async allocationsFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
    scope: WorkloadScope,
    from: string,
    to: string,
  ): Promise<readonly PersonAllocationRow[]> {
    if (membershipIds.length === 0) return [];
    const predicates: SQL[] = [
      eq(personAllocations.organizationId, context.organizationId),
      inArray(personAllocations.membershipId, [...membershipIds]),
      or(isNull(personAllocations.startDate), lte(personAllocations.startDate, to)) as SQL,
      or(isNull(personAllocations.endDate), gte(personAllocations.endDate, from)) as SQL,
    ];
    if (scope.kind === 'project') {
      predicates.push(eq(personAllocations.projectId, scope.projectId));
    }
    return tenantDrizzle(runner)
      .select()
      .from(personAllocations)
      .where(and(...predicates));
  }

  /** The page's time off overlapping `[from, to]`. */
  async timeOffFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserIds: readonly string[],
    from: string,
    to: string,
  ): Promise<readonly PersonTimeOffRow[]> {
    if (personUserIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(personTimeOff)
      .where(
        and(
          eq(personTimeOff.organizationId, context.organizationId),
          inArray(personTimeOff.personUserId, [...personUserIds]),
          lte(personTimeOff.startsOn, to),
          gte(personTimeOff.endsOn, from),
        ),
      );
  }
}
