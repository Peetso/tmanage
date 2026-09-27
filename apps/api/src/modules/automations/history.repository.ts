import { and, desc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workflowRuns } from '../../common/database/schema.js';
import type { WorkflowRunRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The workflow-run *history* repository — Automations & integrations (module 17, x164). Read-only over
 * the `workflow_runs` table x163 writes: it lists a tenant's runs across every template and fetches one
 * by id. It never inserts, updates or deletes — history is append-only, produced by x163's run path.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, as the sibling
 * repositories honour it:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking another studio's automation history.
 * 3. **The tenant comes from the context, never a parameter a request controls.** A `status` filter or
 *    a `runId` never widens the tenant scope; both are additional predicates ANDed onto it.
 */

export interface ListWorkflowRunsOptions {
  /** Optional exact-match filter on the run status. Already allowlist-validated by the controller. */
  readonly status?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class WorkflowRunHistoryRepository {
  /**
   * List a tenant's runs across all templates, newest first, within the acting tenant.
   *
   * The order is `started_at` descending with `id` as the tiebreak, so two runs that share a
   * `started_at` (the write records identical start/finish instants) still sort stably. Both the tenant
   * predicate and an optional exact-match `status` predicate are present; the page is bounded to
   * `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListWorkflowRunsOptions = {},
  ): Promise<readonly WorkflowRunRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(workflowRuns.organizationId, context.organizationId)];
    if (options.status !== undefined) predicates.push(eq(workflowRuns.status, options.status));

    return db
      .select()
      .from(workflowRuns)
      .where(and(...predicates))
      .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
      .limit(limit);
  }

  /**
   * Fetch one run by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row. A
   * cross-tenant or unknown id resolves to null here, which the controller turns into a 404 before any
   * authorization decision — the existence of another tenant's run is never revealed as a 403.
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
}
