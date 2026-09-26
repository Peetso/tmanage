import { and, asc, eq, isNull, like } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documents, meetings, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH-01 (x111). The read side of global search — three tenant-scoped title reads, one per
 * searchable kind (`work_items`, `documents`, `meetings`).
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings and documents repositories honour it:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context,
 *    so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the caller.** `organization_id` is a predicate
 *    on every statement below, built from `context.organizationId`.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * This layer applies the tenant filter and the title match. It does **not** apply the relation
 * (project-membership) rule — that is `authorize()`'s, and `SearchService` runs it per row after
 * the read, the single place the rule lives (the posture `WorkItemsService.list` established).
 * The reads are title-only this slice: the LIKE runs over the existing `title`/`name` columns and
 * their existing indexes; no full-text index, no body match (deferred — NEXT-SCOPES-9).
 */

/** A minimal, kind-tagged hit — only what the service needs to authorize and project it. */
export interface SearchHitRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  /**
   * The work item's audience, carried so the service authorizes each hit against the row's own
   * audience (a `client_visible` item is readable where an `internal` one is not). Absent for
   * documents and meetings, which are internal by construction — the service treats their
   * audience as `internal`.
   */
  readonly audience?: 'internal' | 'client_visible' | 'client_action_required';
}

export interface SearchReadOptions {
  /** Already escaped for LIKE by the caller — this layer wraps it in `%…%` and matches. */
  readonly likePattern: string;
  /** Optional project filter, already resolved tenant-scoped by the service (Known-trap). */
  readonly projectId?: string;
  /** A bound on rows read per kind; the service bounds the merged set again. */
  readonly limit: number;
}

/**
 * MySQL's default collation is case-insensitive, so `LIKE` already matches case-insensitively
 * over the `utf8mb4_0900_ai_ci` columns these tables use — no `LOWER()` wrapper, which would
 * defeat the index the plan asks this slice to reuse rather than add to.
 */
export class SearchRepository {
  /** Match work items by title, tenant-scoped, excluding soft-deleted rows. */
  async searchWorkItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SearchReadOptions,
  ): Promise<readonly SearchHitRow[]> {
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(workItems.organizationId, context.organizationId),
      isNull(workItems.deletedAt),
      like(workItems.title, options.likePattern),
    ];
    if (options.projectId) predicates.push(eq(workItems.projectId, options.projectId));

    const rows = await db
      .select({
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        id: workItems.id,
        title: workItems.title,
        audience: workItems.audience,
      })
      .from(workItems)
      .where(and(...predicates))
      .orderBy(asc(workItems.title), asc(workItems.id))
      .limit(options.limit);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.projectId,
      id: row.id,
      title: row.title,
      audience: row.audience,
    }));
  }

  /** Match documents by title, tenant-scoped. */
  async searchDocuments(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SearchReadOptions,
  ): Promise<readonly SearchHitRow[]> {
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(documents.organizationId, context.organizationId),
      like(documents.title, options.likePattern),
    ];
    if (options.projectId) predicates.push(eq(documents.projectId, options.projectId));

    const rows = await db
      .select({
        organizationId: documents.organizationId,
        projectId: documents.projectId,
        id: documents.id,
        title: documents.title,
      })
      .from(documents)
      .where(and(...predicates))
      .orderBy(asc(documents.title), asc(documents.id))
      .limit(options.limit);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.projectId,
      id: row.id,
      title: row.title,
    }));
  }

  /** Match meetings by title, tenant-scoped. */
  async searchMeetings(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SearchReadOptions,
  ): Promise<readonly SearchHitRow[]> {
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(meetings.organizationId, context.organizationId),
      like(meetings.title, options.likePattern),
    ];
    if (options.projectId) predicates.push(eq(meetings.projectId, options.projectId));

    const rows = await db
      .select({
        organizationId: meetings.organizationId,
        projectId: meetings.projectId,
        id: meetings.id,
        title: meetings.title,
      })
      .from(meetings)
      .where(and(...predicates))
      .orderBy(asc(meetings.title), asc(meetings.id))
      .limit(options.limit);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.projectId,
      id: row.id,
      title: row.title,
    }));
  }
}
