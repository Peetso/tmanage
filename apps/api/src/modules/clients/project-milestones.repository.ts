import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectMilestones } from '../../common/database/schema.js';
import type { ProjectMilestoneRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-milestones repository — SEC / Portal milestones (x139), following the
 * `project_updates` (0041) pattern exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * sibling repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateProjectMilestoneInput}
 *    has no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export type ProjectMilestoneStatus = ProjectMilestoneRow['status'];

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateProjectMilestoneInput {
  readonly projectId: string;
  readonly title: string;
  /** A 'YYYY-MM-DD' target day, or null when the date is not yet committed. */
  readonly dueOn: string | null;
  readonly status: ProjectMilestoneStatus;
  /** Whether the milestone is client-visible at insert time. This slice sets it here and never edits it. */
  readonly published: boolean;
  /** The person creating the milestone — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export interface ListProjectMilestonesOptions {
  /** Required: this reads one project's milestones, never a whole tenant's. */
  readonly projectId: string;
  /**
   * When true, only `published = 1` rows are selected — the client-visibility gate, applied in
   * the **query** so an unpublished row is never in the result set to be careless with. The
   * client read passes `true`; the internal read passes `false`.
   */
  readonly publishedOnly: boolean;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectMilestonesRepository {
  /**
   * List one project's milestones, within the acting tenant, ordered by target date.
   *
   * Both `organization_id` and `project_id` predicates are present, and — for a client read — so
   * is `published = 1`. The order is `due_on ASC, id ASC`: the timeline a portal shows, with a
   * null date sorting last, and deterministic when two milestones share a day (UUIDv7 ids break
   * the tie in creation order). The `(organization_id, project_id, due_on)` index (0048) serves it.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectMilestonesOptions,
  ): Promise<readonly ProjectMilestoneRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(projectMilestones.organizationId, context.organizationId),
      eq(projectMilestones.projectId, options.projectId),
    ];
    if (options.publishedOnly) predicates.push(eq(projectMilestones.published, true));

    return db
      .select()
      .from(projectMilestones)
      .where(and(...predicates))
      // `due_on` is nullable; a null date sorts last so committed milestones lead the timeline.
      .orderBy(sql`${projectMilestones.dueOn} is null`, asc(projectMilestones.dueOn), asc(projectMilestones.id))
      .limit(limit);
  }

  /**
   * Fetch one milestone by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row,
   * which is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    milestoneId: string,
  ): Promise<ProjectMilestoneRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.organizationId, context.organizationId),
          eq(projectMilestones.id, milestoneId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a project milestone.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is *not*
   * checked to belong to the tenant here: `fk_project_milestones_project_tenant` is a composite
   * foreign key including `organization_id`, so the database refuses a project from another
   * tenant. (The service still resolves the project tenant-scoped first, so a missing/cross-tenant
   * id is a 404 rather than the 500 that foreign key would otherwise surface.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectMilestoneInput,
  ): Promise<ProjectMilestoneRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectMilestones).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      dueOn: input.dueOn,
      status: input.status,
      published: input.published,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps.
    const row = await this.findById(runner, context, id);
    if (!row) throw new Error(`project milestone ${id} vanished immediately after insert`);
    return row;
  }
}
