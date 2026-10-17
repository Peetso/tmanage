import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingCostCenters, projects } from '../../common/database/schema.js';
import type { BillingCostCenterRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & entitlements (module 19, x281). The cost-centers repository — the data-access layer behind
 * billing cost centers and their project assignments, following the `billing_usage_alerts` repository
 * pattern (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** No input carries an `organizationId`, so a
 *    request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 *
 * One table holds two row kinds (0150): a `def` row carries the display `name` for a `code`, and an
 * `assignment` row shares that `code` and sets a `project_id`. The service validates `code`/`name` and
 * makes the authorization decision; this layer only reads and writes tenant-scoped rows.
 */

/** What the service creates as a cost-center definition. No `organizationId` (it comes from context). */
export interface CreateCostCenterDefInput {
  readonly code: string;
  readonly name: string;
}

export class CostCentersRepository {
  /** All cost-center definition rows for the acting tenant, code-ascending. */
  async listDefs(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingCostCenterRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'def'),
        ),
      )
      .orderBy(asc(billingCostCenters.code));
  }

  /**
   * The assignment rows for the given cost-center codes, within the acting tenant. Used to build each
   * definition's assigned project ids in one read rather than a query per definition.
   */
  async listAssignmentsForCodes(
    runner: TenantQueryRunner,
    context: TenantContext,
    codes: readonly string[],
  ): Promise<readonly BillingCostCenterRow[]> {
    if (codes.length === 0) return [];
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'assignment'),
          inArray(billingCostCenters.code, [...codes]),
        ),
      )
      .orderBy(asc(billingCostCenters.code), asc(billingCostCenters.projectId));
  }

  /**
   * Fetch one cost-center definition by id, within the acting tenant. No `findById(id)` without a
   * context: on MySQL that would return another customer's row. A cross-tenant id resolves to null.
   */
  async findDefById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingCostCenterRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'def'),
          eq(billingCostCenters.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The definition for a code, within the acting tenant, or null. Used to reject a duplicate code. */
  async findDefByCode(
    runner: TenantQueryRunner,
    context: TenantContext,
    code: string,
  ): Promise<BillingCostCenterRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'def'),
          eq(billingCostCenters.code, code),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolve a project by id, within the acting tenant. Returns the id when it exists for this tenant,
   * else null — so a cross-tenant or missing project id is a 404 the service raises, never a
   * foreign-key surprise on insert.
   */
  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Create a cost-center definition. The id is generated here (UUIDv7); `organization_id` comes from
   * the context, never from `input`. The row is read back so the server-generated timestamp is
   * returned. The `(organization_id, def_code)` unique index (`def_code` trigger-maintained by
   * `trg_billing_cost_centers_def_code_ins`) is the backstop against a duplicate code
   * the service also guards.
   */
  async createDef(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateCostCenterDefInput,
  ): Promise<BillingCostCenterRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingCostCenters).values({
      id,
      organizationId: context.organizationId,
      rowKind: 'def',
      code: input.code,
      name: input.name,
      projectId: null,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findDefById(runner, context, id);
    if (!created) throw new Error(`billing cost center ${id} vanished after insert`);
    return created;
  }

  /**
   * Assign a project to a cost-center code, within the acting tenant. Idempotent: a repeat assignment
   * collides on `(organization_id, code, project_id)` and the `ON DUPLICATE KEY UPDATE id = id` no-op
   * leaves the existing row untouched, so a second PUT is not a second row.
   */
  async assign(
    runner: TenantQueryRunner,
    context: TenantContext,
    code: string,
    projectId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .insert(billingCostCenters)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        rowKind: 'assignment',
        code,
        name: null,
        projectId,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  }

  /**
   * Remove a project assignment from a cost-center code, within the acting tenant. Idempotent: a delete
   * that matches no row is a no-op, so a repeat DELETE is still a 204.
   */
  async unassign(
    runner: TenantQueryRunner,
    context: TenantContext,
    code: string,
    projectId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'assignment'),
          eq(billingCostCenters.code, code),
          eq(billingCostCenters.projectId, projectId),
        ),
      );
  }

  /**
   * Delete a cost center: the definition and every assignment that shares its code, within the acting
   * tenant. Both statements carry the tenant predicate; the code is resolved by the service from the
   * definition row before this is called.
   */
  async removeByCode(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    code: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'assignment'),
          eq(billingCostCenters.code, code),
        ),
      );
    await db
      .delete(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'def'),
          eq(billingCostCenters.id, id),
        ),
      );
  }
}
