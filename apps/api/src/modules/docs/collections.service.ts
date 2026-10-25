import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import {
  DocCollectionNameConflictError,
  DocCollectionsRepository,
} from './collections.repository.js';

/**
 * DOC collections (x264) — group a studio's documents into named collections (lightweight wiki spaces),
 * add and remove member documents, list the collections, and list one collection's documents. Kept in
 * its own table `doc_collections` and its own module so it touches no file another docs slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `doc.read`/`doc.write` question a guard can answer with no object
 * loaded. This service adds the object-level decision:
 *
 * - **Resolve before authorize (the Known-trap order).** A collection (and, when adding, a document) is
 *   resolved tenant-scoped **before** the authorize call, so a missing id, or one that belongs to
 *   another tenant, is a **404**, never a foreign-key 500 an org-wide caller would reach regardless.
 * - **The relation gate uses `work.read`/`work.create`.** `doc.read`/`doc.write` are declared as
 *   ceiling-mirrors of `work.read`/`work.create` (see `packages/domain`'s `capabilities.ts`), and
 *   `work.*` is what `authorize()` already relation-gates. A collection is org-scoped (it groups
 *   documents across projects), so the resource is `projectId: null` — the `document-template-variables`
 *   posture. A denied caller is a 403 on the collection surface (the collection is not a per-object
 *   secret the way a single document is), matching the org-scoped template surface.
 *
 * The member list is projected to documents the caller can **still** read, so a collection never leaks
 * the title of a document the caller may not see.
 */

/** What a caller sees of one collection — paired Exact with the web's `DocCollectionSummary`. */
export interface CollectionView {
  readonly id: string;
  readonly name: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** One document in a collection — paired Exact with the web's `CollectionDocumentSummary`. */
export interface CollectionDocumentView {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class DocCollectionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly collections: DocCollectionsRepository = new DocCollectionsRepository(),
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
  ) {}

  /** Authorize an org-scoped read/write of collections (`projectId: null`), or throw 403. */
  private requireAuthorized(
    principal: Principal,
    context: TenantContext,
    capability: 'work.read' | 'work.create',
    logCode: string,
  ): void {
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, logCode);
    }
  }

  /** Resolve a collection tenant-scoped, **before** any authorize or write — a miss is 404, never 500. */
  private async requireCollection(context: TenantContext, collectionId: string): Promise<void> {
    const collection = await this.database.read(context, (runner) =>
      this.collections.findCollection(runner, context, collectionId),
    );
    if (!collection) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'collection_not_visible');
    }
  }

  /**
   * Create a collection. `doc.write` (org-scoped `work.create`). A name already used in the tenant is a
   * 409.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    name: string,
  ): Promise<CollectionView> {
    this.requireAuthorized(principal, context, 'work.create', 'collection_write_denied');
    try {
      const row = await this.database.transaction(context, (tx) =>
        this.collections.createCollection(tx, context, name),
      );
      return { id: row.id, name: row.name ?? name, createdAt: row.createdAt.toISOString() };
    } catch (error) {
      if (error instanceof DocCollectionNameConflictError) {
        throw new ApiError(
          409,
          'conflict',
          'A collection with that name already exists',
          [{ field: 'name', message: 'must be unique within the organization' }],
          'collection_name_conflict',
        );
      }
      throw error;
    }
  }

  /** List the tenant's collections, name-ascending, for a caller who may read. `doc.read`. */
  async list(context: TenantContext, principal: Principal): Promise<readonly CollectionView[]> {
    this.requireAuthorized(principal, context, 'work.read', 'collection_read_denied');
    const rows = await this.database.read(context, (runner) =>
      this.collections.listCollections(runner, context),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * F55. Resolve a document tenant-scoped and require that the principal may read it (`work.read`)
   * and, for a membership write, write in its project (`work.create`), both on the document's own
   * project. A missing, cross-tenant or unreadable document is the same 404 `document_not_visible`
   * the documents route gives, so nothing about it — not even its existence — is disclosed.
   */
  private async requireVisibleDocument(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<{ readonly id: string; readonly title: string; readonly projectId: string }> {
    const document = await this.database.read(context, (runner) =>
      this.documentsRepo.findById(runner, context, documentId),
    );
    const resource = document
      ? {
          organizationId: context.organizationId,
          projectId: document.projectId,
          audience: 'internal' as const,
          lifecycle: 'active' as const,
        }
      : null;
    const permitted =
      resource !== null &&
      authorize({ principal, capability: 'work.read', resource }).allowed &&
      authorize({ principal, capability: 'work.create', resource }).allowed;
    if (!document || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }
    return document;
  }

  /**
   * Add a document to a collection, idempotently. The collection is resolved tenant-scoped (404) and
   * the org-level write authorised (`work.create`, 403); then the document is resolved and
   * authorised on its own project (F55: a missing or unreadable document is the same 404) before the
   * write and before any of its fields are echoed. A repeated add returns the same view, never a
   * second row.
   */
  async addDocument(
    context: TenantContext,
    principal: Principal,
    collectionId: string,
    documentId: string,
  ): Promise<CollectionDocumentView> {
    await this.requireCollection(context, collectionId);
    this.requireAuthorized(principal, context, 'work.create', 'collection_write_denied');
    const document = await this.requireVisibleDocument(context, principal, documentId);

    const row = await this.database.transaction(context, (tx) =>
      this.collections.addMember(tx, context, collectionId, documentId),
    );
    return {
      id: row.id,
      documentId: document.id,
      title: document.title,
      projectId: document.projectId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Remove a document from a collection, idempotently. The collection is resolved tenant-scoped (404)
   * before the authorize (`work.create`, 403); the document is then resolved and authorised on its
   * own project (F55, 404 `document_not_visible`) before the delete, so a caller cannot detach — or
   * probe — a document they cannot see.
   */
  async removeDocument(
    context: TenantContext,
    principal: Principal,
    collectionId: string,
    documentId: string,
  ): Promise<void> {
    await this.requireCollection(context, collectionId);
    this.requireAuthorized(principal, context, 'work.create', 'collection_write_denied');
    await this.requireVisibleDocument(context, principal, documentId);
    await this.database.transaction(context, (tx) =>
      this.collections.removeMember(tx, context, collectionId, documentId),
    );
  }

  /**
   * List one collection's member documents, projected to documents the caller can **still** read. The
   * collection is resolved tenant-scoped (404) before the authorize (`work.read`, 403). A member
   * document the caller has since lost read access to is dropped, so no title leaks here.
   */
  async listDocuments(
    context: TenantContext,
    principal: Principal,
    collectionId: string,
  ): Promise<readonly CollectionDocumentView[]> {
    await this.requireCollection(context, collectionId);
    this.requireAuthorized(principal, context, 'work.read', 'collection_read_denied');

    const rows = await this.database.read(context, (runner) =>
      this.collections.listMembers(runner, context, collectionId),
    );
    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: context.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map((row) => ({
        id: row.id,
        documentId: row.documentId,
        title: row.title,
        projectId: row.projectId,
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
