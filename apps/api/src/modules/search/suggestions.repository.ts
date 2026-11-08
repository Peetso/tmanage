import { and, asc, desc, eq, isNull, like } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documents, projects, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { clientAudienceVisible } from '../work/work-item-client-audience.repository.js';

/**
 * SRCH typeahead / suggestions (x289). The read side of the prefix typeahead — a tenant-scoped
 * **prefix** read over the live source tables (work items and documents), joined to their project.
 * Read-only: no write method, no new table.
 *
 * NV12: this used to read `search_index` (0054). That table is written once, by 0054's backfill,
 * and by nothing afterwards — so its `project_id`, `title` and existence froze at migration time,
 * and a moved, renamed or deleted item kept being suggested under its old project. Reading the
 * live rows, as global search's `searchRanked` does, makes each candidate carry its **current**
 * project, audience and lifecycle into the service's `authorize()` gate.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured exactly as
 * {@link SearchIndexRepository} honours it: `organization_id = ?` from `context.organizationId`
 * is on every table of every statement, executed through the guard (`drizzle.ts`), so a
 * cross-tenant title can never be a candidate. The relation (project-membership) rule is *not*
 * here — that is `authorize()`'s, run per candidate by {@link SuggestionsService}.
 */

/** A prefix candidate — only what the service needs to authorise and project it (a bare title). */
export interface SuggestCandidateRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
  /** The candidate's project lifecycle now — an archived project's titles are archived reads. */
  readonly lifecycle: 'active' | 'archived';
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
   * Read this tenant's live work-item and document titles that start with the prefix, most recent
   * first. Soft-deleted work items are excluded; every row carries its project's current id and
   * archive state. Each source is bounded by `limit`, merged by `updated_at` desc, then `title`,
   * then id, and cut to `limit` — a total, deterministic order.
   */
  async suggestByPrefix(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SuggestByPrefixOptions,
  ): Promise<readonly SuggestCandidateRow[]> {
    const db = tenantDrizzle(runner);
    const org = context.organizationId;
    const pattern = `${escapeLikePrefix(options.prefix)}%`;

    const items = await db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        title: workItems.title,
        audience: workItems.audience,
        updatedAt: workItems.updatedAt,
        archivedAt: projects.archivedAt,
      })
      .from(workItems)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, workItems.organizationId),
          eq(projects.id, workItems.projectId),
        ),
      )
      .where(
        and(
          eq(workItems.organizationId, org),
          eq(projects.organizationId, org),
          isNull(workItems.deletedAt),
          like(workItems.title, pattern),
          clientAudienceVisible(context), // C25
        ),
      )
      .orderBy(desc(workItems.updatedAt), asc(workItems.title), asc(workItems.id))
      .limit(options.limit);

    const docs = await db
      .select({
        id: documents.id,
        projectId: documents.projectId,
        title: documents.title,
        updatedAt: documents.updatedAt,
        archivedAt: projects.archivedAt,
      })
      .from(documents)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, documents.organizationId),
          eq(projects.id, documents.projectId),
        ),
      )
      .where(
        and(
          eq(documents.organizationId, org),
          eq(projects.organizationId, org),
          like(documents.title, pattern),
        ),
      )
      .orderBy(desc(documents.updatedAt), asc(documents.title), asc(documents.id))
      .limit(options.limit);

    const merged = [
      ...items.map((row) => ({
        ...row,
        audience: row.audience as SuggestCandidateRow['audience'],
      })),
      // Documents are suggested as `internal`, exactly as global search treats them.
      ...docs.map((row) => ({ ...row, audience: 'internal' as const })),
    ];
    merged.sort((left, right) => {
      const byTime = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byTime !== 0) return byTime;
      if (left.title !== right.title) return left.title < right.title ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    return merged.slice(0, options.limit).map((row) => ({
      organizationId: org,
      projectId: row.projectId,
      title: row.title,
      audience: row.audience,
      lifecycle: row.archivedAt === null ? 'active' : 'archived',
    }));
  }
}
