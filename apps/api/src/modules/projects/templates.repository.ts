import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectTemplates } from '../../common/database/schema.js';
import type { ProjectTemplateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-templates repository — PROJ / module 8 (x234), following the `org-objectives` shape (a
 * tenant-owned record with no `project_id`).
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first two
 * parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the tenant
 * comes from the context and never the DTO ({@link CreateProjectTemplateInput} has no
 * `organizationId`), and the tenant predicate is on every statement.
 */

/** Raised when a template with the same name already exists in the tenant — the service maps it to 409. */
export class DuplicateProjectTemplateNameError extends Error {
  constructor(readonly templateName: string) {
    // No organization id in the message: a conflict must not let a probe for another tenant's template
    // tell "exists here" from "exists elsewhere".
    super(`A project template named "${templateName}" already exists`);
    this.name = 'DuplicateProjectTemplateNameError';
  }
}

export class ProjectTemplateNotFoundError extends Error {
  constructor(readonly templateId: string) {
    super(`Project template ${templateId} was not found`);
    this.name = 'ProjectTemplateNotFoundError';
  }
}

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateProjectTemplateInput {
  readonly name: string;
  readonly description?: string | null;
  readonly defaultObjectives?: readonly string[];
  /** The person who authored the template — the service passes `context.userId`. */
  readonly createdBy: string;
}

export interface ListProjectTemplatesOptions {
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectTemplatesRepository {
  /**
   * List the tenant's templates in creation order.
   *
   * The `organization_id` predicate is not optional; the order is `created_at ASC, id ASC`, with `id`
   * (UUIDv7) the deterministic tiebreaker.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectTemplatesOptions = {},
  ): Promise<readonly ProjectTemplateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(projectTemplates)
      .where(eq(projectTemplates.organizationId, context.organizationId))
      .orderBy(asc(projectTemplates.createdAt), asc(projectTemplates.id))
      .limit(limit);
  }

  /**
   * Fetch one template by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<ProjectTemplateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectTemplates)
      .where(
        and(
          eq(projectTemplates.organizationId, context.organizationId),
          eq(projectTemplates.id, templateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<ProjectTemplateRow> {
    const found = await this.findById(runner, context, templateId);
    if (!found) throw new ProjectTemplateNotFoundError(templateId);
    return found;
  }

  /**
   * Author a template.
   *
   * The name is pre-checked for an existing template inside the caller's transaction, so a duplicate is
   * a {@link DuplicateProjectTemplateNameError} the service maps to 409; the `uq_project_templates_org_name`
   * unique key is the backstop for the race the pre-check cannot see. `organization_id` comes from the
   * context, never from `input`. The id is generated here (UUIDv7) so a command knows it before commit.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectTemplateInput,
  ): Promise<ProjectTemplateRow> {
    const db = tenantDrizzle(runner);

    const existing = await db
      .select({ id: projectTemplates.id })
      .from(projectTemplates)
      .where(
        and(
          eq(projectTemplates.organizationId, context.organizationId),
          eq(projectTemplates.name, input.name),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new DuplicateProjectTemplateNameError(input.name);
    }

    const id = uuidv7();
    await db.insert(projectTemplates).values({
      id,
      organizationId: context.organizationId,
      name: input.name,
      description: input.description ?? null,
      defaultObjectivesJson: input.defaultObjectives ?? null,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }
}
