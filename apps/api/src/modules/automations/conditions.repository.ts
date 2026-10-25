import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workflowConditions } from '../../common/database/schema.js';
import type { WorkflowConditionOp, WorkflowConditionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The workflow-conditions repository — Automations & integrations (module 17, x190), following the
 * `templates.repository` / `run.repository` pattern. It owns the org-scoped per-step conditions that
 * gate a template's actions.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateWorkflowConditionInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller creates. No `organizationId` (from the context). `templateId` is a template the
 * controller has already resolved *within the acting tenant* before this is called, so the composite
 * foreign key can never point across a tenant boundary. `op` is already allowlist-validated.
 */
export interface CreateWorkflowConditionInput {
  readonly templateId: string;
  readonly field: string;
  readonly op: WorkflowConditionOp;
  readonly value: string;
  readonly targetStep: number;
  /** The person creating the condition — the controller passes `context.userId`. */
  readonly createdBy: string;
}

export class WorkflowConditionsRepository {
  /**
   * List a template's conditions, in step order then id, within the acting tenant. The tenant and
   * template predicates are both present; `target_step` ascending is the read order with `id` as the
   * tiebreak so two conditions on the same step still sort stably.
   */
  async listForTemplate(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<readonly WorkflowConditionRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(workflowConditions)
      .where(
        and(
          eq(workflowConditions.organizationId, context.organizationId),
          eq(workflowConditions.templateId, templateId),
        ),
      )
      .orderBy(asc(workflowConditions.targetStep), asc(workflowConditions.id));
  }

  /**
   * Fetch one condition by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    conditionId: string,
  ): Promise<WorkflowConditionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(workflowConditions)
      .where(
        and(
          eq(workflowConditions.organizationId, context.organizationId),
          eq(workflowConditions.id, conditionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * C1 — remove one condition of one template, within the acting tenant. All three predicates
   * (tenant, template, id) are on the statement, so an id from another template or another studio
   * deletes nothing. Returns whether a row was removed.
   */
  async deleteForTemplate(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    conditionId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const result = await db
      .delete(workflowConditions)
      .where(
        and(
          eq(workflowConditions.organizationId, context.organizationId),
          eq(workflowConditions.templateId, templateId),
          eq(workflowConditions.id, conditionId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Create a condition.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one returned
   * rather than a hand-assembled guess.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkflowConditionInput,
  ): Promise<WorkflowConditionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(workflowConditions).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      templateId: input.templateId,
      field: input.field,
      op: input.op,
      value: input.value,
      targetStep: input.targetStep,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`workflow condition ${id} vanished after insert`);
    return created;
  }
}
