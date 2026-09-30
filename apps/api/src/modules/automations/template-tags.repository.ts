import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { automationTemplateTags, workflowTemplates } from '../../common/database/schema.js';
import type {
  AutomationTemplateTagRow,
  WorkflowTemplateRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The automation-template-tags repository — Automations & integrations (module 17, x335), following
 * the `conditions.repository` / `templates.repository` pattern. It owns the org-scoped free-text tags
 * that categorise a workflow template.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateAutomationTemplateTagInput}
 *    has no `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller creates. No `organizationId` (from the context). `templateId` is a template the
 * controller has already resolved *within the acting tenant* before this is called, so the composite
 * foreign key can never point across a tenant boundary. `label` is already normalised and
 * length-checked by the service.
 */
export interface CreateAutomationTemplateTagInput {
  readonly templateId: string;
  readonly label: string;
  /** The person creating the tag — the controller passes `context.userId`. */
  readonly createdBy: string;
}

export class AutomationTemplateTagsRepository {
  /**
   * List a template's tags, label-ascending then id, within the acting tenant. Both the tenant and
   * template predicates are present; `label` ascending is the read order with `id` as the tiebreak so
   * the list is stable.
   */
  async listForTemplate(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<readonly AutomationTemplateTagRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(automationTemplateTags)
      .where(
        and(
          eq(automationTemplateTags.organizationId, context.organizationId),
          eq(automationTemplateTags.workflowTemplateId, templateId),
        ),
      )
      .orderBy(asc(automationTemplateTags.label), asc(automationTemplateTags.id));
  }

  /**
   * Fetch one tag by id, within the acting tenant. No `findById(id)` without a context: on MySQL that
   * would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    tagId: string,
  ): Promise<AutomationTemplateTagRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(automationTemplateTags)
      .where(
        and(
          eq(automationTemplateTags.organizationId, context.organizationId),
          eq(automationTemplateTags.id, tagId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one tag on a template by its normalised label, within the acting tenant — the duplicate
   * (409) pre-check. The predicate carries the composite tenant key and the template id, so a label
   * that exists only on another studio's template resolves to null here. Matching is case-insensitive
   * through the table collation, the same folding the unique key enforces, so `Urgent` finds `urgent`.
   */
  async findByLabel(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    label: string,
  ): Promise<AutomationTemplateTagRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(automationTemplateTags)
      .where(
        and(
          eq(automationTemplateTags.organizationId, context.organizationId),
          eq(automationTemplateTags.workflowTemplateId, templateId),
          eq(automationTemplateTags.label, label),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List the acting tenant's templates that carry `label`, name-ascending then id. The join is
   * read-only and tenant-scoped on both sides: the tag predicate and the template predicate both carry
   * `organization_id`, so a cross-tenant label can never surface another studio's templates. Label
   * matching is case-insensitive through the table's `utf8mb4_unicode_ci` collation, the same folding
   * the unique key enforces. The service has already normalised the incoming label.
   */
  async listTemplatesByTag(
    runner: TenantQueryRunner,
    context: TenantContext,
    label: string,
  ): Promise<readonly WorkflowTemplateRow[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ template: workflowTemplates })
      .from(automationTemplateTags)
      .innerJoin(
        workflowTemplates,
        and(
          eq(workflowTemplates.organizationId, automationTemplateTags.organizationId),
          eq(workflowTemplates.id, automationTemplateTags.workflowTemplateId),
        ),
      )
      .where(
        and(
          eq(automationTemplateTags.organizationId, context.organizationId),
          eq(automationTemplateTags.label, label),
        ),
      )
      .orderBy(asc(workflowTemplates.name), asc(workflowTemplates.id));
    return rows.map((row) => row.template);
  }

  /**
   * Create a tag.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one returned.
   * A duplicate `(organization_id, workflow_template_id, label)` raises the unique-key violation the
   * service turns into a 409 — the repository does not swallow it.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAutomationTemplateTagInput,
  ): Promise<AutomationTemplateTagRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(automationTemplateTags).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      workflowTemplateId: input.templateId,
      label: input.label,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`automation template tag ${id} vanished after insert`);
    return created;
  }

  /**
   * Delete one tag from a template, within the acting tenant. The `DELETE` predicate carries the
   * composite tenant key and the template id, so a cross-tenant or wrong-template id removes zero rows.
   * Returns whether a row was removed; the controller is idempotent regardless (a missing tag is a
   * 204, not a 404 — the resource is already absent), but the flag lets a caller distinguish the two.
   */
  async deleteForTemplate(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    tagId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(automationTemplateTags)
      .where(
        and(
          eq(automationTemplateTags.organizationId, context.organizationId),
          eq(automationTemplateTags.workflowTemplateId, templateId),
          eq(automationTemplateTags.id, tagId),
        ),
      );

    return result[0].affectedRows > 0;
  }
}
