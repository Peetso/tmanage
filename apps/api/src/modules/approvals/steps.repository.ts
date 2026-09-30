import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvalSteps } from '../../common/database/schema.js';
import type { ApprovalStepRow, ApprovalStepState } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Sequential approval steps — x315's storage half (Requests, decisions & approvals; migration 0183).
 * Follows the `conditions.repository` / `approvals.repository` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** The create inputs carry no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 */

/**
 * One step to define — no `organizationId` (from the context) and no `approvalId` (the controller has
 * already resolved the approval *within the acting tenant* before this is called, so the composite
 * foreign key can never point across a tenant boundary). `state` is not a caller input: a fresh step
 * is always `pending`.
 */
export interface DefineApprovalStepInput {
  readonly position: number;
  readonly approverRole: string;
  readonly approverUserId: string | null;
}

/** The facts a step decision writes. `state` is already allowlist-validated. */
export interface DecideApprovalStepInput {
  readonly state: ApprovalStepState;
  readonly decidedBy: string;
}

export class ApprovalStepsRepository {
  /**
   * List an approval's steps, in position order, within the acting tenant. Both the tenant and
   * approval predicates are present; `position` ascending is the chain order.
   */
  async listForApproval(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
  ): Promise<readonly ApprovalStepRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(approvalSteps)
      .where(
        and(
          eq(approvalSteps.organizationId, context.organizationId),
          eq(approvalSteps.approvalId, approvalId),
        ),
      )
      .orderBy(asc(approvalSteps.position));
  }

  /**
   * Fetch one step by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    stepId: string,
  ): Promise<ApprovalStepRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(approvalSteps)
      .where(
        and(eq(approvalSteps.organizationId, context.organizationId), eq(approvalSteps.id, stepId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Define an approval's chain — insert every provided step in one unit of work. Ids are generated
   * here (UUIDv7, `07-DATA-MODEL`); `organization_id` comes from the context, never from input;
   * `state` starts `pending`. The rows are read back in position order so the server-generated
   * `created_at` is the one returned rather than a hand-assembled guess.
   */
  async define(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
    steps: readonly DefineApprovalStepInput[],
  ): Promise<readonly ApprovalStepRow[]> {
    const db = tenantDrizzle(runner);
    for (const step of steps) {
      await db.insert(approvalSteps).values({
        id: uuidv7(),
        // From the context. Not from input — there is no such field.
        organizationId: context.organizationId,
        approvalId,
        position: step.position,
        approverRole: step.approverRole,
        approverUserId: step.approverUserId,
        state: 'pending',
        decidedBy: null,
        decidedAt: null,
        createdAt: sql`current_timestamp(3)`,
      });
    }
    return this.listForApproval(runner, context, approvalId);
  }

  /**
   * Record a step's decision — the `state`, the `decided_by`, and the `decided_at` in one statement,
   * scoped by tenant and step id. The identity columns are untouched (and the 0183 trigger refuses
   * any attempt to change them). The row is read back so the server-generated `decided_at` is the
   * one returned.
   */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    stepId: string,
    input: DecideApprovalStepInput,
  ): Promise<ApprovalStepRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(approvalSteps)
      .set({
        state: input.state,
        decidedBy: input.decidedBy,
        decidedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(eq(approvalSteps.organizationId, context.organizationId), eq(approvalSteps.id, stepId)),
      );
    const updated = await this.findById(runner, context, stepId);
    if (!updated) throw new Error(`approval step ${stepId} vanished after update`);
    return updated;
  }
}
