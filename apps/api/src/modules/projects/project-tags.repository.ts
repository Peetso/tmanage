import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectTags } from '../../common/database/schema.js';
import type { ProjectTagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Project tags — x267's storage half (Projects / portfolio module).
 *
 * One table serves two row kinds (see `0137_project_tags.sql`): a **definition** row carries `name`
 * with `project_id`/`tag_id` NULL; an **assignment** row carries `project_id` + `tag_id` with `name`
 * NULL. Every read and write is bound to `(organization_id, …)`, so a caller in the wrong tenant
 * sees nothing rather than a leak, and the repository holds no policy — the service decides who may
 * read or write, and the composite foreign keys of migration 0137 make a cross-tenant project or tag
 * id a non-existent pair. The `work_item_labels` repository (x233) is the sibling this mirrors.
 */

/** The largest tag page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_PROJECT_TAGS_PAGE = 500;

export class ProjectTagsRepository {
  /** The tenant's tag definitions, name-ascending, bounded to one page. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_PROJECT_TAGS_PAGE,
  ): Promise<readonly ProjectTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(projectTags)
      .where(
        and(eq(projectTags.organizationId, context.organizationId), isNull(projectTags.projectId)),
      )
      .orderBy(asc(projectTags.name), asc(projectTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_PROJECT_TAGS_PAGE));
  }

  /** One tag definition, scoped to the tenant; `null` if absent (or if the id names an assignment). */
  async findDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    tagId: string,
  ): Promise<ProjectTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectTags)
      .where(
        and(
          eq(projectTags.organizationId, context.organizationId),
          eq(projectTags.id, tagId),
          isNull(projectTags.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A definition with this name in the tenant; `null` if the name is free. */
  async findDefinitionByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<ProjectTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectTags)
      .where(
        and(
          eq(projectTags.organizationId, context.organizationId),
          eq(projectTags.name, name),
          isNull(projectTags.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a tag. Definition rows carry `name` and NULL `project_id`/`tag_id`. */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<ProjectTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(projectTags)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: null,
        tagId: null,
        name,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findDefinition(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('project tag definition vanished immediately after insert');
    }
    return created;
  }

  /** The assignment rows for one project of this tenant. */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number = MAX_PROJECT_TAGS_PAGE,
  ): Promise<readonly ProjectTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(projectTags)
      .where(
        and(
          eq(projectTags.organizationId, context.organizationId),
          eq(projectTags.projectId, projectId),
        ),
      )
      .orderBy(asc(projectTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_PROJECT_TAGS_PAGE));
  }

  /** One assignment of a tag to a project, scoped to the tenant; `null` if not tagged. */
  async findAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    tagId: string,
  ): Promise<ProjectTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectTags)
      .where(
        and(
          eq(projectTags.organizationId, context.organizationId),
          eq(projectTags.projectId, projectId),
          eq(projectTags.tagId, tagId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Tag a project with a tag. Assignment rows carry `project_id` + `tag_id`. */
  async createAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    tagId: string,
  ): Promise<ProjectTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(projectTags)
      .values({
        id,
        organizationId: context.organizationId,
        projectId,
        tagId,
        name: null,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findAssignment(runner, context, projectId, tagId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('project tag assignment vanished immediately after insert');
    }
    return created;
  }

  /** Untag: remove a tag assignment from a project. `true` if a row was removed. */
  async deleteAssignment(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    tagId: string,
  ): Promise<boolean> {
    const existing = await this.findAssignment(runner, context, projectId, tagId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(projectTags)
      .where(
        and(
          eq(projectTags.organizationId, context.organizationId),
          eq(projectTags.projectId, projectId),
          eq(projectTags.tagId, tagId),
        ),
      );
    return true;
  }
}
