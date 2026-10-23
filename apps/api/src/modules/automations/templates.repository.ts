import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workflowTemplates } from '../../common/database/schema.js';
import type { WorkflowTemplateConfig, WorkflowTemplateRow } from '../../common/database/schema.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * The workflow-templates repository — Automations & integrations (module 17, x162), following the
 * `work_forms` pattern. It owns the org-scoped automation template definition.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * work-forms repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateWorkflowTemplateInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller creates. No `organizationId` (from the context), so a request body cannot
 * choose the tenant it writes into. `triggerKind` and `actionKind` are already allowlist-validated by
 * the controller before this is called.
 */
export interface CreateWorkflowTemplateInput {
  readonly name: string;
  readonly triggerKind: string;
  readonly actionKind: string;
  readonly config: WorkflowTemplateConfig;
  readonly enabled: boolean;
  /** The person creating the template — the controller passes `context.userId`. */
  readonly createdBy: string;
}

export interface ListWorkflowTemplatesOptions {
  /** Keyset pagination. Cursors are ids, and the walk is over `(organization_id, id)`. */
  readonly after?: string;
  readonly limit?: number;
}

/**
 * A partial edit of an existing template (Automations & integrations, module 17, x189). Every field
 * is optional: only the ones present are written, so a rename touches `name` alone and leaves the
 * trigger, action, config and enabled flag as they were. Identity is *not* here — `organizationId`
 * and `createdBy` are what a template is (the schema's `BEFORE UPDATE` trigger holds them at the
 * engine), so an edit cannot re-tenant or re-author a template. `triggerKind`/`actionKind` are
 * already allowlist-validated by the controller before this is called.
 */
export interface UpdateWorkflowTemplateInput {
  readonly name?: string;
  readonly triggerKind?: string;
  readonly actionKind?: string;
  readonly config?: WorkflowTemplateConfig;
  readonly enabled?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class WorkflowTemplatesRepository {
  /**
   * List a tenant's templates, name-ascending then id, within the acting tenant.
   *
   * Both the tenant predicate and a deterministic order are present: `name` ascending is the list
   * order, with `id` as the tiebreak so two templates that share a name still sort stably and page
   * without repeats. Bounded to `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListWorkflowTemplatesOptions = {},
  ): Promise<readonly WorkflowTemplateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(workflowTemplates.organizationId, context.organizationId),
      isNull(workflowTemplates.deletedAt),
    ];
    if (options.after) predicates.push(gt(workflowTemplates.id, options.after));

    return db
      .select()
      .from(workflowTemplates)
      .where(and(...predicates))
      .orderBy(asc(workflowTemplates.name), asc(workflowTemplates.id))
      .limit(limit);
  }

  /**
   * Fetch one template by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row. A
   * cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<WorkflowTemplateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.organizationId, context.organizationId),
          eq(workflowTemplates.id, templateId),
          isNull(workflowTemplates.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one template by name, within the acting tenant (x219, clone collision check).
   *
   * The predicate carries the composite tenant key `(organization_id, name)`, so a name that exists
   * only in another customer's tenant resolves to null here — a clone's collision check can never see
   * across tenants. Used before a clone insert to turn a duplicate name into a 409 rather than a
   * second row: `workflow_templates` has no unique-name constraint (the define/list path allows two
   * templates to share a name), so the clone enforces uniqueness in the application, tenant-scoped.
   */
  async findByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<WorkflowTemplateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(workflowTemplates)
      .where(
        and(
          eq(workflowTemplates.organizationId, context.organizationId),
          eq(workflowTemplates.name, name),
          isNull(workflowTemplates.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a template.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one
   * returned rather than a hand-assembled guess.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkflowTemplateInput,
  ): Promise<WorkflowTemplateRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(workflowTemplates).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      name: input.name,
      triggerKind: input.triggerKind,
      actionKind: input.actionKind,
      configJson: input.config,
      enabled: input.enabled,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`workflow template ${id} vanished after insert`);
    return created;
  }

  /**
   * Apply a partial edit to one template, within the acting tenant (x189).
   *
   * The `UPDATE` predicate carries the composite tenant key `(organization_id, id)`, not the id
   * alone: a cross-tenant id updates zero rows and the read-back returns null, so an edit can never
   * touch another customer's template even if a bad id reached the repository. Only the fields
   * present in `input` are written; identity (`organization_id`, `created_by`) is never in the set,
   * and the schema trigger rejects a change to it regardless. The row is read back so the returned
   * view reflects exactly what the engine holds. Returns null if no such tenant-owned row exists.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    input: UpdateWorkflowTemplateInput,
  ): Promise<WorkflowTemplateRow | null> {
    const db = tenantDrizzle(runner);

    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set['name'] = input.name;
    if (input.triggerKind !== undefined) set['triggerKind'] = input.triggerKind;
    if (input.actionKind !== undefined) set['actionKind'] = input.actionKind;
    if (input.config !== undefined) set['configJson'] = input.config;
    if (input.enabled !== undefined) set['enabled'] = input.enabled;

    if (Object.keys(set).length > 0) {
      await db
        .update(workflowTemplates)
        .set(set)
        .where(
          and(
            eq(workflowTemplates.organizationId, context.organizationId),
            eq(workflowTemplates.id, templateId),
          ),
        );
    }

    return this.findById(runner, context, templateId);
  }

  /**
   * Soft-delete one live template, within the acting tenant (A14, 0226). **Must run inside a
   * transaction.**
   *
   * The row is first locked with `FOR UPDATE NOWAIT`. A run in flight holds a lock on this row
   * until it commits — inserting its `workflow_runs` row takes a shared lock on the parent template
   * through the composite foreign key — so the lock fails at once instead of queueing behind it,
   * and the caller turns that into a 409. Then the row is stamped `deleted_at` and turned off, so
   * the worker (which reads only enabled rules) never fires it again. Returns false when no live
   * tenant-owned row has that id.
   */
  async softDelete(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<boolean> {
    const locked = await runner.execute<QueryRows>(
      `select id from workflow_templates
        where organization_id = ? and id = ? and deleted_at is null
        for update nowait`,
      [context.organizationId, templateId],
    );
    if (locked.length === 0) return false;

    await tenantDrizzle(runner)
      .update(workflowTemplates)
      .set({ deletedAt: sql`current_timestamp(3)`, enabled: false })
      .where(
        and(
          eq(workflowTemplates.organizationId, context.organizationId),
          eq(workflowTemplates.id, templateId),
        ),
      );
    return true;
  }
}

/**
 * Whether a database error is the engine refusing a `NOWAIT` lock because another transaction holds
 * the row: MySQL 8 answers `ER_LOCK_NOWAIT` (3572); MariaDB answers `ER_LOCK_WAIT_TIMEOUT` (1205).
 */
export function isRowLockedError(error: unknown): boolean {
  const errno = (error as { errno?: unknown } | null)?.errno;
  const cause = (error as { cause?: { errno?: unknown } } | null)?.cause?.errno;
  return [errno, cause].some((value) => value === 3572 || value === 1205);
}
