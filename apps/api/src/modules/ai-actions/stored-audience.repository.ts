import { and, eq } from 'drizzle-orm';
import { isUuid } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * **Stored audience lookup — audit run 3, M01.**
 *
 * The bound-token confirm gate decides most calls from their own arguments, but an edit of a work
 * item the client already sees is client-facing even when the call names no audience. This reads
 * that one column — `work_items.audience` — for one id, through the tenant runner: the read is
 * bound to the request's organization (`organization_id = ?` plus the tenant guard), so an id from
 * another workspace is simply not found. Nothing read here is returned to the caller; it only
 * decides whether the call must wait for a person's approval.
 */

/** DI token the interceptor injects the resolver under. */
export const STORED_AUDIENCE_RESOLVER = Symbol.for('tmanage.StoredAudienceResolver');

export interface StoredAudienceResolver {
  /** The stored audience of one work item of this tenant; `undefined` when there is no such row. */
  workItemAudience(context: TenantContext, workItemId: string): Promise<string | undefined>;
}

export class StoredAudienceRepository implements StoredAudienceResolver {
  constructor(private readonly database: Pick<TenantDatabase, 'read'>) {}

  async workItemAudience(context: TenantContext, workItemId: string): Promise<string | undefined> {
    // Every work item id is a UUID; anything else cannot match and needs no round trip.
    if (!isUuid(workItemId)) return undefined;
    return this.database.read(context, async (runner) => {
      const rows = await tenantDrizzle(runner)
        .select({ audience: workItems.audience })
        .from(workItems)
        .where(
          and(eq(workItems.organizationId, context.organizationId), eq(workItems.id, workItemId)),
        )
        .limit(1);
      return rows[0]?.audience;
    });
  }
}
