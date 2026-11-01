import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documentComments } from '../../common/database/schema.js';
import type { DocumentCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The document-comments repository — Docs "collaboration later" (x132), following the
 * `document-versions`/`documents` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * sibling repositories honour it: every method's first two parameters are the `TenantQueryRunner`
 * and the `TenantContext`, there is no unscoped overload, the tenant comes from the context and
 * never from a DTO, and the tenant predicate is on every statement so a forgotten one throws
 * rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** No `organizationId` — it is taken from the context, so there is no field for a body to populate. */
export interface AppendDocumentCommentInput {
  readonly documentId: string;
  readonly body: string;
  /** The membership the comment is written under — the service passes `context.membershipId`. */
  readonly authorMembershipId: string;
  /** R5 (0272): the `mark[data-comment]` id the comment hangs on; null for a general comment. */
  readonly anchorId?: string | null;
  /** R5 (0272): the selected text when the comment was made (≤ 500). */
  readonly anchorQuote?: string | null;
}

export interface ListDocumentCommentsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

/**
 * R5 (0272) comment columns. Slice 2 adds them to `documentComments` in schema.ts with the
 * migration; until that lands drizzle simply leaves them out of the SQL, and once it lands this
 * code writes and reads them unchanged (the intersection then matches the row exactly).
 */
export type DocumentCommentRowWithAnchor = DocumentCommentRow & {
  readonly anchorId?: string | null;
  readonly anchorQuote?: string | null;
  readonly resolvedAt?: Date | null;
  readonly resolvedByUserId?: string | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DocumentCommentsRepository {
  /**
   * List one document's comments, within the acting tenant, oldest first.
   *
   * Both `organization_id` and `document_id` predicates are present. Keyset rather than offset
   * pagination on `id`: `(organization_id, document_id, id)` is the schema's list index and UUIDv7
   * ids sort in creation order, so the walk is chronological without a second sort column. A
   * comment thread reads oldest-first (a conversation), the opposite of the versions trail.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    options: ListDocumentCommentsOptions = {},
  ): Promise<readonly DocumentCommentRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(documentComments.organizationId, context.organizationId),
      eq(documentComments.documentId, documentId),
      // PA-03 (0245): a soft-deleted comment leaves the list.
      isNull(documentComments.deletedAt),
    ];
    if (options.after) predicates.push(gt(documentComments.id, options.after));

    return db
      .select()
      .from(documentComments)
      .where(and(...predicates))
      .orderBy(asc(documentComments.id))
      .limit(limit);
  }

  /**
   * Append a comment to a document.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The document is *not* re-checked to belong to the tenant here:
   * `fk_document_comments_document_tenant` is a composite foreign key including `organization_id`,
   * so the database refuses a document from another tenant — but the service resolves the document
   * tenant-scoped *before* this insert anyway (the Known trap), so a cross-tenant id is a 404, never
   * a foreign-key error reached here.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendDocumentCommentInput,
  ): Promise<DocumentCommentRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    // Spread from a variable: the R5 columns pass the type check before slice 2 declares them.
    const anchor = { anchorId: input.anchorId ?? null, anchorQuote: input.anchorQuote ?? null };
    await db.insert(documentComments).values({
      id,
      organizationId: context.organizationId,
      documentId: input.documentId,
      authorMembershipId: input.authorMembershipId,
      body: input.body,
      createdAt: sql`current_timestamp(3)`,
      ...anchor,
    });

    const rows = await db
      .select()
      .from(documentComments)
      .where(
        and(
          eq(documentComments.organizationId, context.organizationId),
          eq(documentComments.id, id),
        ),
      )
      .limit(1);
    // The row now carries the server-generated timestamp; reading it back keeps the two in step.
    return rows[0] as DocumentCommentRow;
  }

  /**
   * R5: resolve (`resolvedByUserId` set) or reopen (null) one live comment of one document.
   *
   * Tenant, document and soft-delete predicates are all on the UPDATE, so a comment of another
   * document, another tenant or a deleted one changes nothing and reads back as null (→ 404). The
   * 0245 trigger pins only id/org/document/author/body/created_at, so these columns may change.
   */
  async setResolved(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    commentId: string,
    resolvedByUserId: string | null,
  ): Promise<DocumentCommentRowWithAnchor | null> {
    const db = tenantDrizzle(runner);
    const scope = and(
      eq(documentComments.organizationId, context.organizationId),
      eq(documentComments.documentId, documentId),
      eq(documentComments.id, commentId),
      isNull(documentComments.deletedAt),
    );
    const change = {
      resolvedAt: resolvedByUserId === null ? null : sql`current_timestamp(3)`,
      resolvedByUserId,
    };
    await db
      .update(documentComments)
      // The R5 columns are declared by slice 2's schema.ts change; until then the type is cast.
      .set(change as unknown as Partial<typeof documentComments.$inferInsert>)
      .where(scope);
    const rows = await db.select().from(documentComments).where(scope).limit(1);
    return rows[0] ?? null;
  }
}
