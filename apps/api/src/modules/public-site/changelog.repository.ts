import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { changelogEntries } from '../../common/database/schema.js';
import type { ChangelogEntryRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The public-changelog repository — Public site, module 1 (x160).
 *
 * `changelog_entries` (0061) is a **global** table: it carries no `organization_id`, so there is no
 * tenant scope to apply and no `TenantContext` to take. Every method therefore runs on an
 * {@link IdentityQueryRunner} — the runner `TenantDatabase.identityRead()` hands a unit of work
 * declared over global tables — exactly as {@link SessionsRepository} does for the identity tables.
 * The table is registered in `NON_TENANT_TABLES` (tenant-guard.ts), which is what lets the identity
 * path reach it; a table not declared global there would be refused before a statement ran.
 */

/**
 * Injection token for {@link ChangelogRepository}. Slice-local (declared beside the class it
 * provides) to keep this slice file-disjoint from the shared `common/http/tokens.ts` append point,
 * following the convention the sibling read modules (e.g. `MEETING_AGENDA_REPOSITORY`) use.
 */
export const CHANGELOG_REPOSITORY = Symbol('CHANGELOG_REPOSITORY');

export class ChangelogRepository {
  /**
   * List published changelog entries, newest first, bounded to `limit`.
   *
   * Published-only is two predicates, not one: `published = 1` **and** `published_at IS NOT NULL`.
   * A draft never has a live date, and an entry cannot be ordered by a date it has not got, so both
   * are required — the order is `published_at DESC, id DESC` so the walk is newest-first and ties
   * break deterministically. There is no tenant predicate because the table has no tenant key.
   */
  async listPublished(
    runner: IdentityQueryRunner,
    limit: number,
  ): Promise<readonly ChangelogEntryRow[]> {
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(changelogEntries)
      .where(and(eq(changelogEntries.published, true), isNotNull(changelogEntries.publishedAt)))
      .orderBy(desc(changelogEntries.publishedAt), desc(changelogEntries.id))
      .limit(limit);
  }
}
