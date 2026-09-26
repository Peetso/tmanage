import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgObjectives } from '../../common/database/schema.js';
import type { OrgObjectiveRow } from '../../common/database/schema.js';
import type { ORG_OBJECTIVE_STATUSES } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The org-objectives repository — PROJ / module 8 (x136), the org-level counterpart of
 * `project-objectives.repository.ts` (x124). It follows the same shape, minus the `project_id` column
 * and predicate: an org objective belongs to the tenant, not to a project.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * project-objectives repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateOrgObjectiveInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** The objective status set, mirroring the `0046` `ENUM`. */
export type OrgObjectiveStatus = (typeof ORG_OBJECTIVE_STATUSES)[number];

export class OrgObjectiveNotFoundError extends Error {
  constructor(readonly objectiveId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's objective tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Org objective ${objectiveId} was not found`);
    this.name = 'OrgObjectiveNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateOrgObjectiveInput {
  readonly name: string;
  readonly description?: string | null;
  readonly target?: string | null;
  readonly status: OrgObjectiveStatus;
  /** The person who created the objective — the service passes `context.userId`. */
  readonly createdBy: string;
}

export interface ListOrgObjectivesOptions {
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class OrgObjectivesRepository {
  /**
   * List the organization's objectives, within the acting tenant, in creation order.
   *
   * The `organization_id` predicate is present. The order is `created_at ASC, id ASC`: an objectives
   * list reads oldest-first (the order they were set), and `id` (UUIDv7, ≈ creation order) is the
   * deterministic tiebreaker so two objectives created in the same millisecond still have a stable,
   * repeatable order.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListOrgObjectivesOptions,
  ): Promise<readonly OrgObjectiveRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(orgObjectives)
      .where(eq(orgObjectives.organizationId, context.organizationId))
      .orderBy(asc(orgObjectives.createdAt), asc(orgObjectives.id))
      .limit(limit);
  }

  /**
   * Fetch one objective by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
  ): Promise<OrgObjectiveRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(orgObjectives)
      .where(
        and(
          eq(orgObjectives.organizationId, context.organizationId),
          eq(orgObjectives.id, objectiveId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
  ): Promise<OrgObjectiveRow> {
    const found = await this.findById(runner, context, objectiveId);
    if (!found) throw new OrgObjectiveNotFoundError(objectiveId);
    return found;
  }

  /**
   * Create an objective.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateOrgObjectiveInput,
  ): Promise<OrgObjectiveRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(orgObjectives).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      name: input.name,
      description: input.description ?? null,
      target: input.target ?? null,
      status: input.status,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }

  /**
   * Move an objective to a new lifecycle status within the acting tenant, and read it back.
   *
   * This is the only mutation an objective has: the `0046` column-pinning trigger refuses every
   * column but `status`, and `users.sql` grants the runtime credential UPDATE for exactly this. The
   * predicate carries both `organization_id` and `id`, so a cross-tenant id updates nothing. The
   * *transition* is guarded in the service (an illegal one is a 409 with no write); this method
   * writes the status the service already decided is legal.
   */
  async updateStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
    status: OrgObjectiveStatus,
  ): Promise<OrgObjectiveRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(orgObjectives)
      .set({ status })
      .where(
        and(
          eq(orgObjectives.organizationId, context.organizationId),
          eq(orgObjectives.id, objectiveId),
        ),
      );
    return this.requireById(runner, context, objectiveId);
  }
}
