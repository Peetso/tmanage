import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingContacts } from '../../common/database/schema.js';
import type { BillingContactRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { BillingContactInput, BillingContactsStore } from './contacts.service.js';

/**
 * Billing contacts — x199's storage half (Billing module 19). The one place that holds a driver handle
 * (the `no-restricted-imports` boundary, `25-AUTH-AND-TENANT-ISOLATION` §6): the service takes a
 * {@link TenantQueryRunner} from `TenantDatabase` and hands it here.
 *
 * Every read and write is bound to `organization_id` from the context — a caller in the wrong tenant
 * sees nothing rather than a leak — and the insert takes its `organization_id` from the context, never
 * from the input, so a request body cannot choose the tenant it writes into. The composite
 * `(organization_id, id)` key of migration 0082 makes a cross-tenant id a non-existent row.
 */
export class BillingContactsRepository implements BillingContactsStore {
  /** The tenant's contacts, oldest first, bounded to one page. */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingContactRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(billingContacts)
      .where(eq(billingContacts.organizationId, context.organizationId))
      .orderBy(asc(billingContacts.createdAt), asc(billingContacts.id))
      .limit(MAX_CONTACTS_PAGE);
  }

  /** One contact by id, scoped to the tenant; `null` if absent or cross-tenant. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    contactId: string,
  ): Promise<BillingContactRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(billingContacts)
      .where(
        and(
          eq(billingContacts.organizationId, context.organizationId),
          eq(billingContacts.id, contactId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert one contact, its `organization_id` from the context. Reads the row back. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BillingContactInput,
  ): Promise<BillingContactRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(billingContacts)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        name: input.name,
        email: input.email,
        role: input.role,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('billing contact vanished immediately after insert');
    }
    return created;
  }

  /** Delete one contact, tenant-scoped. */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    contactId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(billingContacts)
      .where(
        and(
          eq(billingContacts.organizationId, context.organizationId),
          eq(billingContacts.id, contactId),
        ),
      );
  }
}

/** The largest contact list a single read returns; mirrors the bounded reads elsewhere. */
const MAX_CONTACTS_PAGE = 500;
