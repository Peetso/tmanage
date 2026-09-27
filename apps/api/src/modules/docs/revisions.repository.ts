import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docRevisions, documents } from '../../common/database/schema.js';
import type { DocRevisionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC revision history (x241) — the append-only revision trail behind a `documents` row. It owns the
 * snapshot insert and the in-transaction bump of the parent `documents.body`, following the
 * `document-versions` repository (x112) pattern and honouring `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AppendRevisionInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the revision insert and the parent
 * `documents` update on one connection inside one transaction `TenantDatabase.transaction()` owns.
 */

/**
 * What the service appends. No `organizationId` (from the context), no `rev_no` (derived inside the
 * transaction from the current maximum for the document, so a caller cannot choose it).
 */
export interface AppendRevisionInput {
  readonly docId: string;
  readonly bodySnapshot: string;
  /** The person saving this revision — the service passes `context.userId`. */
  readonly savedBy: string;
}

/** Each row carries the full snapshot (TEXT), so a long history must not return unbounded. */
const MAX_REVISIONS_LISTED = 200;

export class DocRevisionsRepository {
  /** List one document's revisions, newest first, within the acting tenant. Bounded. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
  ): Promise<readonly DocRevisionRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(docRevisions)
      .where(
        and(eq(docRevisions.organizationId, context.organizationId), eq(docRevisions.docId, docId)),
      )
      .orderBy(desc(docRevisions.revNo))
      .limit(MAX_REVISIONS_LISTED);
  }

  /** Fetch one revision by its id, scoped to the acting tenant and the document. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
    revisionId: string,
  ): Promise<DocRevisionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docRevisions)
      .where(
        and(
          eq(docRevisions.organizationId, context.organizationId),
          eq(docRevisions.docId, docId),
          eq(docRevisions.id, revisionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The highest `rev_no` a document holds in the acting tenant, or 0 when it has none yet. */
  async latestRevNo(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ max: sql<number | null>`max(${docRevisions.revNo})` })
      .from(docRevisions)
      .where(
        and(eq(docRevisions.organizationId, context.organizationId), eq(docRevisions.docId, docId)),
      );
    return Number(rows[0]?.max ?? 0);
  }

  /**
   * Append one snapshot and bump the parent document's current body, in the caller's transaction.
   *
   * The id and next `rev_no` are computed here (UUIDv7, `07-DATA-MODEL`; the number from
   * {@link latestRevNo} + 1, monotonic per document). `organization_id` comes from the context. The
   * `documents.body` update carries the tenant predicate so the guard is satisfied and the 0030
   * immutability trigger permits it (only `title`/`body` are editable). A restore is this same
   * append with a prior snapshot's body — never a raw column overwrite, and history survives.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendRevisionInput,
  ): Promise<DocRevisionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    const revNo = (await this.latestRevNo(runner, context, input.docId)) + 1;

    await db.insert(docRevisions).values({
      id,
      organizationId: context.organizationId,
      docId: input.docId,
      revNo,
      bodySnapshot: input.bodySnapshot,
      savedBy: input.savedBy,
      savedAt: sql`current_timestamp(3)`,
    });

    await db
      .update(documents)
      .set({ body: input.bodySnapshot })
      .where(
        and(eq(documents.organizationId, context.organizationId), eq(documents.id, input.docId)),
      );

    const rows = await db
      .select()
      .from(docRevisions)
      .where(and(eq(docRevisions.organizationId, context.organizationId), eq(docRevisions.id, id)))
      .limit(1);
    return rows[0] as DocRevisionRow;
  }
}
