import { and, asc, count, desc, eq, gt, isNull, lte, max, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditAnchors, auditEvents, auditHeads } from '../../common/database/schema.js';
import type { AuditAnchorRow, AuditHeadRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { genesisHash } from './audit-chain.js';
import type { ChainedEvent } from './audit-chain.js';

/**
 * 56-11 — the statements behind the audit hash chain (0261). Every statement carries the tenant
 * predicate. Two halves:
 *
 * - **Writer** ({@link lockHead}, {@link advanceHead}): runs inside the audit write's own
 *   transaction. The organization's `audit_heads` row is read `FOR UPDATE`, which serialises every
 *   audit writer in one organization until commit — the chain cannot fork. The read also returns
 *   the server clock, so the `created_at` that is hashed is the one that is stored.
 * - **Verifier** (the rest): reads only. The runtime credential holds no UPDATE or DELETE on
 *   `audit_events` or `audit_anchors`, and nothing here would need one.
 */

export interface LockedHead {
  readonly head: AuditHeadRow;
  /** The database's `current_timestamp(3)` as read under the lock. */
  readonly now: Date;
}

/** `current_timestamp(3)` arrives as a `Date` (UTC session) or, on some drivers, as text. */
export function toUtcDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/u.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

export const VERIFY_PAGE_SIZE = 500;

export class AuditChainRepository {
  async lockHead(runner: TenantQueryRunner, context: TenantContext): Promise<LockedHead> {
    const existing = await this.selectHeadForUpdate(runner, context);
    if (existing !== null) return existing;

    // First chained write of this organization (the worker's backfill normally got here first).
    // The newest pre-chain row is recorded as the legacy marker: everything up to it is the
    // unhashed prefix, anything unhashed after it is a gap the verifier reports.
    const legacy = await tenantDrizzle(runner)
      .select({ last: max(auditEvents.id) })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, context.organizationId));
    await tenantDrizzle(runner)
      .insert(auditHeads)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        chainSeq: 0,
        headHash: genesisHash(context.organizationId),
        lastEventId: null,
        legacyLastEventId: legacy[0]?.last ?? null,
        chainStartedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      // A concurrent first writer won the race: keep its row untouched (a no-op assignment; the
      // tenant guard refuses one that names the tenant key).
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    const created = await this.selectHeadForUpdate(runner, context);
    if (created === null) throw new Error('The audit chain head could not be created');
    return created;
  }

  private async selectHeadForUpdate(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<LockedHead | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: auditHeads.id,
        organizationId: auditHeads.organizationId,
        chainSeq: auditHeads.chainSeq,
        headHash: auditHeads.headHash,
        lastEventId: auditHeads.lastEventId,
        legacyLastEventId: auditHeads.legacyLastEventId,
        chainStartedAt: auditHeads.chainStartedAt,
        updatedAt: auditHeads.updatedAt,
        purgedThroughSeq: auditHeads.purgedThroughSeq,
        purgedThroughHash: auditHeads.purgedThroughHash,
        purgedAt: auditHeads.purgedAt,
        now: sql<unknown>`current_timestamp(3)`,
      })
      .from(auditHeads)
      .where(eq(auditHeads.organizationId, context.organizationId))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) return null;
    const { now, ...head } = row;
    return { head: { ...head, chainSeq: Number(head.chainSeq) }, now: toUtcDate(now) };
  }

  async advanceHead(
    runner: TenantQueryRunner,
    context: TenantContext,
    headId: string,
    next: { readonly chainSeq: number; readonly headHash: string; readonly lastEventId: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(auditHeads)
      .set({
        chainSeq: next.chainSeq,
        headHash: next.headHash,
        lastEventId: next.lastEventId,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(and(eq(auditHeads.organizationId, context.organizationId), eq(auditHeads.id, headId)));
  }

  /**
   * 0358 — move the retention purge's boundary to the last purged chain position and that row's
   * hash. Runs in the purge batch's own transaction, after its DELETE, so the verifier never sees
   * a purged prefix without the boundary that explains it. Only ever moves forward.
   */
  async recordPurgeBoundary(
    runner: TenantQueryRunner,
    context: TenantContext,
    boundary: { readonly chainSeq: number; readonly rowHash: string; readonly at: Date },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(auditHeads)
      .set({
        purgedThroughSeq: boundary.chainSeq,
        purgedThroughHash: boundary.rowHash,
        purgedAt: boundary.at,
      })
      .where(
        and(
          eq(auditHeads.organizationId, context.organizationId),
          sql`coalesce(${auditHeads.purgedThroughSeq}, 0) < ${boundary.chainSeq}`,
        ),
      );
  }

  // ---- verifier (read-only) ----

  async readHead(runner: TenantQueryRunner, context: TenantContext): Promise<AuditHeadRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(auditHeads)
      .where(eq(auditHeads.organizationId, context.organizationId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : { ...row, chainSeq: Number(row.chainSeq) };
  }

  /** Chained rows after `afterSeq`, in chain order. */
  async chainedPage(
    runner: TenantQueryRunner,
    context: TenantContext,
    afterSeq: number,
    limit = VERIFY_PAGE_SIZE,
  ): Promise<readonly ChainedEvent[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        organizationId: auditEvents.organizationId,
        id: auditEvents.id,
        createdAt: auditEvents.createdAt,
        actorUserId: auditEvents.actorUserId,
        effectiveActorId: auditEvents.effectiveActorId,
        action: auditEvents.action,
        objectType: auditEvents.objectType,
        objectId: auditEvents.objectId,
        result: auditEvents.result,
        metadataJson: auditEvents.metadataJson,
        chainSeq: auditEvents.chainSeq,
        prevHash: auditEvents.prevHash,
        rowHash: auditEvents.rowHash,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          gt(auditEvents.chainSeq, afterSeq),
        ),
      )
      .orderBy(asc(auditEvents.chainSeq))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      chainSeq: Number(row.chainSeq),
      prevHash: row.prevHash ?? '',
      rowHash: row.rowHash ?? '',
    }));
  }

  /** Unhashed rows: the legacy prefix (up to the marker) and any written after it (a gap). */
  async unchainedCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    legacyLastEventId: string | null,
  ): Promise<{ readonly legacy: number; readonly unchained: number }> {
    const base = and(
      eq(auditEvents.organizationId, context.organizationId),
      isNull(auditEvents.chainSeq),
    );
    const legacy =
      legacyLastEventId === null
        ? 0
        : Number(
            (
              await tenantDrizzle(runner)
                .select({ n: count() })
                .from(auditEvents)
                .where(and(base, lte(auditEvents.id, legacyLastEventId)))
            )[0]?.n ?? 0,
          );
    const after =
      legacyLastEventId === null ? base : and(base, gt(auditEvents.id, legacyLastEventId));
    const unchained = Number(
      (await tenantDrizzle(runner).select({ n: count() }).from(auditEvents).where(after))[0]?.n ??
        0,
    );
    return { legacy, unchained };
  }

  async anchors(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit = 400,
  ): Promise<readonly AuditAnchorRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(auditAnchors)
      .where(eq(auditAnchors.organizationId, context.organizationId))
      .orderBy(desc(auditAnchors.day))
      .limit(limit);
    return rows.map((row) => ({ ...row, eventCount: Number(row.eventCount) }));
  }
}
