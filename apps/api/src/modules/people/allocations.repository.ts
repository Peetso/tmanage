import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { personAllocations } from '../../common/database/schema.js';
import type { PersonAllocationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The person-allocations repository — PEOPLE / module 14 (x171), following the
 * `project-objectives` repository pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context, so a caller that never
 *    established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreatePersonAllocationInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export class PersonAllocationNotFoundError extends Error {
  constructor(readonly allocationId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's allocation tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Person allocation ${allocationId} was not found`);
    this.name = 'PersonAllocationNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreatePersonAllocationInput {
  readonly projectId: string;
  readonly membershipId: string;
  readonly percent: number;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

export interface ListPersonAllocationsOptions {
  /** Required: this slice lists one project's allocations, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class PersonAllocationsRepository {
  /**
   * List one project's allocations, within the acting tenant, in creation order.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is
   * `created_at ASC, id ASC`: `id` (UUIDv7, ≈ creation order) is the deterministic tiebreaker so two
   * allocations created in the same millisecond still have a stable, repeatable order.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListPersonAllocationsOptions,
  ): Promise<readonly PersonAllocationRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(personAllocations)
      .where(
        and(
          eq(personAllocations.organizationId, context.organizationId),
          eq(personAllocations.projectId, options.projectId),
        ),
      )
      .orderBy(asc(personAllocations.createdAt), asc(personAllocations.id))
      .limit(limit);
  }

  /**
   * Fetch one allocation by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    allocationId: string,
  ): Promise<PersonAllocationRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(personAllocations)
      .where(
        and(
          eq(personAllocations.organizationId, context.organizationId),
          eq(personAllocations.id, allocationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    allocationId: string,
  ): Promise<PersonAllocationRow> {
    const found = await this.findById(runner, context, allocationId);
    if (!found) throw new PersonAllocationNotFoundError(allocationId);
    return found;
  }

  /**
   * The active allocation for a (project, membership) pair, if any, within the acting tenant.
   *
   * "Active" is `end_date IS NULL` — an ongoing allocation. Used to enforce the one-active-per-pair
   * rule (a duplicate is a 409): MySQL treats NULLs as distinct in a UNIQUE index, so the invariant
   * is checked here rather than pinned by a partial unique key. Predicated on both tenant and project.
   */
  async findActiveForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    membershipId: string,
  ): Promise<PersonAllocationRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(personAllocations)
      .where(
        and(
          eq(personAllocations.organizationId, context.organizationId),
          eq(personAllocations.projectId, projectId),
          eq(personAllocations.membershipId, membershipId),
          isNull(personAllocations.endDate),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create an allocation.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The composite foreign keys
   * refuse a project or membership from another tenant; the controller resolves both first so an
   * unknown id maps to 404 rather than a foreign-key 500.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePersonAllocationInput,
  ): Promise<PersonAllocationRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(personAllocations).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      membershipId: input.membershipId,
      percent: input.percent,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }
}
