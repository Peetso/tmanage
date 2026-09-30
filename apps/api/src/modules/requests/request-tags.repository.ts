import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { requestTags } from '../../common/database/schema.js';
import type { RequestTagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Request tags — x316's storage half (Requests module 11). Free-text triage labels on a client
 * request, one row per (request, label). Every read and write is bound to `(organization_id, …)`, so
 * a caller in the wrong tenant sees nothing rather than a leak; the repository holds no policy — the
 * service resolves the parent request tenant-scoped and authorizes — and the composite foreign key of
 * migration `0184_request_tags.sql` makes a cross-tenant request id a non-existent pair.
 */

/** The largest tag page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_REQUEST_TAGS_PAGE = 500;

export class RequestTagsRepository {
  /** The tenant's tags on one client request, label-ascending, bounded to one page. */
  async listForRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
    limit: number = MAX_REQUEST_TAGS_PAGE,
  ): Promise<readonly RequestTagRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(requestTags)
      .where(
        and(
          eq(requestTags.organizationId, context.organizationId),
          eq(requestTags.clientRequestId, clientRequestId),
        ),
      )
      .orderBy(asc(requestTags.label), asc(requestTags.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_REQUEST_TAGS_PAGE));
  }

  /** One tag by id, scoped to the tenant and its request; `null` if absent. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
    tagId: string,
  ): Promise<RequestTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(requestTags)
      .where(
        and(
          eq(requestTags.organizationId, context.organizationId),
          eq(requestTags.clientRequestId, clientRequestId),
          eq(requestTags.id, tagId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A tag with this label already on the request; `null` if the label is free. The comparison is the
   * table collation's (`utf8mb4_unicode_ci`), so it is case-insensitive — `Urgent` matches `urgent`.
   */
  async findByLabel(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
    label: string,
  ): Promise<RequestTagRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(requestTags)
      .where(
        and(
          eq(requestTags.organizationId, context.organizationId),
          eq(requestTags.clientRequestId, clientRequestId),
          eq(requestTags.label, label),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Tag a request with a free-text label. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { clientRequestId: string; label: string; createdBy: string },
  ): Promise<RequestTagRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(requestTags)
      .values({
        id,
        organizationId: context.organizationId,
        clientRequestId: input.clientRequestId,
        label: input.label,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, context, input.clientRequestId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('request tag vanished immediately after insert');
    }
    return created;
  }

  /** Untag: remove a tag from a request. `true` if a row was removed. */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
    tagId: string,
  ): Promise<boolean> {
    const existing = await this.findById(runner, context, clientRequestId, tagId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(requestTags)
      .where(
        and(
          eq(requestTags.organizationId, context.organizationId),
          eq(requestTags.clientRequestId, clientRequestId),
          eq(requestTags.id, tagId),
        ),
      );
    return true;
  }
}
