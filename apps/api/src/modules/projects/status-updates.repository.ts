import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectStatusUpdates } from '../../common/database/schema.js';
import type { ProjectStatusUpdateRow } from '../../common/database/schema.js';
import type { PROJECT_STATUS_BANDS } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project internal-status-update repository — PROJ / module 8 (x235), following the
 * `risk-register` / `project-objectives` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never the DTO ({@link CreateProjectStatusUpdateInput} has no
 * `organizationId`), and the tenant predicate is on every statement. The log is append-only: there is
 * no `update` and no `delete`.
 */

export type ProjectStatusBand = (typeof PROJECT_STATUS_BANDS)[number];

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateProjectStatusUpdateInput {
  readonly projectId: string;
  readonly statusBand: ProjectStatusBand;
  readonly body: string;
  /** The person who posted the update — the service passes `context.userId`. */
  readonly postedBy: string;
}

export interface ListProjectStatusUpdatesOptions {
  /** Required: this slice lists one project's log, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
  /** Keyset cursor: return updates strictly older than this id (exclusive). */
  readonly before?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectStatusUpdatesRepository {
  /**
   * List one project's status updates, within the acting tenant, newest first.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is `posted_at DESC,
   * id DESC`: the log reads newest-first, and `id` (UUIDv7, time-ordered) is the deterministic
   * tiebreaker and the keyset cursor. A `before` id pages to strictly older rows.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectStatusUpdatesOptions,
  ): Promise<readonly ProjectStatusUpdateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(projectStatusUpdates)
      .where(
        and(
          eq(projectStatusUpdates.organizationId, context.organizationId),
          eq(projectStatusUpdates.projectId, options.projectId),
          ...(options.before ? [lt(projectStatusUpdates.id, options.before)] : []),
        ),
      )
      .orderBy(desc(projectStatusUpdates.postedAt), desc(projectStatusUpdates.id))
      .limit(limit);
  }

  /**
   * Fetch one update by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    updateId: string,
  ): Promise<ProjectStatusUpdateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectStatusUpdates)
      .where(
        and(
          eq(projectStatusUpdates.organizationId, context.organizationId),
          eq(projectStatusUpdates.id, updateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Post a status update.
   *
   * The id is generated here (UUIDv7) so a command knows it before the insert commits.
   * `organization_id` comes from the context, never from `input`. The project is not checked to
   * belong to the tenant here: the composite foreign key `fk_project_status_updates_project_tenant`
   * includes `organization_id`, so the database refuses a project from another tenant. (The service
   * resolves the project first, to map an unknown id to 404 rather than a foreign-key 500.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectStatusUpdateInput,
  ): Promise<ProjectStatusUpdateRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectStatusUpdates).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      statusBand: input.statusBand,
      body: input.body,
      postedBy: input.postedBy,
      postedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `posted_at`.
    const row = await this.findById(runner, context, id);
    if (!row) {
      // Unreachable: the row was just inserted under this tenant. Guards the non-null return.
      throw new Error(`project status update ${id} was not found after insert`);
    }
    return row;
  }
}
