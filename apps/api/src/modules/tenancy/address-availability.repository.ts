import { eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { organizations } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * "Is this workspace address taken?" — the read behind ON-02's live "available" tick.
 *
 * It cannot be tenant-scoped: the address belongs to an organization the caller is not in (or
 * to none yet). It goes through `bootstrapRead` like the directory and the resolver: audited,
 * read-only, and limited to `organizations`. It returns one boolean and nothing about the
 * organization holding the address, so it discloses exactly what the create route's 409
 * already does — and what visiting the URL does.
 *
 * Archived organizations count as taken: `uq_organizations_slug` still holds their address.
 */

const AVAILABILITY_REASON =
  'workspace address availability: whether one slug is already held, asked by a verified ' +
  'session choosing an address for a new organization (ON-02)';

export class AddressAvailabilityRepository {
  constructor(private readonly database: TenantDatabase) {}

  async isTaken(input: { slug: string; correlationId: string }): Promise<boolean> {
    return this.database.bootstrapRead(
      {
        correlationId: input.correlationId,
        reason: AVAILABILITY_REASON,
        tables: ['organizations'],
      },
      async (tx) => {
        const rows = await tenantDrizzle(tx)
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, input.slug))
          .limit(1);
        return rows.length > 0;
      },
    );
  }
}
