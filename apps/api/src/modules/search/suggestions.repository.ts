import { and, asc, desc, eq, like } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { searchIndex } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH typeahead / suggestions (x289). The read side of the prefix typeahead — a tenant-scoped
 * **prefix** read over the existing full-text index (`search_index`, 0054) the ranked search and the
 * indexer already own. Read-only: no write method, no new table.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured exactly as
 * {@link SearchIndexRepository} honours it and for the same reason: `organization_id = ?` is the
 * first predicate on the statement, built from `context.organizationId` — never the caller — and
 * executed through the guard (`drizzle.ts`), so a cross-tenant title can never be a candidate. The
 * relation (project-membership) rule is *not* here — that is `authorize()`'s, run per candidate by
 * {@link SuggestionsService} — so each row carries its `project_id` and `audience` for that gate.
 *
 * A separate repository from {@link SearchIndexRepository} (whose `searchRanked` is a FULLTEXT
 * `MATCH … AGAINST` relevance read) so the suggestions slice stays file-disjoint; typeahead wants a
 * literal prefix (`title LIKE ?`), a different read, ordered by recency.
 */

/** A prefix candidate — only what the service needs to authorise and project it (a bare title). */
export interface SuggestCandidateRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
}

export interface SuggestByPrefixOptions {
  /** The already-trimmed, non-empty prefix; its `LIKE` metacharacters are escaped here. */
  readonly prefix: string;
  /** The bound on candidate rows read before the service's relation filter and de-duplication. */
  readonly limit: number;
}

/**
 * Escape the `LIKE` metacharacters so the prefix is matched literally. `\`, `%` and `_` are escaped
 * with the default backslash escape character, so a caller cannot inject `%`/`_` wildcards.
 */
function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class SuggestionsRepository {
  /**
   * Read this tenant's indexed titles that start with the prefix, most-recent first.
   *
   * `organization_id = ?` is applied before the `title LIKE ?` prefix predicate — a cross-tenant row
   * can never match — and the order is `updated_at` desc, then `title`, then `target_id` for a total,
   * deterministic order. The index holds only live source rows (the indexer upserts on write and
   * deletes on removal), so a removed or soft-deleted source is simply absent.
   */
  async suggestByPrefix(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SuggestByPrefixOptions,
  ): Promise<readonly SuggestCandidateRow[]> {
    const db = tenantDrizzle(runner);
    const pattern = `${escapeLikePrefix(options.prefix)}%`;

    const rows = await db
      .select({
        organizationId: searchIndex.organizationId,
        projectId: searchIndex.projectId,
        title: searchIndex.title,
        audience: searchIndex.audience,
      })
      .from(searchIndex)
      .where(
        and(
          eq(searchIndex.organizationId, context.organizationId),
          like(searchIndex.title, pattern),
        ),
      )
      .orderBy(desc(searchIndex.updatedAt), asc(searchIndex.title), asc(searchIndex.targetId))
      .limit(options.limit);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.projectId,
      title: row.title,
      audience: row.audience,
    }));
  }
}
