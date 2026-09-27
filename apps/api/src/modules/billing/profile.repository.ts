import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingProfiles } from '../../common/database/schema.js';
import type { BillingAddress, BillingProfileRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The billing-profile repository — module 19 (x180), following the notification-preferences pattern.
 * It owns the org-scoped billing profile: read one, upsert one, and nothing else.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * notification-preferences repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link BillingProfileInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * ## The write is one upsert, not a read-then-write
 *
 * {@link upsert} is a single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_billing_profiles_org`.
 * Two saves racing for one organization's row serialise on the unique key rather than on a row this
 * code read first, so a lost update is not expressible and one organization can never accumulate two
 * profiles. The insert path fills `id` and the create timestamp; the update path leaves both alone
 * and moves only the metadata, and `updated_at` follows by the column's `ON UPDATE`.
 */

/** The billing metadata a caller can set — everything on the row except identity and timestamps. */
export interface BillingProfileInput {
  readonly billingEmail: string | null;
  readonly companyName: string | null;
  readonly taxId: string | null;
  readonly address: BillingAddress;
}

export class BillingProfileRepository {
  /** Read the acting tenant's billing profile, or null when none has been saved. */
  async find(runner: TenantQueryRunner, context: TenantContext): Promise<BillingProfileRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace the acting tenant's billing profile. Idempotent by the org unique key. */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BillingProfileInput,
  ): Promise<BillingProfileRow> {
    await tenantDrizzle(runner)
      .insert(billingProfiles)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        billingEmail: input.billingEmail,
        companyName: input.companyName,
        taxId: input.taxId,
        addressJson: input.address,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          billingEmail: input.billingEmail,
          companyName: input.companyName,
          taxId: input.taxId,
          addressJson: input.address,
        },
      });

    // Read back so the server-generated timestamps and the persisted row are what is returned,
    // never a hand-assembled guess. Tenant-scoped, so the read cannot cross a tenant boundary.
    const saved = await tenantDrizzle(runner)
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.organizationId, context.organizationId))
      .limit(1);
    // The row was just written under the same tenant predicate; `and(eq(...))` is redundant with the
    // single-org unique key, so a bare `[0]` is the persisted row.
    return saved[0] as BillingProfileRow;
  }
}
