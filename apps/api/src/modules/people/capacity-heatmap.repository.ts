import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { personAllocations, personCapacity } from '../../common/database/schema.js';
import type { PersonAllocationRow, PersonCapacityRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The team-capacity-heatmap read repository — PEOPLE / module 14 (x193).
 *
 * A read-only aggregation over the two facts x170/x171 already own: `person_capacity` (per-member
 * weekly hours) and `person_allocations` (a member's share of a project, with an optional window).
 * The heatmap adds no table; it reads both, tenant-scoped, and the service folds them into a grid.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, like the sibling
 * repositories:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` and the
 *    `TenantContext`; there is no overload without a context.
 * 2. **The tenant predicate is on every statement** (`organization_id = context.organizationId`),
 *    built with Drizzle and executed through the guard, so a forgotten predicate throws.
 * 3. **The window is bounded at the engine.** The allocation read is predicated on the requested
 *    `[from, to]` window (`start_date <= to AND (end_date IS NULL OR end_date >= from)`), so an
 *    absurd or open-ended request can never fan out into an unbounded tenant-wide scan.
 */
export class CapacityHeatmapRepository {
  /** Every member's current weekly capacity, within the acting tenant. */
  async listCapacity(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly PersonCapacityRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(personCapacity)
      .where(eq(personCapacity.organizationId, context.organizationId));
  }

  /**
   * Every allocation whose window overlaps `[fromDate, toDate]`, within the acting tenant.
   *
   * The overlap predicate is the bound the Known-trap requires: only rows that could touch the
   * requested weeks are read, never the whole allocation history. A null `end_date` is an ongoing
   * allocation, so it overlaps any window whose `from` it has already started by.
   */
  async listAllocationsInWindow(
    runner: TenantQueryRunner,
    context: TenantContext,
    fromDate: string,
    toDate: string,
  ): Promise<readonly PersonAllocationRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(personAllocations)
      .where(
        and(
          eq(personAllocations.organizationId, context.organizationId),
          // start_date <= to (a row that starts after the window can never overlap it). A null
          // start_date means "always started", so it is not excluded here.
          or(isNull(personAllocations.startDate), lte(personAllocations.startDate, toDate)),
          // end_date >= from, or open-ended (still ongoing).
          or(isNull(personAllocations.endDate), gte(personAllocations.endDate, fromDate)),
        ),
      );
  }
}
