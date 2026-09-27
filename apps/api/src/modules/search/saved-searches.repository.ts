import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { savedSearches } from '../../common/database/schema.js';
import type { SavedSearchFilter, SavedSearchRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH saved/recent searches (x214) — the data half. One stateless repository over
 * `saved_searches`, holding both kinds keyed by `kind`.
 *
 * ## Every operation is scoped to one user in one studio
 *
 * A saved or recent search is private: the owner is the only reader and the only deleter. So every
 * method here carries both `organization_id = context.organizationId` AND `user_id = context.userId`
 * predicates — the tenant boundary and the owner boundary together. A cross-tenant id, or another
 * user's id, simply does not match, so the service turns it into a 404 with no disclosure that a row
 * exists. There is no UPDATE: a saved search is created and deleted, a recent is inserted and pruned.
 */
export class SavedSearchesRepository {
  /** Insert one saved search owned by the acting user. The id and tenant come from here. */
  async insertSaved(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly name: string;
      readonly query: string;
      readonly filters: readonly SavedSearchFilter[];
    },
  ): Promise<SavedSearchRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(savedSearches)
      .values({
        id,
        organizationId: context.organizationId,
        userId: context.userId,
        kind: 'saved',
        name: input.name,
        queryText: input.query,
        filters: input.filters,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
    const row = await this.findOwned(runner, context, id, 'saved');
    if (!row) throw new Error('saved_searches row vanished immediately after insert');
    return row;
  }

  /** One of the acting user's rows of a kind by id, tenant- and owner-scoped, or undefined. */
  async findOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    kind: 'saved' | 'recent',
  ): Promise<SavedSearchRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, kind),
          eq(savedSearches.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The acting user's saved searches, newest first with id breaking ties (a total order). */
  async listSaved(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly SavedSearchRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, 'saved'),
        ),
      )
      .orderBy(desc(savedSearches.createdAt), asc(savedSearches.id));
  }

  /**
   * Delete the acting user's saved search by id. Scoped by tenant, owner and `kind = 'saved'`, so an
   * id that names another user's row, a recent, or nothing removes nothing and the service answers
   * 404 — a saved search is private, so its existence is never disclosed to anyone but its owner.
   */
  async deleteSavedOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, 'saved'),
          eq(savedSearches.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** The acting user's recent queries, most-recent first, bounded to `limit`. */
  async listRecent(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<readonly SavedSearchRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, 'recent'),
        ),
      )
      .orderBy(desc(savedSearches.createdAt), desc(savedSearches.id))
      .limit(limit);
  }

  /**
   * Record one recent query for the acting user: dedupe the same query to the front (delete any
   * prior recent with the same text), insert the new one, then prune to the newest `keep`. All
   * tenant- and owner-scoped, so a recent is only ever the acting user's own in the acting studio.
   */
  async recordRecent(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: string,
    keep: number,
  ): Promise<void> {
    const db = tenantDrizzle(runner);

    // Dedupe: a repeat of the same query moves to the front rather than adding a duplicate row.
    await db
      .delete(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, 'recent'),
          eq(savedSearches.queryText, query),
        ),
      );

    await db.insert(savedSearches).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      userId: context.userId,
      kind: 'recent',
      name: null,
      queryText: query,
      filters: [],
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Prune: keep only the newest `keep` recents; delete the rest by id.
    const rows = await db
      .select({ id: savedSearches.id })
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.userId, context.userId),
          eq(savedSearches.kind, 'recent'),
        ),
      )
      .orderBy(desc(savedSearches.createdAt), desc(savedSearches.id));
    const stale = rows.slice(keep).map((row) => row.id);
    if (stale.length > 0) {
      await db
        .delete(savedSearches)
        .where(
          and(
            eq(savedSearches.organizationId, context.organizationId),
            eq(savedSearches.userId, context.userId),
            eq(savedSearches.kind, 'recent'),
            inArray(savedSearches.id, stale),
          ),
        );
    }
  }
}
