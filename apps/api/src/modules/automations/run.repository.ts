import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workflowRuns } from '../../common/database/schema.js';
import type { WorkflowRunDetail, WorkflowRunRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The workflow-runs repository — Automations & integrations (module 17, x163), following the
 * `templates.repository` pattern. It owns the org-scoped, append-only record of one template
 * execution.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link RecordWorkflowRunInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller records. No `organizationId` (from the context). `templateId` is a template the
 * controller has already resolved *within the acting tenant* before this is called, so the composite
 * foreign key can never point across a tenant boundary. `status` is already allowlist-validated.
 */
export interface RecordWorkflowRunInput {
  readonly templateId: string;
  readonly status: string;
  readonly detail: WorkflowRunDetail;
}

export class WorkflowRunsRepository {
  /**
   * Fetch one run by id, within the acting tenant. No `findById(id)` without a context: on MySQL that
   * would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    runId: string,
  ): Promise<WorkflowRunRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(
        and(eq(workflowRuns.organizationId, context.organizationId), eq(workflowRuns.id, runId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record a run.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated timestamps are the ones returned
   * rather than a hand-assembled guess.
   */
  async record(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: RecordWorkflowRunInput,
  ): Promise<WorkflowRunRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(workflowRuns).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      templateId: input.templateId,
      status: input.status,
      detailJson: input.detail,
      startedAt: sql`current_timestamp(3)`,
      finishedAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`workflow run ${id} vanished after insert`);
    return created;
  }
}
