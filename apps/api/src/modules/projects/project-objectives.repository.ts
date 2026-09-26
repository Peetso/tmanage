import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectObjectives } from '../../common/database/schema.js';
import type { ProjectObjectiveRow } from '../../common/database/schema.js';
import type { PROJECT_OBJECTIVE_STATUSES } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-objectives repository — PROJ / module 8 (x124), following the `decisions`/`meetings`
 * pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * decisions repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context, so a caller that never
 *    established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateProjectObjectiveInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** The objective status set, mirroring the `0040` `ENUM`. */
export type ProjectObjectiveStatus = (typeof PROJECT_OBJECTIVE_STATUSES)[number];

export class ProjectObjectiveNotFoundError extends Error {
  constructor(readonly objectiveId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's objective tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Project objective ${objectiveId} was not found`);
    this.name = 'ProjectObjectiveNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateProjectObjectiveInput {
  readonly projectId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly target?: string | null;
  readonly status: ProjectObjectiveStatus;
  /** The person who created the objective — the service passes `context.userId`. */
  readonly createdBy: string;
}

export interface ListProjectObjectivesOptions {
  /** Required: this slice lists one project's objectives, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectObjectivesRepository {
  /**
   * List one project's objectives, within the acting tenant, in creation order.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is
   * `created_at ASC, id ASC`: an objectives list reads oldest-first (the order they were set), and
   * `id` (UUIDv7, ≈ creation order) is the deterministic tiebreaker so two objectives created in the
   * same millisecond still have a stable, repeatable order.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectObjectivesOptions,
  ): Promise<readonly ProjectObjectiveRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(projectObjectives)
      .where(
        and(
          eq(projectObjectives.organizationId, context.organizationId),
          eq(projectObjectives.projectId, options.projectId),
        ),
      )
      .orderBy(asc(projectObjectives.createdAt), asc(projectObjectives.id))
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
  ): Promise<ProjectObjectiveRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectObjectives)
      .where(
        and(
          eq(projectObjectives.organizationId, context.organizationId),
          eq(projectObjectives.id, objectiveId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
  ): Promise<ProjectObjectiveRow> {
    const found = await this.findById(runner, context, objectiveId);
    if (!found) throw new ProjectObjectiveNotFoundError(objectiveId);
    return found;
  }

  /**
   * Create an objective.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is not checked
   * to belong to the tenant here: the composite foreign key `fk_project_objectives_project_tenant`
   * includes `organization_id`, so the database refuses a project from another tenant. (The service
   * *does* resolve the project first, but to map an unknown id to 404 rather than a foreign-key 500 —
   * see the service.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectObjectiveInput,
  ): Promise<ProjectObjectiveRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectObjectives).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
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
   * This is the only mutation an objective has: the `0040` column-pinning trigger refuses every
   * column but `status`, and `users.sql` grants the runtime credential UPDATE for exactly this. The
   * predicate carries both `organization_id` and `id`, so a cross-tenant id updates nothing. The
   * *transition* is guarded in the service (an illegal one is a 409 with no write); this method
   * writes the status the service already decided is legal.
   */
  async updateStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectiveId: string,
    status: ProjectObjectiveStatus,
  ): Promise<ProjectObjectiveRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(projectObjectives)
      .set({ status })
      .where(
        and(
          eq(projectObjectives.organizationId, context.organizationId),
          eq(projectObjectives.id, objectiveId),
        ),
      );
    return this.requireById(runner, context, objectiveId);
  }
}
