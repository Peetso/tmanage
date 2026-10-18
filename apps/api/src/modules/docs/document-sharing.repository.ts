import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { char, datetime, mysqlEnum, mysqlTable } from 'drizzle-orm/mysql-core';
import { CLIENT_ROLES } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  docBookmarks,
  documentComments,
  documentVersions,
  documents,
  memberships,
  projectMemberships,
  projects,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Docs sharing (UI rebuild, DOC-01/DOC-02): a document's audience, its publish state, its
 * collaborators and the tenant-wide "Recent" list.
 *
 * ## The audience columns and the local mirror
 *
 * `documents.audience` / `published_at` / `published_by_user_id` arrive in a migration the
 * integrator numbers (see the lane's SHARED.md). Until `schema.ts` carries them, this module reads and
 * writes them through {@link documentAudience}, a narrow typed mirror of the same `documents` table:
 * the tenant guard sees the same table name and the same `organization_id` predicate it always does.
 * The wide `documents` select used everywhere else never names the new columns, so a database that
 * has not run the migration yet keeps serving every other docs screen; only these reads notice, and
 * {@link isMissingColumn} lets the service degrade them to "internal".
 */
export const DOCUMENT_AUDIENCES = ['internal', 'client'] as const;
export type DocumentAudience = (typeof DOCUMENT_AUDIENCES)[number];

export const documentAudience = mysqlTable('documents', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  projectId: char('project_id', { length: 36 }).notNull(),
  audience: mysqlEnum('audience', DOCUMENT_AUDIENCES).notNull().default('internal'),
  publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
  publishedByUserId: char('published_by_user_id', { length: 36 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

/** MariaDB/MySQL `ER_BAD_FIELD_ERROR` — the migration adding the audience columns has not run. */
export function isMissingColumn(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { errno?: unknown }).errno === 1054) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface AudienceRow {
  readonly id: string;
  readonly audience: DocumentAudience;
  readonly publishedAt: Date | null;
}

export interface RecentDocumentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface PersonRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface RecentFilter {
  readonly projectId?: string;
  readonly favouritesOf?: string;
}

/** The window "Recent" scans before the relation filter; the page shows at most 50 of it. */
export const RECENT_SCAN = 200;

export class DocumentSharingRepository {
  /**
   * The tenant's most recently updated documents, with their project's name. `projectId` narrows to
   * one project ("Project knowledge"); `favouritesOf` narrows to one membership's bookmarks
   * ("Favourites"). Every joined tenant table carries the bound `organization_id`.
   */
  async recent(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: RecentFilter = {},
  ): Promise<RecentDocumentRow[]> {
    const predicates = [
      eq(documents.organizationId, context.organizationId),
      eq(projects.organizationId, context.organizationId),
      ...(filter.projectId ? [eq(documents.projectId, filter.projectId)] : []),
    ];
    let query = tenantDrizzle(runner)
      .select({
        id: documents.id,
        organizationId: documents.organizationId,
        projectId: documents.projectId,
        projectName: projects.name,
        title: documents.title,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, documents.organizationId),
          eq(projects.id, documents.projectId),
        ),
      )
      .$dynamic();
    if (filter.favouritesOf) {
      query = query.innerJoin(
        docBookmarks,
        and(
          eq(docBookmarks.organizationId, documents.organizationId),
          eq(docBookmarks.docId, documents.id),
        ),
      );
      predicates.push(
        eq(docBookmarks.organizationId, context.organizationId),
        eq(docBookmarks.membershipId, filter.favouritesOf),
      );
    }
    return query
      .where(and(...predicates))
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(RECENT_SCAN);
  }

  /** The audience of each named document, within the acting tenant. */
  async audiences(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentIds: readonly string[],
  ): Promise<AudienceRow[]> {
    if (documentIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        id: documentAudience.id,
        audience: documentAudience.audience,
        publishedAt: documentAudience.publishedAt,
      })
      .from(documentAudience)
      .where(
        and(
          eq(documentAudience.organizationId, context.organizationId),
          inArray(documentAudience.id, [...documentIds]),
        ),
      );
  }

  /** Set a document's audience. `client` stamps who published it and when; `internal` clears both. */
  async setAudience(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    audience: DocumentAudience,
  ): Promise<void> {
    const publishing = audience === 'client';
    await tenantDrizzle(runner)
      .update(documentAudience)
      .set({
        audience,
        publishedAt: publishing ? sql`current_timestamp(3)` : null,
        publishedByUserId: publishing ? context.userId : null,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(documentAudience.organizationId, context.organizationId),
          eq(documentAudience.id, documentId),
        ),
      );
  }

  /**
   * How many active client people belong to each project — the "Client · 2" a publish reaches.
   * Both tenant tables carry the bound `organization_id`.
   */
  async clientCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (projectIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ projectId: projectMemberships.projectId, count: sql<number>`count(*)` })
      .from(projectMemberships)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, projectMemberships.organizationId),
          eq(memberships.userId, projectMemberships.userId),
        ),
      )
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(memberships.organizationId, context.organizationId),
          inArray(projectMemberships.projectId, [...projectIds]),
          inArray(memberships.role, [...CLIENT_ROLES]),
          eq(memberships.status, 'active'),
        ),
      )
      .groupBy(projectMemberships.projectId);
    return new Map(rows.map((row) => [row.projectId, Number(row.count)]));
  }

  /** The user ids that saved a version of the document and the memberships that commented on it. */
  async contributors(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
  ): Promise<{ editorUserIds: string[]; commenterMembershipIds: string[] }> {
    const db = tenantDrizzle(runner);
    const editors = await db
      .selectDistinct({ userId: documentVersions.editedByUserId })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, context.organizationId),
          eq(documentVersions.documentId, documentId),
        ),
      );
    const commenters = await db
      .selectDistinct({ membershipId: documentComments.authorMembershipId })
      .from(documentComments)
      .where(
        and(
          eq(documentComments.organizationId, context.organizationId),
          eq(documentComments.documentId, documentId),
        ),
      );
    return {
      editorUserIds: editors.map((row) => row.userId),
      commenterMembershipIds: commenters.map((row) => row.membershipId),
    };
  }

  /**
   * Display names for people of this tenant, by user id or membership id. Anchored on the tenant's
   * own `memberships` rows (bound `organization_id`), so `users` — global identity — is reached only
   * through a membership of this organization: the `MembershipsRepository.listWithNames` pattern.
   */
  async people(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: { readonly userIds?: readonly string[]; readonly membershipIds?: readonly string[] },
  ): Promise<PersonRow[]> {
    const userIds = [...new Set(ids.userIds ?? [])];
    const membershipIds = [...new Set(ids.membershipIds ?? [])];
    if (userIds.length === 0 && membershipIds.length === 0) return [];
    const match = [
      ...(userIds.length > 0 ? [inArray(memberships.userId, userIds)] : []),
      ...(membershipIds.length > 0 ? [inArray(memberships.id, membershipIds)] : []),
    ];
    return tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, context.organizationId), or(...match)));
  }
}
