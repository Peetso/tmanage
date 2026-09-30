import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { automationVariables } from '../../common/database/schema.js';
import type { AutomationVariableRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The automation-variables repository — Automations & integrations (module 17, x305). It owns the
 * org-scoped, non-secret `(var_key -> var_value)` map a workflow template may reference: list them,
 * upsert one, remove one, and nothing else.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link UpsertAutomationVariableInput} has
 *    no `organizationId`, so a request cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller upserts. No `organizationId` (from the context). `varKey` is already validated
 * against the safe-identifier allowlist and rejected if secret-like; `varValue` is already length-
 * checked. `updatedBy` is the acting user.
 */
export interface UpsertAutomationVariableInput {
  readonly varKey: string;
  readonly varValue: string;
  /** The person writing the variable — the controller passes `context.userId`. */
  readonly updatedBy: string;
}

export class AutomationVariablesRepository {
  /**
   * Every variable this organization holds, key-ascending, within the acting tenant. The tenant
   * predicate is present; `var_key` ascending is the read order so the table renders stably.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AutomationVariableRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(automationVariables)
      .where(eq(automationVariables.organizationId, context.organizationId))
      .orderBy(asc(automationVariables.varKey));
  }

  /**
   * Fetch one variable by key, within the acting tenant. No `findByKey(key)` without a context: on
   * MySQL that would return another customer's row. A cross-tenant key resolves to null here.
   */
  async findByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    varKey: string,
  ): Promise<AutomationVariableRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(automationVariables)
      .where(
        and(
          eq(automationVariables.organizationId, context.organizationId),
          eq(automationVariables.varKey, varKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace one variable.
   *
   * A single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_automation_variables_org_key`: two saves
   * racing for one (org, var_key) serialise on the unique key rather than on a row this code read
   * first, so a lost update is not expressible. The id and tenant come from here, never from `input`;
   * the update path moves only `var_value` and `updated_by`, and `updated_at` follows by the column's
   * `ON UPDATE`. The row is read back so the server-assigned `updated_at` is the one returned.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertAutomationVariableInput,
  ): Promise<AutomationVariableRow> {
    const db = tenantDrizzle(runner);

    await db
      .insert(automationVariables)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        varKey: input.varKey,
        varValue: input.varValue,
        updatedBy: input.updatedBy,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { varValue: input.varValue, updatedBy: input.updatedBy } });

    const saved = await this.findByKey(runner, context, input.varKey);
    if (!saved) throw new Error(`automation variable ${input.varKey} vanished after upsert`);
    return saved;
  }

  /**
   * Remove one variable within the acting tenant. Idempotent: deleting an absent key affects no rows
   * and is not an error, so the controller answers 204 either way.
   */
  async remove(runner: TenantQueryRunner, context: TenantContext, varKey: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(automationVariables)
      .where(
        and(
          eq(automationVariables.organizationId, context.organizationId),
          eq(automationVariables.varKey, varKey),
        ),
      );
  }
}
