import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documentVersions, documents } from '../../common/database/schema.js';
import type { DocumentVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The document-versions repository — DOC-02/DOC-03 (x112), following the `documents`/`meetings`
 * pattern. It owns the append-only version trail behind a document and the in-transaction bump of
 * the parent `documents.body`.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * documents repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link AppendVersionInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the service composes the version insert and the parent
 * `documents` update on one connection inside one transaction that `TenantDatabase.transaction()`
 * owns.
 */

/**
 * What the service appends. No `organizationId` (from the context), no `versionNo` (derived inside
 * the transaction from the current maximum for the document, so a caller cannot choose it).
 */
export interface AppendVersionInput {
  readonly documentId: string;
  readonly body: string;
  /** The person saving this version — the service passes `context.userId`. */
  readonly editedByUserId: string;
}

/**
 * The newest-first list is bounded: each row carries the full `body` (TEXT), so a document with a
 * long edit history must not return an unbounded response. Mirrors `documents` repository's
 * `MAX_PAGE_SIZE`; older snapshots remain reachable by number via {@link
 * DocumentVersionsRepository.findByVersionNo}.
 */
const MAX_VERSIONS_LISTED = 200;

export class DocumentVersionsRepository {
  /**
   * List one document's versions, newest first, within the acting tenant.
   *
   * Both `organization_id` and `document_id` predicates are present. The order is `version_no`
   * descending — a document's most recent save leads — which is an ordered walk of the
   * `(organization_id, document_id, version_no)` unique key. Bounded to the newest
   * `MAX_VERSIONS_LISTED` so a long history cannot return an unbounded body-bearing response.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
  ): Promise<readonly DocumentVersionRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, context.organizationId),
          eq(documentVersions.documentId, documentId),
        ),
      )
      .orderBy(desc(documentVersions.versionNo))
      .limit(MAX_VERSIONS_LISTED);
  }

  /**
   * Fetch one snapshot by its number, within the acting tenant. Used by DOC-03's compare read and
   * by restore to read the body it forward-appends. Returns null for a number that does not exist
   * for this document in this tenant.
   */
  async findByVersionNo(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    versionNo: number,
  ): Promise<DocumentVersionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, context.organizationId),
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.versionNo, versionNo),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The highest `version_no` a document currently holds in the acting tenant, or 0 when it has no
   * versions yet. The service adds one to get the next number; the `(organization_id, document_id,
   * version_no)` unique key is the concurrency guard when two saves race to the same number.
   */
  async latestVersionNo(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ max: sql<number | null>`max(${documentVersions.versionNo})` })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, context.organizationId),
          eq(documentVersions.documentId, documentId),
        ),
      );
    return Number(rows[0]?.max ?? 0);
  }

  /**
   * Append one snapshot and bump the parent document's current body, in the caller's transaction.
   *
   * The id and the next `version_no` are computed here (UUIDv7, `07-DATA-MODEL`; the number from
   * {@link latestVersionNo} + 1). `organization_id` comes from the context, never from `input`. The
   * `documents.body` update carries the tenant predicate so the guard is satisfied, and the 0030
   * immutability trigger permits it (only `title`/`body` are editable). Both statements run on the
   * runner the service opened, so a failure in either rolls the pair back.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendVersionInput,
  ): Promise<DocumentVersionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    const versionNo = (await this.latestVersionNo(runner, context, input.documentId)) + 1;

    await db.insert(documentVersions).values({
      id,
      organizationId: context.organizationId,
      documentId: input.documentId,
      versionNo,
      body: input.body,
      editedByUserId: input.editedByUserId,
      createdAt: sql`current_timestamp(3)`,
    });

    // Bump the parent document's current body to this version, in the same transaction. Scoped to
    // the tenant and the document; `updated_at` follows via the column's ON UPDATE clause.
    await db
      .update(documents)
      .set({ body: input.body })
      .where(
        and(
          eq(documents.organizationId, context.organizationId),
          eq(documents.id, input.documentId),
        ),
      );

    const rows = await db
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, context.organizationId),
          eq(documentVersions.id, id),
        ),
      )
      .limit(1);
    // The row was just inserted on this connection; read it back so server-generated timestamps
    // are the ones returned rather than a hand-assembled guess.
    return rows[0] as DocumentVersionRow;
  }
}
