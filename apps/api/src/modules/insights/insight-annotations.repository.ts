import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightAnnotations } from '../../common/database/schema.js';
import type { InsightAnnotationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x271's data seam — the tenant-scoped reads, the one insert, and the author-scoped delete over
 * `insight_annotations` rows. It follows the `focus_blocks` (x255) / `project_update_comments` (x203)
 * repository pattern and honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateInsightAnnotationInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes resolve-then-act on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface CreateInsightAnnotationInput {
  /** The snapshot this note explains — resolved tenant-scoped by the service before the insert. */
  readonly snapshotId: string;
  /** The author — the service passes `context.membershipId`, never a value from input. */
  readonly authorMembershipId: string;
  readonly note: string;
  readonly createdAt: Date;
}

/** A snapshot's annotations list is bounded so it can never return an unbounded result. */
const MAX_ANNOTATIONS_LISTED = 200;

export class InsightAnnotationsRepository {
  /** Insert one annotation; returns the stored row. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateInsightAnnotationInput,
  ): Promise<InsightAnnotationRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(insightAnnotations).values({
      id,
      organizationId: context.organizationId,
      snapshotId: input.snapshotId,
      authorMembershipId: input.authorMembershipId,
      note: input.note,
      createdAt: input.createdAt,
    });
    const inserted = await this.findById(runner, context, input.snapshotId, id);
    return inserted as InsightAnnotationRow;
  }

  /**
   * Fetch one annotation by id, scoped to the acting tenant and its parent snapshot, or null. The
   * `(organization_id, snapshot_id, id)` predicate means a cross-tenant or wrong-snapshot id resolves
   * to nothing; the service maps that to a 404. The row carries `authorMembershipId`, so the service
   * can decide ownership (a foreign author is a 403, not a delete).
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    snapshotId: string,
    id: string,
  ): Promise<InsightAnnotationRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(insightAnnotations)
      .where(
        and(
          eq(insightAnnotations.organizationId, context.organizationId),
          eq(insightAnnotations.snapshotId, snapshotId),
          eq(insightAnnotations.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Delete one annotation, scoped to the acting tenant, its parent snapshot, AND its author. Returns
   * whether a row was removed; the service resolves ownership first, so this is only ever reached for
   * a row the caller authored.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    snapshotId: string,
    id: string,
    authorMembershipId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(insightAnnotations)
      .where(
        and(
          eq(insightAnnotations.organizationId, context.organizationId),
          eq(insightAnnotations.snapshotId, snapshotId),
          eq(insightAnnotations.id, id),
          eq(insightAnnotations.authorMembershipId, authorMembershipId),
        ),
      );
  }

  /**
   * List one snapshot's annotations, newest first, id breaking ties. Scoped to the acting tenant and
   * parent snapshot; bounded, so one request is never an unbounded scan.
   */
  async listForSnapshot(
    runner: TenantQueryRunner,
    context: TenantContext,
    snapshotId: string,
  ): Promise<readonly InsightAnnotationRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(insightAnnotations)
      .where(
        and(
          eq(insightAnnotations.organizationId, context.organizationId),
          eq(insightAnnotations.snapshotId, snapshotId),
        ),
      )
      .orderBy(desc(insightAnnotations.createdAt), desc(insightAnnotations.id))
      .limit(MAX_ANNOTATIONS_LISTED);
  }
}
