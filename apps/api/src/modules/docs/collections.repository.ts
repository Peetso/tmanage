import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docCollections, documents } from '../../common/database/schema.js';
import type { DocCollectionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC collections (x264) — named document collections (lightweight wiki spaces) and their membership,
 * kept in ONE tenant table (`work_item_labels` one-table posture). A DEFINITION row has `name` set and
 * `collectionId`/`documentId` null (its own `id` is the collection id); a MEMBERSHIP row has
 * `collectionId` pointing at a definition, `documentId` at a `documents` row, and `name` null.
 *
 * It honours `25-AUTH` §6 structurally: every method's first two parameters are the
 * `TenantQueryRunner` and the `TenantContext`, the tenant comes from the context (never a DTO), and the
 * tenant predicate is on every statement (executed through the guard in `drizzle.ts`). The runner is a
 * parameter, not a field, so the service composes resolve-then-write on one connection in one
 * transaction `TenantDatabase.transaction()` owns.
 */

/** Raised when a collection name already exists in the tenant — the service maps it to a 409. */
export class DocCollectionNameConflictError extends Error {
  constructor(readonly collectionName: string) {
    super(`A collection named "${collectionName}" already exists`);
    this.name = 'DocCollectionNameConflictError';
  }
}

/** One member document of a collection, joined to its live `documents` row for the caller's list. */
export interface CollectionDocumentRow {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: Date;
}

/** A collection's member documents joined to `documents`, so a long list must not be unbounded. */
const MAX_MEMBERS_LISTED = 500;
/** A tenant's collection list is bounded like every other list read. */
const MAX_COLLECTIONS_LISTED = 500;

export class DocCollectionsRepository {
  /**
   * Resolve one collection DEFINITION by id, scoped to the acting tenant, or null. A membership row
   * (which shares the table) is never returned: the `collectionId IS NULL` predicate keeps this to
   * definitions, so `:id` in the route always means a collection, never one of its membership rows.
   */
  async findCollection(
    runner: TenantQueryRunner,
    context: TenantContext,
    collectionId: string,
  ): Promise<DocCollectionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docCollections)
      .where(
        and(
          eq(docCollections.organizationId, context.organizationId),
          eq(docCollections.id, collectionId),
          isNull(docCollections.collectionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a collection definition. A name already used in the tenant collides on
   * `uq_doc_collections_name` and is surfaced as {@link DocCollectionNameConflictError}; any other
   * error is a real failure and is rethrown.
   */
  async createCollection(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<DocCollectionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(docCollections).values({
        id,
        organizationId: context.organizationId,
        collectionId: null,
        documentId: null,
        name,
        createdAt: new Date(),
      });
    } catch (error) {
      const clash = await db
        .select()
        .from(docCollections)
        .where(
          and(
            eq(docCollections.organizationId, context.organizationId),
            eq(docCollections.name, name),
            isNull(docCollections.collectionId),
          ),
        )
        .limit(1);
      if (clash[0]) {
        throw new DocCollectionNameConflictError(name);
      }
      throw error;
    }
    const inserted = await this.findCollection(runner, context, id);
    return inserted as DocCollectionRow;
  }

  /** List the tenant's collection definitions, name-ascending, id breaking ties. Bounded. */
  async listCollections(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly DocCollectionRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(docCollections)
      .where(
        and(
          eq(docCollections.organizationId, context.organizationId),
          isNull(docCollections.collectionId),
          isNotNull(docCollections.name),
        ),
      )
      .orderBy(asc(docCollections.name), asc(docCollections.id))
      .limit(MAX_COLLECTIONS_LISTED);
  }

  /** Fetch one membership row (a document in a collection), scoped to the acting tenant, or null. */
  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    collectionId: string,
    documentId: string,
  ): Promise<DocCollectionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docCollections)
      .where(
        and(
          eq(docCollections.organizationId, context.organizationId),
          eq(docCollections.collectionId, collectionId),
          eq(docCollections.documentId, documentId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Add a document to a collection, idempotently. If the membership already exists it is returned
   * unchanged (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant withholds
   * UPDATE); otherwise a new row is inserted. `uq_doc_collections_member` is the guard: a racing insert
   * that collides is caught and the existing row re-read.
   */
  async addMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    collectionId: string,
    documentId: string,
  ): Promise<DocCollectionRow> {
    const existing = await this.findMember(runner, context, collectionId, documentId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(docCollections).values({
        id,
        organizationId: context.organizationId,
        collectionId,
        documentId,
        name: null,
        createdAt: new Date(),
      });
    } catch (error) {
      const raced = await this.findMember(runner, context, collectionId, documentId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.findMember(runner, context, collectionId, documentId);
    return inserted as DocCollectionRow;
  }

  /** Remove a document from a collection, scoped to the acting tenant. Idempotent (no row → no-op). */
  async removeMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    collectionId: string,
    documentId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(docCollections)
      .where(
        and(
          eq(docCollections.organizationId, context.organizationId),
          eq(docCollections.collectionId, collectionId),
          eq(docCollections.documentId, documentId),
        ),
      );
  }

  /**
   * List one collection's member documents, joined to the live document, newest first. The inner join
   * drops a membership whose document no longer exists; the service further filters to documents the
   * caller can still read. Bounded.
   */
  async listMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    collectionId: string,
  ): Promise<readonly CollectionDocumentRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: docCollections.id,
        documentId: documents.id,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: docCollections.createdAt,
      })
      .from(docCollections)
      .innerJoin(
        documents,
        and(
          eq(documents.organizationId, docCollections.organizationId),
          eq(documents.id, docCollections.documentId),
        ),
      )
      .where(
        and(
          eq(docCollections.organizationId, context.organizationId),
          eq(docCollections.collectionId, collectionId),
        ),
      )
      .orderBy(asc(documents.title), asc(docCollections.id))
      .limit(MAX_MEMBERS_LISTED);
  }
}
