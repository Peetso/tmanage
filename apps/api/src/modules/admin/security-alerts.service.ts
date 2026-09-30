import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminSecurityAlertsRepository } from './security-alerts.repository.js';

/**
 * The fixed allowlist of security event-type keys a tenant may configure an alert for. Each key is a
 * real, security-relevant `audit_events.action` value, so an enabled key matches genuine rows in the
 * read-side preview. `authentication_events` is deliberately excluded: it carries no
 * `organization_id`, so its rows could not be surfaced per organization without breaking tenant
 * isolation. A key outside this set is refused 400 with no write.
 */
export const SECURITY_ALERT_EVENT_KEYS: readonly string[] = Object.freeze([
  'membership.revoked',
  'membership.offboarded',
  'project_membership.revoked',
  'project_membership.role_changed',
  'client_membership.role_changed',
  'client_membership.status_changed',
  'invitation.revoked',
  'session_revoked',
  'mfa_factor_enrolled',
  'file_asset.scan_failed',
  'file_asset.rejected',
]);

const ALLOWED = new Set(SECURITY_ALERT_EVENT_KEYS);

/** How many recent matches the preview returns, per the bounded-read rule. */
export const RECENT_MATCH_LIMIT = 50;

/** One configured alert, as the screen reads it. */
export interface SecurityAlertConfig {
  readonly eventTypeKey: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** One recent matching audit event, projected to the wire (dates as ISO strings; no request content). */
export interface SecurityAlertMatch {
  readonly id: string;
  readonly eventTypeKey: string;
  readonly result: string;
  readonly actorUserId: string | null;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly occurredAt: string;
}

/** The GET projection: the allowlist, the tenant's config, and the read-only recent matches. */
export interface SecurityAlertsView {
  readonly allowedEventTypes: readonly string[];
  readonly configs: readonly SecurityAlertConfig[];
  readonly recentMatches: readonly SecurityAlertMatch[];
}

/**
 * Admin security-event alert configuration (Administration, security monitoring, x329) — the
 * capability- and tenant-checked logic between the controller and the repository. Every mutation
 * resolves the organization tenant-scoped BEFORE it authorizes `org.security.manage` and BEFORE any
 * write (the Known trap: a cross-tenant context is a 404, never a dangling write), validates the
 * `event_type_key` against {@link SECURITY_ALERT_EVENT_KEYS} (an off-allowlist key is a 400 with no
 * upsert), and only then writes. The read matches recent `audit_events` for the enabled keys
 * read-only, bounded by {@link RECENT_MATCH_LIMIT}.
 */
export class AdminSecurityAlertsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: AdminSecurityAlertsRepository = new AdminSecurityAlertsRepository(),
  ) {}

  /** Read the allowlist, the tenant's config, and the recent audit matches for the enabled keys. */
  async list(context: TenantContext, principal: Principal): Promise<SecurityAlertsView> {
    this.requireManage(principal, context);
    return this.database.read(context, async (runner) => {
      const rows = await this.repository.list(runner, context);
      const enabledKeys = rows.filter((r) => r.enabled).map((r) => r.eventTypeKey);
      const recentMatches = await this.repository.findRecentMatches(
        runner,
        context,
        enabledKeys,
        RECENT_MATCH_LIMIT,
      );
      return {
        allowedEventTypes: SECURITY_ALERT_EVENT_KEYS,
        configs: rows.map((r) => ({
          eventTypeKey: r.eventTypeKey,
          enabled: r.enabled,
          createdAt: r.createdAt.toISOString(),
        })),
        recentMatches: recentMatches.map((m) => ({
          id: m.id,
          eventTypeKey: m.eventTypeKey,
          result: m.result,
          actorUserId: m.actorUserId,
          objectType: m.objectType,
          objectId: m.objectId,
          occurredAt: m.occurredAt.toISOString(),
        })),
      };
    });
  }

  /**
   * Turn an alert on or off for one event-type key (idempotent upsert). Resolve tenant-scoped → real
   * `org.security.manage` authorize → allowlist validation → upsert; a cross-tenant context is a 404
   * before authorize, a caller without the capability a 403 before the write, an off-allowlist key a
   * 400 before the write.
   */
  async configure(
    context: TenantContext,
    principal: Principal,
    input: { eventTypeKey: unknown; enabled: unknown },
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const org = await this.repository.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      this.requireManage(principal, context);
      const eventTypeKey = this.requireAllowedKey(input.eventTypeKey);
      const enabled = this.requireBoolean(input.enabled, 'enabled');
      await this.repository.upsert(tx, context, {
        eventTypeKey,
        enabled,
        createdBy: principal.userId,
      });
    });
  }

  /**
   * Remove an event-type key's config (204, idempotent). Same order as {@link configure}: resolve
   * tenant-scoped → authorize → allowlist validation → delete.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    input: { eventTypeKey: unknown },
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const org = await this.repository.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      this.requireManage(principal, context);
      const eventTypeKey = this.requireAllowedKey(input.eventTypeKey);
      await this.repository.remove(tx, context, eventTypeKey);
    });
  }

  /** The real org-wide `org.security.manage` decision; a denial is a 403 with the machine-readable code. */
  private requireManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.security.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `admin_security_alerts.write:${verdict.code}`,
      );
    }
  }

  /** The event-type key must be a non-empty string on the fixed allowlist, or the write is refused 400. */
  private requireAllowedKey(value: unknown): string {
    if (typeof value !== 'string' || !ALLOWED.has(value)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'eventTypeKey', message: 'must be a known security event-type key' },
      ]);
    }
    return value;
  }

  /** A required boolean, or a 400 with no write. */
  private requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field, message: 'A true/false value is required.' },
      ]);
    }
    return value;
  }
}
