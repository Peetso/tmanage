import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingTaxDetails } from '../../common/database/schema.js';
import type { BillingTaxDetailsRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The billing tax / legal-entity details repository — module 19 (x283), following the billing-profile
 * pattern. It owns the org-scoped tax-details row: read one, upsert one, and nothing else.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * billing-profile repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link BillingTaxDetailsInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_billing_tax_details_org`.
 * Two saves racing for one organization's row serialise on the unique key rather than on a row this
 * code read first, so a lost update is not expressible and one organization can never accumulate two
 * rows. The insert path fills `id` and the create timestamp; the update path leaves both alone and
 * moves only the legal/tax fields, and `updated_at` follows by the column's `ON UPDATE`.
 */

/** The tax/legal fields a caller can set — everything on the row except identity and timestamps. */
export interface BillingTaxDetailsInput {
  readonly legalName: string;
  readonly taxId: string | null;
  readonly registrationNo: string | null;
  readonly taxCountry: string;
}

export class BillingTaxDetailsRepository {
  /** Read the acting tenant's tax details, or null when none has been saved. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<BillingTaxDetailsRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingTaxDetails)
      .where(eq(billingTaxDetails.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace the acting tenant's tax details. Idempotent by the org unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BillingTaxDetailsInput,
  ): Promise<BillingTaxDetailsRow> {
    await tenantDrizzle(runner)
      .insert(billingTaxDetails)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        legalName: input.legalName,
        taxId: input.taxId,
        registrationNo: input.registrationNo,
        taxCountry: input.taxCountry,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          legalName: input.legalName,
          taxId: input.taxId,
          registrationNo: input.registrationNo,
          taxCountry: input.taxCountry,
        },
      });

    // Read back so the server-generated timestamps and the persisted row are what is returned, never a
    // hand-assembled guess. Tenant-scoped, so the read cannot cross a tenant boundary.
    const saved = await tenantDrizzle(runner)
      .select()
      .from(billingTaxDetails)
      .where(eq(billingTaxDetails.organizationId, context.organizationId))
      .limit(1);
    // The row was just written under the same tenant predicate; the single-org unique key makes a bare
    // `[0]` the persisted row.
    return saved[0] as BillingTaxDetailsRow;
  }
}
