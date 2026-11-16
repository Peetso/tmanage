import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  sql,
} from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  auditEventChanges,
  auditEvents,
  auditRetentionPolicy,
  organizations,
} from '../../common/database/schema.js';
import type { AuditRetentionPolicyRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/** One chained audit row as the purge needs it: where it sits and its hash (the next boundary). */
export interface PurgeableChainRow {
  readonly id: string;
  readonly chainSeq: number;
  readonly rowHash: string;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

/**
 * The data half of the audit-log retention policy (Administration module 18, x279) — the tenant-scoped
 * resolve/read/upsert of the one-row-per-organization policy, and the read-only purge-preview COUNT over
 * the existing `audit_events`. It owns the `audit_retention_policy` table alone, so the retention
 * surface stays file-disjoint from the security (x176), org-settings (x153) and audit (x115)
 * repositories in the same module.
 *
 * ## Every query is scoped to the acting tenant
 *
 * The resolve, the read, the upsert and the preview COUNT all carry an
 * `organization_id = context.organizationId` predicate, so another studio's policy is never read or
 * overwritten and another studio's audit rows are never counted. The service resolves the organization
 * tenant-scoped (via {@link resolveOrganization}) before it authorizes or writes, so a context naming an
 * organization that does not exist in this tenant is a 404 with no write.
 *
 * ## The preview never writes to `audit_events`
 *
 * {@link countEventsOlderThan} is a `SELECT count(*)` and nothing else.
 *
 * ## The purge statements (0358)
 *
 * The rest of this file is the purge's half (`audit-retention-purge.ts` drives it): the boundary of
 * the chained prefix older than the cutoff, a batch of those rows, a batch of unchained (legacy)
 * rows, and the DELETE of a batch. Every one names the acting organization; the DELETE repeats
 * `created_at < cutoff`, and the 0358 trigger refuses any row not past the organization's own
 * stored window, whatever the statement says.
 */
export class AuditRetentionRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a 500 on a dangling upsert.
   */
  async resolveOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /** The acting tenant's retention policy row, if one has been written — otherwise `undefined` (default). */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AuditRetentionPolicyRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(auditRetentionPolicy)
      .where(eq(auditRetentionPolicy.organizationId, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the acting tenant's retention policy, one row per organization: a first write inserts, a
   * re-save overwrites `retention_days` and who set it and when, in place. `id` and `organization_id`
   * are never changed on the update path — the 0148 trigger holds `organization_id` immutable at the
   * engine besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly retentionDays: number; readonly updatedBy: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(auditRetentionPolicy)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        retentionDays: input.retentionDays,
        updatedBy: input.updatedBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          retentionDays: input.retentionDays,
          updatedBy: input.updatedBy,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  /**
   * Count this tenant's `audit_events` older than the cutoff — the purge preview, read-only. Scoped by
   * `organization_id` and filtered on `created_at < cutoff`; `ix_audit_events_org_time` leads with
   * `organization_id` then `created_at`, which is exactly this predicate. Writes nothing.
   */
  async countEventsOlderThan(
    runner: TenantQueryRunner,
    context: TenantContext,
    cutoff: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          lt(auditEvents.createdAt, cutoff),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
  /**
   * Organizations that explicitly set a retention window — the only ones the purge visits. Read on
   * the bootstrap path (the purge job finds work across tenants, then does it under each one's own
   * context); a workspace without a policy row is never listed.
   */
  async organizationsWithPolicy(
    runner: BootstrapQueryRunner,
    minimumDays: number,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: auditRetentionPolicy.organizationId })
      .from(auditRetentionPolicy)
      .where(gte(auditRetentionPolicy.retentionDays, minimumDays))
      .orderBy(asc(auditRetentionPolicy.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * The last chain position the purge may reach: every chained row up to it is older than the
   * cutoff, so removing them leaves one contiguous kept suffix. It is the position before the first
   * row at or after the cutoff, or — when none is — the newest chained row older than it. 0 = none.
   */
  async purgeableThrough(
    runner: TenantQueryRunner,
    context: TenantContext,
    cutoff: Date,
  ): Promise<number> {
    const chained = and(
      eq(auditEvents.organizationId, context.organizationId),
      isNotNull(auditEvents.chainSeq),
    );
    const firstKept = await tenantDrizzle(runner)
      .select({ seq: min(auditEvents.chainSeq) })
      .from(auditEvents)
      .where(and(chained, gte(auditEvents.createdAt, cutoff)));
    const kept = firstKept[0]?.seq;
    if (kept != null) return Math.max(0, Number(kept) - 1);
    const lastOld = await tenantDrizzle(runner)
      .select({ seq: max(auditEvents.chainSeq) })
      .from(auditEvents)
      .where(and(chained, lt(auditEvents.createdAt, cutoff)));
    return Number(lastOld[0]?.seq ?? 0);
  }

  /** Chained rows after `afterSeq` and up to `throughSeq`, older than the cutoff, in chain order. */
  async chainedBatch(
    runner: TenantQueryRunner,
    context: TenantContext,
    range: { readonly afterSeq: number; readonly throughSeq: number; readonly cutoff: Date },
    limit: number,
  ): Promise<readonly PurgeableChainRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({ id: auditEvents.id, chainSeq: auditEvents.chainSeq, rowHash: auditEvents.rowHash })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          gt(auditEvents.chainSeq, range.afterSeq),
          lte(auditEvents.chainSeq, range.throughSeq),
          lt(auditEvents.createdAt, range.cutoff),
        ),
      )
      .orderBy(asc(auditEvents.chainSeq))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      chainSeq: Number(row.chainSeq),
      rowHash: row.rowHash ?? '',
    }));
  }

  /** Unchained (pre-0261 legacy) rows older than the cutoff, oldest id first. */
  async legacyBatch(
    runner: TenantQueryRunner,
    context: TenantContext,
    cutoff: Date,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          isNull(auditEvents.chainSeq),
          lt(auditEvents.createdAt, cutoff),
        ),
      )
      .orderBy(asc(auditEvents.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Delete one batch of this organization's audit rows (their field diffs first, the 0241 foreign
   * key), each still older than the cutoff. Returns how many audit rows went.
   */
  async deleteEvents(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
    cutoff: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    await tenantDrizzle(runner)
      .delete(auditEventChanges)
      .where(
        and(
          eq(auditEventChanges.organizationId, context.organizationId),
          inArray(auditEventChanges.auditEventId, [...ids]),
        ),
      );
    const result = await tenantDrizzle(runner)
      .delete(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          inArray(auditEvents.id, [...ids]),
          lt(auditEvents.createdAt, cutoff),
        ),
      );
    return affected(result);
  }
}
