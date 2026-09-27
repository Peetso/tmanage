import { and, asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { inboxSavedFilters } from '../../common/database/schema.js';
import type { InboxSavedFilterRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** MySQL's duplicate-key error number — the guard `uq_inbox_saved_filters_name` raises on a re-save. */
const ER_DUP_ENTRY = 1062;

/**
 * A duplicate-key violation, seen through whatever wraps it.
 *
 * The `mysql2` driver raises `{ errno: 1062, code: 'ER_DUP_ENTRY' }`, but Drizzle re-throws it
 * wrapped, carrying the original on `.cause`, so the marker can be one level down (the
 * `client_projections.repository.ts` posture). This inspects the error and its cause for either the
 * numeric `errno` or the string `code`.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}

/**
 * INBOX saved filters (IN-02, x261) — the data half. One stateless repository over
 * `inbox_saved_filters`.
 *
 * ## Every operation is scoped to one membership in one studio
 *
 * A saved filter is private: the owning membership is the only reader and the only deleter. So every
 * method here carries both `organization_id = context.organizationId` AND
 * `membership_id = context.membershipId` predicates — the tenant boundary and the owner boundary
 * together. A cross-tenant id, or another membership's id, simply does not match, so the service
 * turns it into a 404 with no disclosure that a row exists. There is no UPDATE: a saved filter is
 * created and deleted, never edited.
 */
export class InboxSavedFiltersRepository {
  /**
   * Insert one saved filter owned by the acting membership. The id and tenant come from here. A name
   * already used by this membership collides on `uq_inbox_saved_filters_name`; the driver's
   * duplicate-key error propagates for the service to map to 409.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly name: string; readonly filter: string },
  ): Promise<InboxSavedFilterRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(inboxSavedFilters)
      .values({
        id,
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        name: input.name,
        filterJson: input.filter,
        createdAt: sql`current_timestamp(3)`,
      });
    const row = await this.findOwned(runner, context, id);
    if (!row) throw new Error('inbox_saved_filters row vanished immediately after insert');
    return row;
  }

  /** One of the acting membership's rows by id, tenant- and owner-scoped, or undefined. */
  async findOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InboxSavedFilterRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboxSavedFilters)
      .where(
        and(
          eq(inboxSavedFilters.organizationId, context.organizationId),
          eq(inboxSavedFilters.membershipId, context.membershipId),
          eq(inboxSavedFilters.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The acting membership's saved filters, newest first with id breaking ties (a total order). */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly InboxSavedFilterRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(inboxSavedFilters)
      .where(
        and(
          eq(inboxSavedFilters.organizationId, context.organizationId),
          eq(inboxSavedFilters.membershipId, context.membershipId),
        ),
      )
      .orderBy(desc(inboxSavedFilters.createdAt), asc(inboxSavedFilters.id));
  }

  /**
   * Delete the acting membership's saved filter by id. Scoped by tenant and owner, so an id that
   * names another membership's row, another studio's row, or nothing removes nothing and the service
   * answers 404 — a saved filter is private, so its existence is never disclosed to anyone but its
   * owner.
   */
  async deleteOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(inboxSavedFilters)
      .where(
        and(
          eq(inboxSavedFilters.organizationId, context.organizationId),
          eq(inboxSavedFilters.membershipId, context.membershipId),
          eq(inboxSavedFilters.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
