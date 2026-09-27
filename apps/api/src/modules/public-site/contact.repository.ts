import { uuidv7 } from '@tmanage/domain';
import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { marketingLeads } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x161. The persistence half of the public contact / lead intake.
 *
 * A marketing lead is submitted by a member of the public who has no session and belongs to no
 * organization, so this write runs on the identity (no-tenant) path — `identityTransaction` over
 * the single global table `marketing_leads`, which is why that table is registered in the tenant
 * guard's `NON_TENANT_TABLES`. There is no read method: the door is write-only (the application
 * grant is INSERT only), and email delivery of the lead is a later, Needs-Peter concern.
 *
 * The clock is the server's (`current_timestamp(3)`), not this process's, the same discipline the
 * identity writers use: a row stamped by a skewed application clock could be born in the future.
 */
export class MarketingLeadsRepository {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Insert one lead and return its id. The caller has already validated and bounded every field
   * (see `contact.controller.ts`); the column widths are the second line of defence.
   */
  async insert(input: {
    name: string;
    email: string;
    message: string;
    source: string;
    correlationId: string;
  }): Promise<{ id: string }> {
    const id = uuidv7();
    await this.database.identityTransaction(
      { correlationId: input.correlationId, tables: ['marketing_leads'] },
      (tx) =>
        tenantDrizzle(tx)
          .insert(marketingLeads)
          .values({
            id,
            name: input.name,
            email: input.email,
            message: input.message,
            source: input.source,
            createdAt: sql`current_timestamp(3)`,
          }),
    );
    return { id };
  }
}
