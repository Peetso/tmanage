import { and, desc, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { adminSecurityAlerts, auditEvents, organizations } from '../../common/database/schema.js';
import type { AdminSecurityAlertRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** One recent `audit_events` row matched to an enabled alert key, read-only. */
export interface RecentSecurityMatch {
  readonly id: string;
  readonly eventTypeKey: string;
  readonly result: string;
  readonly actorUserId: string | null;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly occurredAt: Date;
}

/**
 * B13 (2026-11-02 live test): the `none` scanner driver writes a `file_asset.scan_failed` row with
 * `cause: no_scanner` when no scanner is configured. Nothing failed — the file simply was not
 * virus-scanned — so that row is never a security-alert match. Every other `scan_failed` row (a
 * real scanner error) still matches. `JSON_UNQUOTE(JSON_EXTRACT(...))` reads the same on MySQL 8
 * and on MariaDB (where JSON is LONGTEXT); a row without `cause` reads NULL and is kept.
 */
export const NOT_NO_SCANNER_ROW: SQL = sql`not (${auditEvents.action} = 'file_asset.scan_failed' and coalesce(json_unquote(json_extract(${auditEvents.metadataJson}, '$.cause')), '') = 'no_scanner')`;

/**
 * The data half of the admin security-event alert configuration (Administration, security monitoring,
 * x329). It owns the `admin_security_alerts` table alone, so the alert surface stays file-disjoint
 * from the security-settings (x176) and audit (x115) repositories in the same module.
 *
 * ## Every query is scoped to the acting tenant
 *
 * The list, upsert and delete all carry an `organization_id = context.organizationId` predicate, and
 * the read-side match reads only `audit_events`, whose `organization_id` is NOT NULL and is likewise
 * scoped — never `authentication_events`, the org-less pre-tenant log, which could not be
 * tenant-scoped. The controller resolves the organization tenant-scoped (via
 * {@link resolveOrganization}) before it authorizes or writes, so a context naming an organization
 * that does not exist in this tenant is a 404 with no write.
 */
export class AdminSecurityAlertsRepository {
  /**
   * The acting organization's id, if it exists in this tenant — otherwise `undefined`. The
   * resolve-before-authorize step: a context whose organization does not resolve is a 404 with no
   * authorize and no write, never a 500 on a dangling write.
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

  /** The acting tenant's alert-config rows, event-type key ascending for a stable screen order. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdminSecurityAlertRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(adminSecurityAlerts)
      .where(eq(adminSecurityAlerts.organizationId, context.organizationId))
      .orderBy(adminSecurityAlerts.eventTypeKey);
  }

  /**
   * Upsert the acting tenant's config for one event-type key: a first PUT inserts, a repeated PUT
   * flips `enabled` in place. `id`, `organization_id`, `event_type_key`, `created_by` and `created_at`
   * are never changed on the update path — the 0196 trigger holds identity immutable at the engine.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly eventTypeKey: string;
      readonly enabled: boolean;
      readonly createdBy: string;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(adminSecurityAlerts)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        eventTypeKey: input.eventTypeKey,
        enabled: input.enabled,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { enabled: input.enabled } });
  }

  /** Remove the acting tenant's config for one event-type key. Idempotent: removing an absent key is a no-op. */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    eventTypeKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(adminSecurityAlerts)
      .where(
        and(
          eq(adminSecurityAlerts.organizationId, context.organizationId),
          eq(adminSecurityAlerts.eventTypeKey, eventTypeKey),
        ),
      );
  }

  /**
   * The acting tenant's recent `audit_events` whose `action` is one of the enabled alert keys, newest
   * first, bounded by `limit`. Read-only — no write path touches `audit_events` here. Scoped by
   * `organization_id`, so a cross-tenant context never sees another org's events; an empty key list
   * short-circuits to no rows (an unbounded `IN ()` is neither built nor sent).
   */
  async findRecentMatches(
    runner: TenantQueryRunner,
    context: TenantContext,
    enabledKeys: readonly string[],
    limit: number,
  ): Promise<readonly RecentSecurityMatch[]> {
    if (enabledKeys.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        id: auditEvents.id,
        eventTypeKey: auditEvents.action,
        result: auditEvents.result,
        actorUserId: auditEvents.actorUserId,
        objectType: auditEvents.objectType,
        objectId: auditEvents.objectId,
        occurredAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          inArray(auditEvents.action, [...enabledKeys]),
          NOT_NO_SCANNER_ROW,
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows;
  }
}
