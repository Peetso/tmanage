import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { AuditRetentionRepository } from './audit-retention.repository.js';

/**
 * Audit-log retention policy (Administration module 18, x279) — the logic half: validate the requested
 * window, enforce `org.manage` and tenant scope before any write, upsert the one-row-per-organization
 * policy, and build the read view (the stored policy plus a read-only purge-preview count of the
 * existing `audit_events` older than the window).
 *
 * ## Preview, not purge
 *
 * This slice **stores** a retention window and **previews** how many audit rows fall outside it. It
 * never writes to `audit_events` — that table is append-only, and the runtime credential holds no
 * DELETE on it. The actual purge is a later, separately-credentialed procedure; the screen says so.
 *
 * ## The window is bounded before any write
 *
 * {@link parse} accepts only an integer `retentionDays` in 1..3650 (ten years). Zero, a negative, a
 * non-integer, a value over the ceiling, or a missing field is a 400 and nothing is stored — the
 * refusal the controller test proves. The bound is the application's; the column is unsigned besides.
 *
 * ## Tenant scope before compute (the Known trap)
 *
 * The organization is resolved tenant-scoped first (a cross-tenant context is a 404 before authorize
 * and before any write), then the caller's own `org.manage` is authorized with the real evaluator
 * (403), and only then is the policy upserted or read. Every query carries the tenant predicate, so a
 * policy is never read, overwritten, or previewed across a tenant boundary, and the view never echoes
 * an organization id.
 */

/** The upper bound on a retention window: ten years, in whole days. */
export const MAX_RETENTION_DAYS = 3650;

/** The validated PUT body — an integer number of days in 1..3650. */
export interface RetentionPolicyInput {
  readonly retentionDays: number;
}

/**
 * The read view: the stored window (null if never set), when it was last set, and a read-only count of
 * audit rows that fall outside the window. Never carries the tenant id or the actor's user id — the
 * wire projection is the policy and the preview only.
 */
export interface AuditRetentionView {
  /** The stored retention window in days, or null if the organization has never set one. */
  readonly retentionDays: number | null;
  /** When the policy was last set (ISO 8601), or null if never set. */
  readonly updatedAt: string | null;
  /** How many `audit_events` are older than `now - retentionDays`. 0 when no window is set. */
  readonly eventsOlderThanWindow: number;
}

export class AuditRetentionService {
  constructor(private readonly reads: AuditRetentionRepository = new AuditRetentionRepository()) {}

  /**
   * Validate the body into a typed input, or throw a 400. `retentionDays` must be an integer in
   * 1..3650; anything else — zero, negative, fractional, over the ceiling, missing, or the wrong type —
   * is a bad request, and nothing is written.
   */
  parse(body: unknown): RetentionPolicyInput {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw this.badRequest('body', 'A retention policy body is required.');
    }
    const value = (body as Record<string, unknown>)['retentionDays'];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw this.badRequest('retentionDays', 'retentionDays must be a whole number of days.');
    }
    if (value < 1 || value > MAX_RETENTION_DAYS) {
      throw this.badRequest(
        'retentionDays',
        `retentionDays must be between 1 and ${MAX_RETENTION_DAYS}.`,
      );
    }
    return { retentionDays: value };
  }

  /**
   * Set the policy (the write path). Ordering is the Known trap's: resolve the organization
   * tenant-scoped (404), authorize the caller's `org.manage` (403), then upsert. Returns the fresh view
   * read inside the same transaction. The body is validated by {@link parse} before this is reached, so
   * an out-of-range value never gets here.
   */
  async set(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    input: RetentionPolicyInput,
  ): Promise<AuditRetentionView> {
    await this.requireOrganization(runner, context);
    this.requireOrgManage(principal, context);
    await this.reads.upsert(runner, context, {
      retentionDays: input.retentionDays,
      updatedBy: principal.userId,
    });
    return this.buildView(runner, context);
  }

  /**
   * Read the policy and the purge preview (200). Same ordering: resolve tenant-scoped (404), authorize
   * `org.manage` (403), then read the policy and count the rows outside the window.
   */
  async get(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
  ): Promise<AuditRetentionView> {
    await this.requireOrganization(runner, context);
    this.requireOrgManage(principal, context);
    return this.buildView(runner, context);
  }

  /** The policy plus the preview count. When no window is set, there is nothing to preview — count 0. */
  private async buildView(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AuditRetentionView> {
    const policy = await this.reads.find(runner, context);
    if (!policy) {
      return { retentionDays: null, updatedAt: null, eventsOlderThanWindow: 0 };
    }
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
    const eventsOlderThanWindow = await this.reads.countEventsOlderThan(runner, context, cutoff);
    return {
      retentionDays: policy.retentionDays,
      updatedAt: policy.updatedAt.toISOString(),
      eventsOlderThanWindow,
    };
  }

  /**
   * Resolve the acting organization tenant-scoped, BEFORE authorize/write (Known trap): a context whose
   * organization is not in this tenant is a 404, never a dangling upsert or a cross-tenant read.
   */
  private async requireOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<void> {
    const org = await this.reads.resolveOrganization(runner, context);
    if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /**
   * The caller's real `org.manage` decision — org-wide, so `projectId: null` and an internal audience,
   * the same shape x176 uses for the same capability. An internal role holding `org.manage` passes; a
   * client is refused (`org.manage` is internal-only), and a cross-tenant principal by the tenant check
   * inside `authorize`. A denial is a 403 with the machine-readable cause on the audit code only.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
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
        `admin_audit_retention.write:${verdict.code}`,
      );
    }
  }

  private badRequest(field: string, message: string): ApiError {
    return new ApiError(400, 'validation_failed', message, [{ field, message }]);
  }
}
