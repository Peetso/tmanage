import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { DocTagRow, DocumentRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocTagsRepository } from './doc-tags.repository.js';

/**
 * x269's application service — document tags / labels (Docs module).
 *
 * Two objects, one table (see `0139_doc_tags.sql`): a **tag definition** the studio owns, and a **tag
 * assignment** tying a definition to a document. The rules that matter live here, the way
 * `WorkLabelsService` (x233) and `DocBookmarksService` (x242) place them:
 *
 * ## Resolve the document AND the tag, tenant-scoped, BEFORE authorizing or writing
 *
 * Assign, remove and list-for-document name a `documentId` in the path; the parent document is read
 * first, scoped to the acting tenant — a cross-tenant `document_id` simply does not resolve, and the
 * answer is the same 404 an absent id gives, before `authorize()` is asked and before any write. The
 * tag id is resolved the same way: a tag of another studio does not resolve and is a 404. This is the
 * Known-trap order: a missing or cross-tenant id is a 404, never a foreign-key 500 and never a 403
 * that would confirm the row exists.
 *
 * ## Definitions are org-scoped; the coarse gate is the capability
 *
 * The route guard asks the coarse question a guard can answer with no object loaded — `doc.read` to
 * list, `doc.write` to define / assign / unassign. This service adds the object-level decision with
 * the document's row in hand. A document the caller may not read is 404, never 403. `doc.read` is a
 * ceiling-mirror of `work.read` (see `packages/domain`'s `capabilities.ts`), so the readability check
 * is expressed as `work.read`, exactly as `DocBookmarksService` records.
 *
 * A tag name is unique per tenant — a collision is a 409. Tagging is idempotent: assigning a tag
 * already on the document returns the existing assignment rather than a duplicate.
 */

/** The client-facing projection of one tag definition — paired Exact with the web's `DocTag`. */
export interface DocTagView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The client-facing projection of one tag assigned to a document — paired Exact with `DocumentTag`. */
export interface DocumentTagView {
  readonly id: string;
  readonly documentId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

export class DocTagsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documentsRepo: DocumentsRepository = new DocumentsRepository(),
    private readonly tags: DocTagsRepository = new DocTagsRepository(),
  ) {}

  /** The tenant's tag definitions, name-ascending. Behind `doc.read`. */
  async listDefinitions(context: TenantContext): Promise<readonly DocTagView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.tags.listDefinitions(runner, context);
      return rows.map(toTagView);
    });
  }

  /** Define a tag. Behind `doc.write`. Duplicate name → 409, blank/oversized name → 400. */
  async define(context: TenantContext, rawName: unknown): Promise<DocTagView> {
    const name = requiredName(rawName);
    return this.database.transaction(context, async (tx) => {
      const clash = await this.tags.findDefinitionByName(tx, context, name);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A tag with this name already exists');
      }
      const row = await this.tags.createDefinition(tx, context, name);
      return toTagView(row);
    });
  }

  /** The tags assigned to a document the caller can read. Behind `doc.read`. */
  async listForDocument(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<readonly DocumentTagView[]> {
    return this.database.read(context, async (runner) => {
      await this.requireReadable(context, principal, documentId, runner);
      const [assignments, definitions] = await Promise.all([
        this.tags.listAssignments(runner, context, documentId),
        this.tags.listDefinitions(runner, context),
      ]);
      const byId = new Map(definitions.map((row) => [row.id, row]));
      return assignments
        .map((assignment) => toDocumentTagView(assignment, byId.get(assignment.tagId ?? '')))
        .filter((view): view is DocumentTagView => view !== null);
    });
  }

  /**
   * Tag a document. Behind `doc.write`. The document is resolved readable (tenant-scoped) first, so a
   * cross-tenant document id is a 404 with no insert; an unknown tag id is likewise a 404. Idempotent.
   */
  async assign(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    tagId: string,
  ): Promise<DocumentTagView> {
    return this.database.transaction(context, async (tx) => {
      await this.requireReadable(context, principal, documentId, tx);

      const definition = await this.tags.findDefinition(tx, context, tagId);
      if (!definition) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const existing = await this.tags.findAssignment(tx, context, documentId, tagId);
      const row = existing ?? (await this.tags.createAssignment(tx, context, documentId, tagId));
      const view = toDocumentTagView(row, definition);
      if (!view) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return view;
    });
  }

  /** Untag a document. Behind `doc.write`. A tag that is not present is a no-op 204. */
  async remove(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    tagId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.requireReadable(context, principal, documentId, tx);
      await this.tags.deleteAssignment(tx, context, documentId, tagId);
    });
  }

  /**
   * Resolve a document the principal may read, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not read, is 404 — never 403, never 500.
   */
  private async requireReadable(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    runner: TenantQueryRunner,
  ): Promise<DocumentRow> {
    const row = await this.documentsRepo.findById(runner, context, documentId);
    const permitted =
      row !== null &&
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: row.organizationId,
          projectId: row.projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;

    if (!row || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }
    return row;
  }
}

function toTagView(row: DocTagRow): DocTagView {
  return {
    id: row.id,
    name: row.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

/** An assignment row plus its definition; `null` if the definition is missing (never, in practice). */
function toDocumentTagView(
  assignment: DocTagRow,
  definition: DocTagRow | undefined,
): DocumentTagView | null {
  if (!definition || assignment.documentId === null || assignment.tagId === null) return null;
  return {
    id: assignment.id,
    documentId: assignment.documentId,
    tagId: assignment.tagId,
    name: definition.name ?? '',
    createdAt: assignment.createdAt.toISOString(),
  };
}

function requiredName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  const name = raw.trim();
  if (name.length > 120) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be 120 characters or fewer' },
    ]);
  }
  return name;
}
