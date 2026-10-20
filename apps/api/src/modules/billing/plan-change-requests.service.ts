import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingPlanChangeRequestRow } from '../../common/database/schema.js';
import { PlanChangeRequestsRepository } from './plan-change-requests.repository.js';
import type { PlanId } from './plan-catalog.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Billing & entitlements (module 19, x284). The plan-change-requests service — the business layer over
 * the org-scoped plan-change requests. It follows the `usage-alerts` service posture: it holds the
 * {@link TenantDatabase} and the repository, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free
 * of the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` (owner-only) — no billing
 * capability exists and this slice adds none (the `usage-alerts` divergence). The route guard asks the
 * coarse ceiling question; this service adds the authoritative application decision (`25-AUTH` §3 step
 * 2, deny-by-default): an org-scoped `authorize()` (`projectId: null`) that a suspended membership
 * fails.
 *
 * ## The Known-trap order
 *
 * The tenant comes from the context the guard resolved, never the body. On the cancel path the request
 * is resolved tenant-scoped **before** authorize/write: a cross-tenant or missing id is a 404, never a
 * foreign-key surprise. Validation (off-catalog plan, past effective date) is the controller's, done
 * before this service is called; nothing here writes on an invalid input. One pending request per
 * organization is enforced inside the create transaction (a second is a 409), and by the engine's
 * `pending_guard` UNIQUE key besides (a trigger-maintained column, kept by
 * `trg_billing_plan_change_requests_pending_guard`).
 *
 * ## What it does, and what it cannot
 *
 * A request is a recorded intent only. Nothing here charges, calls a payment provider, or changes an
 * entitlement — all Needs-Peter infrastructure, out of this slice. A later payment slice acts on a
 * pending request.
 */

/** What a caller is allowed to see of one plan-change request. `organizationId` is deliberately absent. */
export interface PlanChangeRequestView {
  readonly id: string;
  readonly targetPlanCode: string;
  /** An ISO-8601 calendar date (`YYYY-MM-DD`). */
  readonly effectiveOn: string;
  readonly note: string | null;
  readonly status: string;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the service's create accepts. `targetPlanCode`/`effectiveOn` are validated by the caller. */
export interface CreatePlanChangeRequestParams {
  readonly targetPlanCode: PlanId;
  readonly effectiveOn: string;
  readonly note: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingPlanChangeRequestRow): PlanChangeRequestView {
  return {
    id: row.id,
    targetPlanCode: row.targetPlanCode,
    effectiveOn: row.effectiveOn,
    note: row.note,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PlanChangeRequestsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: PlanChangeRequestsRepository = new PlanChangeRequestsRepository(),
    /**
     * ADM-11 (CQ-08). Optional so a unit test can construct the service without the audit wiring,
     * the `CustomRolesController` posture. When present, a submission and a real cancellation each
     * leave an audit row inside the same transaction as the write they describe (§3 step 8).
     */
    private readonly audit?: AuditService,
  ) {}

  /** List the acting tenant's plan-change requests, newest-first, for an org admin. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly PlanChangeRequestView[]> {
    this.requireOrgManage(principal, context, 'plan_change_request.list');
    const rows = await this.database.read(context, (runner) => this.requests.list(runner, context));
    return rows.map(toView);
  }

  /**
   * Create a plan-change request. `org.manage` org-scoped (a 403 for a caller without it). The caller
   * has already validated `targetPlanCode` and `effectiveOn`; nothing is written on an invalid input.
   * At most one pending request per organization: a second while one is pending is a 409, with no
   * write (the read and the insert share one transaction).
   */
  async create(
    context: TenantContext,
    principal: Principal,
    params: CreatePlanChangeRequestParams,
  ): Promise<PlanChangeRequestView> {
    this.requireOrgManage(principal, context, 'plan_change_request.create');
    const row = await this.database.transaction(context, async (tx) => {
      const pending = await this.requests.findPending(tx, context);
      if (pending) {
        throw new ApiError(
          409,
          'conflict',
          'This organization already has a pending plan-change request. Cancel it first.',
          undefined,
          'plan_change_request_already_pending',
        );
      }
      const created = await this.requests.create(tx, context, {
        ...params,
        createdBy: context.userId,
      });
      // ADM-11: a plan change is an owner-only organization decision the audit log must carry.
      // The target plan and the date are tokens; the free-text note is prose and is never recorded.
      await this.audit?.record(tx, context, {
        action: 'plan_change_request.submitted',
        objectId: created.id,
        result: 'allowed',
        metadata: { target_plan_code: created.targetPlanCode, effective_on: created.effectiveOn },
      });
      return created;
    });
    return toView(row);
  }

  /**
   * Cancel a plan-change request. The request is resolved tenant-scoped **before** the authorize/write:
   * a cross-tenant or missing id is a 404. `org.manage` org-scoped besides. Idempotent: cancelling an
   * already-cancelled request is a no-op that returns the row unchanged.
   */
  async cancel(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<PlanChangeRequestView> {
    const existing = await this.database.read(context, (runner) =>
      this.requests.findById(runner, context, id),
    );
    if (!existing) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'plan_change_request_not_visible',
      );
    }
    this.requireOrgManage(principal, context, 'plan_change_request.cancel');
    const row = await this.database.transaction(context, async (tx) => {
      const cancelled = await this.requests.cancel(tx, context, id);
      // ADM-11: record only a real cancellation — a pending request actually withdrawn. Re-cancelling
      // an already-cancelled request writes nothing (the repository is idempotent), so the count of
      // these rows is the count of actual withdrawals, not of calls to the route.
      if (existing.status === 'pending') {
        await this.audit?.record(tx, context, {
          action: 'plan_change_request.cancelled',
          objectId: id,
          result: 'allowed',
          metadata: { target_plan_code: existing.targetPlanCode },
        });
      }
      return cancelled;
    });
    return toView(row);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
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
        `${action}:${verdict.code}`,
      );
    }
  }
}
