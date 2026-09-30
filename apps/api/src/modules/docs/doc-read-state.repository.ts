import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { docReadState } from '../../common/database/schema.js';
import type { DocReadStateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC read state (x297) — a membership's private read cursor over `documents` rows. It owns the
 * mark-read upsert, the mark-unread delete, and the batch read of the caller's read-state rows for a
 * set of documents. It follows the `home_widget_prefs` repository (x243) upsert pattern and honours
 * `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link MarkReadInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the check-then-write on one connection
 * inside the transaction `TenantDatabase.transaction()` owns.
 */

/** What the service upserts. No `organizationId` (from the context). */
export interface MarkReadInput {
  readonly docId: string;
  /** The reading membership — the service passes `context.membershipId`. */
  readonly membershipId: string;
}

/** A read-state row bounded so a batch query over caller-supplied ids cannot be unbounded. */
const MAX_READ_STATE_BATCH = 200;

export class DocReadStateRepository {
  /** Fetch one membership's read-state of one document, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
    membershipId: string,
  ): Promise<DocReadStateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(docReadState)
      .where(
        and(
          eq(docReadState.organizationId, context.organizationId),
          eq(docReadState.docId, docId),
          eq(docReadState.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Mark a document read for a membership, idempotently. A single `INSERT ... ON DUPLICATE KEY UPDATE`
   * against `uq_doc_read_state_pin`: the first mark inserts, a repeated mark refreshes `last_read_at` in
   * place (never a second row). Two racing marks serialise on the unique key. The row is re-read and
   * returned.
   */
  async markRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: MarkReadInput,
  ): Promise<DocReadStateRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(docReadState)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        docId: input.docId,
        membershipId: input.membershipId,
        lastReadAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          lastReadAt: sql`current_timestamp(3)`,
        },
      });

    const row = await this.find(runner, context, input.docId, input.membershipId);
    return row as DocReadStateRow;
  }

  /** Mark a document unread for a membership (delete the cursor), scoped to the acting tenant. Idempotent. */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    docId: string,
    membershipId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(docReadState)
      .where(
        and(
          eq(docReadState.organizationId, context.organizationId),
          eq(docReadState.docId, docId),
          eq(docReadState.membershipId, membershipId),
        ),
      );
  }

  /**
   * The caller's read-state rows for a set of documents, scoped to the acting tenant and the caller's
   * membership. Only rows this membership owns are returned — a batch read never leaks another member's
   * cursor. Empty `docIds` returns no rows without a query. Bounded.
   */
  async findForMemberByDocIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    docIds: readonly string[],
  ): Promise<readonly DocReadStateRow[]> {
    if (docIds.length === 0) {
      return [];
    }
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(docReadState)
      .where(
        and(
          eq(docReadState.organizationId, context.organizationId),
          eq(docReadState.membershipId, membershipId),
          inArray(docReadState.docId, docIds.slice(0, MAX_READ_STATE_BATCH)),
        ),
      )
      .limit(MAX_READ_STATE_BATCH);
  }
}
