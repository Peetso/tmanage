import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectDependencies, projects } from '../../common/database/schema.js';
import type { ProjectDependencyRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-dependencies repository — PROJ / cross-project dependencies (x309), following the
 * `milestone_links` (0108) pattern exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateProjectDependencyInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** Note what is absent: `organizationId`. It is taken from the context. */
export interface CreateProjectDependencyInput {
  readonly blockerProjectId: string;
  readonly blockedProjectId: string;
  readonly note: string | null;
  /** The person who created the dependency — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** An edge joined to the neighbouring project it names, for a list projection. */
export interface ProjectDependencyWithProject {
  readonly edge: ProjectDependencyRow;
  /** The name of the project on the far end of the edge (the blocked one for a blocker list). */
  readonly projectName: string;
  readonly projectStatus: string;
  /**
   * F49. When the far-end project was archived, so the service can authorise `work.read` on it with
   * the right lifecycle before disclosing its name or status. Absent on a freshly written edge.
   */
  readonly projectArchivedAt?: Date | null;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectDependenciesRepository {
  /**
   * List the projects one project blocks — the edges where it is the blocker — within the acting
   * tenant, joined to each blocked project so the caller can render a name and status without a
   * second query. Both `organization_id` predicates are present, and the join is on the composite
   * `(organization_id, id)` so it never crosses a tenant. Order is `created_at ASC, id ASC`.
   */
  async listBlocking(
    runner: TenantQueryRunner,
    context: TenantContext,
    blockerProjectId: string,
    limit?: number,
  ): Promise<readonly ProjectDependencyWithProject[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        edge: projectDependencies,
        name: projects.name,
        status: projects.status,
        archivedAt: projects.archivedAt,
      })
      .from(projectDependencies)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, projectDependencies.organizationId),
          eq(projects.id, projectDependencies.blockedProjectId),
        ),
      )
      .where(
        and(
          eq(projectDependencies.organizationId, context.organizationId),
          eq(projectDependencies.blockerProjectId, blockerProjectId),
        ),
      )
      .orderBy(asc(projectDependencies.createdAt), asc(projectDependencies.id))
      .limit(effectivePageSize(limit));

    return rows.map((row) => ({
      edge: row.edge,
      projectName: row.name,
      projectStatus: row.status,
      projectArchivedAt: row.archivedAt ?? null,
    }));
  }

  /**
   * List the projects that block one project — the edges where it is the blocked end — within the
   * acting tenant, joined to each blocking project. Same tenant-safe join as {@link listBlocking}.
   */
  async listBlockedBy(
    runner: TenantQueryRunner,
    context: TenantContext,
    blockedProjectId: string,
    limit?: number,
  ): Promise<readonly ProjectDependencyWithProject[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        edge: projectDependencies,
        name: projects.name,
        status: projects.status,
        archivedAt: projects.archivedAt,
      })
      .from(projectDependencies)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, projectDependencies.organizationId),
          eq(projects.id, projectDependencies.blockerProjectId),
        ),
      )
      .where(
        and(
          eq(projectDependencies.organizationId, context.organizationId),
          eq(projectDependencies.blockedProjectId, blockedProjectId),
        ),
      )
      .orderBy(asc(projectDependencies.createdAt), asc(projectDependencies.id))
      .limit(effectivePageSize(limit));

    return rows.map((row) => ({
      edge: row.edge,
      projectName: row.name,
      projectStatus: row.status,
      projectArchivedAt: row.archivedAt ?? null,
    }));
  }

  /**
   * Fetch one edge by its (blocker, blocked) pair, within the acting tenant. Returns null when the
   * pair is not linked — the service uses this to reject a duplicate with a 409.
   */
  async findByPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    blockerProjectId: string,
    blockedProjectId: string,
  ): Promise<ProjectDependencyRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectDependencies)
      .where(
        and(
          eq(projectDependencies.organizationId, context.organizationId),
          eq(projectDependencies.blockerProjectId, blockerProjectId),
          eq(projectDependencies.blockedProjectId, blockedProjectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one edge by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    edgeId: string,
  ): Promise<ProjectDependencyRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectDependencies)
      .where(
        and(
          eq(projectDependencies.organizationId, context.organizationId),
          eq(projectDependencies.id, edgeId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a dependency edge. `organization_id` comes from the context, never from `input`. The
   * caller (the service) has already resolved both projects tenant-scoped, rejected a self-edge, and
   * checked the pair is not already linked; the `uq_project_dependencies_pair` unique key is the
   * structural backstop, and the composite foreign keys refuse a project from another tenant.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectDependencyInput,
  ): Promise<ProjectDependencyRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(projectDependencies).values({
      id,
      organizationId: context.organizationId,
      blockerProjectId: input.blockerProjectId,
      blockedProjectId: input.blockedProjectId,
      note: input.note,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`project dependency ${id} vanished immediately after insert`);
    return created;
  }

  /**
   * Remove an edge by id, within the acting tenant. The predicate carries both `organization_id`
   * and `id`, so a cross-tenant id deletes nothing — the service resolves the edge tenant-scoped
   * first.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    edgeId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(projectDependencies)
      .where(
        and(
          eq(projectDependencies.organizationId, context.organizationId),
          eq(projectDependencies.id, edgeId),
        ),
      );
  }
}
