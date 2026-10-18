import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentSharingRepository, isMissingColumn } from './document-sharing.repository.js';
import type { AudienceRow, DocumentAudience } from './document-sharing.repository.js';

/**
 * Docs sharing (UI rebuild, DOC-01 hub / DOC-02 top bar).
 *
 * - **Recent** — the tenant's most recently updated documents the caller may read, newest first,
 *   with project name and audience, plus how many in the scanned window sit in projects the caller
 *   cannot read (DOC-01's "1 document in a space you cannot read" row: a count, never a title).
 * - **Sharing** — one document's audience, client reach, collaborators (by name) and whether the
 *   caller may publish it.
 * - **Publish / unpublish** — move a document between `internal` and `client`.
 *
 * Every read resolves the document **tenant-scoped before** the relation check (the Known-trap
 * order `DocumentsService.requireActionable` records), so an unknown, cross-tenant or unreadable id
 * is one 404. Publishing is 12-PERMISSION-MATRIX §2 "Publish to client": the relation-gated
 * `deliverable.publish` against the document's project, so owners, admins and managers of the
 * project publish and a member does not (403 — they can already read the document, so a 403
 * confirms nothing new).
 */

export interface DocumentPersonView {
  readonly userId: string;
  readonly displayName: string;
}

export interface DocumentSharingView {
  readonly audience: DocumentAudience;
  /** ISO-8601, or null while internal. */
  readonly publishedAt: string | null;
  /** Active client people on the document's project — who a publish reaches. */
  readonly clientAudienceCount: number;
  /** Creator first, then version editors and commenters, each once. */
  readonly collaborators: readonly DocumentPersonView[];
  readonly canPublish: boolean;
}

export interface RecentDocumentView {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly audience: DocumentAudience;
  readonly clientAudienceCount: number;
}

export interface RecentDocumentsView {
  readonly documents: readonly RecentDocumentView[];
  readonly hiddenCount: number;
}

const RECENT_PAGE = 50;

export class DocumentSharingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly sharing: DocumentSharingRepository = new DocumentSharingRepository(),
  ) {}

  private allowed(
    principal: Principal,
    capability: Capability,
    organizationId: string,
    projectId: string,
  ): boolean {
    return authorize({
      principal,
      capability,
      resource: { organizationId, projectId, audience: 'internal', lifecycle: 'active' },
    }).allowed;
  }

  private async requireReadable(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documents.findById(runner, context, documentId),
    );
    if (!row || !this.allowed(principal, 'work.read', row.organizationId, row.projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }
    return row;
  }

  /** Audience rows, or an empty map while the audience migration has not run (everything internal). */
  private async audienceMap(
    context: TenantContext,
    documentIds: readonly string[],
  ): Promise<Map<string, AudienceRow>> {
    try {
      const rows = await this.database.read(context, (runner) =>
        this.sharing.audiences(runner, context, documentIds),
      );
      return new Map(rows.map((row) => [row.id, row]));
    } catch (error) {
      if (isMissingColumn(error)) return new Map();
      throw error;
    }
  }

  async recent(
    context: TenantContext,
    principal: Principal,
    filter: { readonly projectId?: string; readonly favourites?: boolean } = {},
  ): Promise<RecentDocumentsView> {
    const scanned = await this.database.read(context, (runner) =>
      this.sharing.recent(runner, context, {
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        // A favourite is always the caller's own: the membership comes from the context.
        ...(filter.favourites ? { favouritesOf: context.membershipId } : {}),
      }),
    );
    const readable = scanned.filter((row) =>
      this.allowed(principal, 'work.read', row.organizationId, row.projectId),
    );
    const page = readable.slice(0, RECENT_PAGE);
    const audiences = await this.audienceMap(
      context,
      page.map((row) => row.id),
    );
    const counts = await this.database.read(context, (runner) =>
      this.sharing.clientCounts(runner, context, [...new Set(page.map((row) => row.projectId))]),
    );
    return {
      documents: page.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        projectName: row.projectName,
        title: row.title,
        updatedAt: row.updatedAt.toISOString(),
        audience: audiences.get(row.id)?.audience ?? 'internal',
        clientAudienceCount: counts.get(row.projectId) ?? 0,
      })),
      hiddenCount: scanned.length - readable.length,
    };
  }

  async get(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentSharingView> {
    const document = await this.requireReadable(context, principal, documentId);
    return this.view(context, principal, document);
  }

  async setAudience(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    audience: DocumentAudience,
  ): Promise<DocumentSharingView> {
    const document = await this.requireReadable(context, principal, documentId);
    if (
      !this.allowed(principal, 'deliverable.publish', document.organizationId, document.projectId)
    ) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'document_publish_denied',
      );
    }
    await this.database.transaction(context, (tx) =>
      this.sharing.setAudience(tx, context, documentId, audience),
    );
    return this.view(context, principal, document);
  }

  private async view(
    context: TenantContext,
    principal: Principal,
    document: DocumentRow,
  ): Promise<DocumentSharingView> {
    const audience = (await this.audienceMap(context, [document.id])).get(document.id);
    const { counts, people } = await this.database.read(context, async (runner) => {
      const contributors = await this.sharing.contributors(runner, context, document.id);
      return {
        counts: await this.sharing.clientCounts(runner, context, [document.projectId]),
        people: {
          contributors,
          rows: await this.sharing.people(runner, context, {
            userIds: [document.createdByUserId, ...contributors.editorUserIds],
            membershipIds: contributors.commenterMembershipIds,
          }),
        },
      };
    });

    const byUser = new Map(people.rows.map((row) => [row.userId, row.displayName]));
    const byMembership = new Map(people.rows.map((row) => [row.membershipId, row.userId]));
    const orderedUserIds = [
      document.createdByUserId,
      ...people.contributors.editorUserIds,
      ...people.contributors.commenterMembershipIds.flatMap((id) => {
        const userId = byMembership.get(id);
        return userId ? [userId] : [];
      }),
    ];
    const collaborators = [...new Set(orderedUserIds)].flatMap((userId) => {
      const displayName = byUser.get(userId);
      return displayName ? [{ userId, displayName }] : [];
    });

    return {
      audience: audience?.audience ?? 'internal',
      publishedAt: audience?.publishedAt ? audience.publishedAt.toISOString() : null,
      clientAudienceCount: counts.get(document.projectId) ?? 0,
      collaborators,
      canPublish: this.allowed(
        principal,
        'deliverable.publish',
        document.organizationId,
        document.projectId,
      ),
    };
  }
}
