import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projects, workspaces } from '../../common/database/schema.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The projects repository — the first scoped repository, and the pattern the rest follow.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 states four requirements. Each is a
 * structural property of this file rather than a convention someone has to remember:
 *
 * 1. **"Repositories expose no unscoped `findById`, `update`, `delete`, or free-form
 *    query."** Every method's first parameter is a `TenantContext`. There is no overload
 *    without one, so calling a repository from a code path that never established a tenant
 *    is a type error, not a runtime leak.
 *
 * 2. **"Mutation repositories derive `organization_id` from `TenantContext`, never from the
 *    DTO."** The input types below have no `organizationId` field at all. A caller cannot
 *    supply the tenant it wants to write into, because there is nowhere to put it — see
 *    `CreateProjectInput`. This is the property the isolation corpus tests as "refuses an
 *    insert that takes the organization from the payload rather than the context".
 *
 * 3. **The tenant predicate is on every statement.** Built with Drizzle, executed through
 *    the guard (see `drizzle.ts`), so a forgotten predicate throws rather than returning
 *    another tenant's rows.
 *
 * 4. **Optimistic concurrency on update** (spec §3 step 7). An update that does not name
 *    the version it read is refused by the signature; one that names a stale version
 *    affects zero rows and raises {@link ProjectVersionConflictError}.
 *
 * ## Why the runner is a parameter and not a field
 *
 * Every method takes the `TenantQueryRunner` for the current unit of work. The repository
 * holds no connection, no pool and no state, so a command that performs four writes performs
 * them on one connection inside one transaction — `TenantDatabase.transaction()` owns that,
 * and a repository cannot quietly open a second one. It also means these methods compose:
 * a service can call three repositories inside a single transaction without any of them
 * knowing about the others.
 */

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    // No organization id in the message. A not-found error is returned to a caller, and a
    // caller probing for another tenant's project should learn nothing from the difference
    // between "does not exist" and "exists elsewhere" (spec §4).
    super(`Project ${projectId} was not found`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectVersionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly expectedVersion: number,
  ) {
    super(`Project ${projectId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'ProjectVersionConflictError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field
 * for a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerUserId?: string | null;
  readonly status?: string;
  /**
   * `ON-03`'s date, and it lands in `forecast_at` rather than `committed_at`.
   *
   * That is the whole of the specification's rule for this screen, expressed as a column
   * choice: "Date is marked **target** until milestone plan confirmed." The schema already
   * carries both, and the design language draws the same line — the pulse track separates
   * committed from forecast from desired. A date typed on a setup screen, before anyone has
   * planned the work, is a forecast. Writing it to `committed_at` would make a promise on
   * the team's behalf that nobody made.
   *
   * A `'YYYY-MM-DD'` string, because the column is `DATE` (0012): a calendar date, not an
   * instant, so no reader's timezone can move it.
   */
  readonly forecastAt?: string | null;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly status?: string;
  readonly ownerUserId?: string | null;
}

export interface ListProjectsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is `(created_at, id)`. */
  readonly after?: string;
  readonly limit?: number;
  /** Archived projects are excluded unless asked for. */
  readonly includeArchived?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ProjectsRepository {
  /**
   * List one tenant's projects.
   *
   * Keyset rather than offset pagination: `07-DATA-MODEL` §9 requires every composite index
   * to begin with `organization_id`, and `(organization_id, id)` is exactly the shape a
   * keyset walk uses. An `OFFSET` scan of a shared table also gets slower for every tenant
   * as any one tenant grows.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectsOptions = {},
  ): Promise<readonly ProjectRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const db = tenantDrizzle(runner);

    const predicates = [eq(projects.organizationId, context.organizationId)];
    if (!options.includeArchived) predicates.push(isNull(projects.archivedAt));
    if (options.after) predicates.push(gt(projects.id, options.after));

    return db
      .select()
      .from(projects)
      .where(and(...predicates))
      .orderBy(asc(projects.id))
      .limit(limit);
  }

  /**
   * Fetch one project by id, within the acting tenant.
   *
   * There is deliberately no `findById(id)` without a context. On PostgreSQL such a method
   * would return zero rows under RLS; on MySQL it returns another customer's project, which
   * is why ADR-0001 exists and why this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectRow> {
    const found = await this.findById(runner, context, projectId);
    if (!found) throw new ProjectNotFoundError(projectId);
    return found;
  }

  /**
   * Create a project.
   *
   * The id is generated here rather than by the database: `07-DATA-MODEL` fixes
   * application-generated UUIDv7 stored as canonical lowercase `CHAR(36)`, which lets a
   * command know the id before the insert commits — necessary for writing the outbox event
   * and the audit event in the same transaction (spec §3 step 8).
   *
   * The workspace is *not* checked to belong to the tenant here. That is not an oversight:
   * `fk_projects_workspace_tenant` is a composite foreign key including `organization_id`,
   * so the database refuses the row. A service-layer check would duplicate a guarantee that
   * already cannot be bypassed, and would drift from it.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectInput,
  ): Promise<ProjectRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projects).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      workspaceId: input.workspaceId,
      name: input.name,
      status: input.status ?? 'active',
      ownerUserId: input.ownerUserId ?? null,
      forecastAt: input.forecastAt ?? null,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps,
    // and returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /**
   * Update a project, refusing a stale write.
   *
   * `expectedUpdatedAt` is the concurrency token rather than a version column, because
   * `projects` has no `version` column in `0001_tenancy.sql` — `work_items` and
   * `memberships` do. Using `updated_at` here keeps the repository honest about the schema
   * it actually has; adding a `version` column to `projects` is a migration, not a
   * repository change, and is the right fix if this ever needs to survive sub-millisecond
   * concurrent writes.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    expectedUpdatedAt: Date,
    input: UpdateProjectInput,
  ): Promise<ProjectRow> {
    const db = tenantDrizzle(runner);

    const changes: Record<string, unknown> = { updatedAt: sql`current_timestamp(3)` };
    if (input.name !== undefined) changes['name'] = input.name;
    if (input.status !== undefined) changes['status'] = input.status;
    if (input.ownerUserId !== undefined) changes['ownerUserId'] = input.ownerUserId;

    const result = await db
      .update(projects)
      .set(changes)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          eq(projects.id, projectId),
          eq(projects.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Zero rows means one of three things: wrong tenant, no such project, or a stale
      // token. They are distinguished by a scoped read, so a caller in the wrong tenant
      // still gets "not found" rather than a conflict that confirms the row exists.
      const current = await this.findById(runner, context, projectId);
      if (!current) throw new ProjectNotFoundError(projectId);
      throw new ProjectVersionConflictError(projectId, current.updatedAt.getTime());
    }

    return this.requireById(runner, context, projectId);
  }

  /**
   * Archive a project. There is no hard delete.
   *
   * `04-SECURITY-PRIVACY` and the offboarding lifecycle both treat removal as a state, not
   * an erasure: audit events, outbox events and client-visible history reference this row,
   * and a `DELETE` would either orphan them or cascade through them.
   */
  async archive(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectRow> {
    const db = tenantDrizzle(runner);
    const result = await db
      .update(projects)
      .set({ archivedAt: sql`current_timestamp(3)`, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          eq(projects.id, projectId),
          isNull(projects.archivedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, projectId);
      if (!current) throw new ProjectNotFoundError(projectId);
      return current; // Already archived; archiving twice is not an error.
    }

    return this.requireById(runner, context, projectId);
  }

  /**
   * Projects in one workspace.
   *
   * The join is anchored on `organization_id` on **both** sides. Binding only the project
   * side would still return the right rows today and would be a latent cross-tenant join
   * the moment a workspace id were reused — the isolation corpus has a case for exactly
   * this ("rejects a join that binds only one side to the tenant").
   */
  async listByWorkspace(
    runner: TenantQueryRunner,
    context: TenantContext,
    workspaceId: string,
  ): Promise<readonly ProjectRow[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ project: projects })
      .from(projects)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, projects.workspaceId),
          eq(workspaces.organizationId, projects.organizationId),
          eq(workspaces.organizationId, context.organizationId),
        ),
      )
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.id));

    return rows.map((row) => row.project);
  }
}
