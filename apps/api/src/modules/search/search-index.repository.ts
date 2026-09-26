import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { searchIndex } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH ranking (x148). The read/write side of the full-text search index (`search_index`, 0054) —
 * the ranking backbone that replaces SRCH-01's naive `LIKE` scan over three live tables.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * other tenant-scoped repositories honour it:
 *
 * 1. **No unscoped read or write.** Every method takes the `TenantQueryRunner` for the current
 *    unit of work and the `TenantContext`; there is no overload without one.
 * 2. **The tenant comes from the context, never the caller.** `organization_id = ?` is the first
 *    predicate on every statement, built from `context.organizationId` — the Known-trap anchor
 *    that keeps a cross-tenant row from ever ranking (a `MATCH … AGAINST` with no tenant predicate
 *    would score every studio's titles into this caller's page).
 * 3. **The predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten one throws rather than leaking rows.
 *
 * The relation (project-membership) rule is *not* here — that is `authorize()`'s, run per hit by
 * `SearchService`, the single place the rule lives. This layer carries `project_id` and `audience`
 * on each hit so the service can run it over one ranked read without a join back to the source.
 */

/** The source kinds indexed this slice. Meetings and other kinds are deferred (NS-13). */
export type SearchIndexTargetKind = 'work_item' | 'document';

/** A ranked hit — only what the service needs to authorise and project it. */
export interface SearchIndexHitRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly targetKind: SearchIndexTargetKind;
  readonly targetId: string;
  readonly title: string;
  /**
   * The source row's audience, carried so the service authorises each hit against the row's own
   * audience (a `client_visible` item is readable where an `internal` one is not), exactly as the
   * direct read does. Documents are `internal` by construction.
   */
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
}

export interface SearchRankedOptions {
  /** The query, passed as a bound parameter to `MATCH … AGAINST` (natural-language mode). */
  readonly query: string;
  /** Optional project filter, already resolved tenant-scoped by the service (Known-trap). */
  readonly projectId?: string;
  /** The bound on rows returned; the service bounds again defensively. */
  readonly limit: number;
}

/** One row to (re)index — a projection of a source row into the index's shape. */
export interface SearchIndexEntry {
  readonly targetKind: SearchIndexTargetKind;
  readonly targetId: string;
  readonly projectId: string;
  readonly title: string;
  readonly bodyText: string;
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
  readonly updatedAt: Date;
}

export class SearchIndexRepository {
  /**
   * Rank this tenant's indexed rows against the query.
   *
   * `MATCH(title, body_text) AGAINST (?)` uses the 0054 FULLTEXT index and yields a relevance
   * score; the read orders by that score descending, then `updated_at` descending (the recency
   * tiebreak the plan asks for), then `target_id` for a total, deterministic order. The
   * `organization_id = ?` predicate is applied **before** ranking — a cross-tenant row can never
   * score into the page.
   */
  async searchRanked(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SearchRankedOptions,
  ): Promise<readonly SearchIndexHitRow[]> {
    const db = tenantDrizzle(runner);
    const relevance = sql<number>`match(${searchIndex.title}, ${searchIndex.bodyText}) against (${options.query})`;

    const predicates = [eq(searchIndex.organizationId, context.organizationId), relevance];
    if (options.projectId) predicates.push(eq(searchIndex.projectId, options.projectId));

    const rows = await db
      .select({
        organizationId: searchIndex.organizationId,
        projectId: searchIndex.projectId,
        targetKind: searchIndex.targetKind,
        targetId: searchIndex.targetId,
        title: searchIndex.title,
        audience: searchIndex.audience,
      })
      .from(searchIndex)
      .where(and(...predicates))
      .orderBy(desc(relevance), desc(searchIndex.updatedAt), asc(searchIndex.targetId))
      .limit(options.limit);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.projectId,
      targetKind: row.targetKind as SearchIndexTargetKind,
      targetId: row.targetId,
      title: row.title,
      audience: row.audience,
    }));
  }

  /**
   * (Re)index one source row. `INSERT … ON DUPLICATE KEY UPDATE` on the
   * `(organization_id, target_kind, target_id)` key: a new source row is inserted, an existing one
   * has its searchable fields refreshed in place. The 0054 trigger pins identity, so an update can
   * only move `title`/`body_text`/`audience`/`updated_at`, never repoint a row to another source.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    entry: SearchIndexEntry,
    id: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(searchIndex)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: entry.projectId,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        title: entry.title,
        bodyText: entry.bodyText,
        audience: entry.audience,
        updatedAt: entry.updatedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          title: entry.title,
          bodyText: entry.bodyText,
          audience: entry.audience,
          updatedAt: entry.updatedAt,
        },
      });
  }

  /** Drop a source row's index row when the source is removed (tenant-scoped). */
  async deleteForTarget(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetKind: SearchIndexTargetKind,
    targetId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(searchIndex)
      .where(
        and(
          eq(searchIndex.organizationId, context.organizationId),
          eq(searchIndex.targetKind, targetKind),
          eq(searchIndex.targetId, targetId),
        ),
      );
  }
}
