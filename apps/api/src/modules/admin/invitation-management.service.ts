import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { InvitationManagementRepository } from './invitation-management.repository.js';
import type { AdminInvitationsView } from './invitation-management.controller.js';

/**
 * Admin pending-invitation management (Administration module 18, x328) — the policy half.
 *
 * Two operations over the existing `invitations` table, both behind `org.manage`: list the tenant's
 * pending invitations, and revoke one. No migration, no new table, no new capability — a read and a
 * single terminal state transition on rows that already exist.
 *
 * ## The order that makes it safe
 *
 * The **revoke** resolves the invitation by `(tenant, id)` BEFORE it authorizes (the Known trap): an id
 * that is not in this tenant is a 404 with no write, indistinguishable from "no such invitation", so a
 * cross-tenant probe learns nothing. Only then is the caller's own `org.manage` authorized with the real
 * evaluator (a 403), and only then is the status transition decided. The route decorator is the coarse
 * HTTP gate the `CapabilityGuard` reads; the `authorize` here is the tenant-checked decision a controller
 * test exercises directly.
 *
 * ## The revoke is idempotent, and never re-arms a consumed invitation
 *
 * `pending → revoked` is the only move that writes. Revoking an **already-revoked** invitation is the
 * same end state, so it is a 204 with no second write (idempotent). An **accepted** invitation has
 * produced a membership and an **expired** one timed out; neither is `pending`, so revoking either is a
 * 409 with no write — a terminal invitation is never dragged back through `revoked`, which would lose the
 * fact that it was accepted or that it lapsed.
 */
export class InvitationManagementService {
  constructor(
    private readonly repository: InvitationManagementRepository = new InvitationManagementRepository(),
  ) {}

  /**
   * List the acting tenant's pending invitations (200). The organization is resolved tenant-scoped, then
   * the caller's `org.manage` is authorized (403); the list is metadata only — the token hash is never
   * returned. A pending invitation whose expiry has passed is still listed, flagged `isExpired`, rather
   * than hidden.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    now: Date,
  ): Promise<AdminInvitationsView> {
    this.requireOrgManage(principal, context);

    const rows = await this.repository.listPending(runner, context);
    return {
      invitations: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        invitedByUserId: row.invitedByUserId,
        invitedByName: row.invitedByName,
        invitedByEmail: row.invitedByEmail,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt,
        isExpired: row.expiresAt.getTime() <= now.getTime(),
      })),
    };
  }

  /**
   * Revoke one pending invitation. Resolves by `(tenant, id)` first (404, the Known trap), then
   * authorizes `org.manage` (403), then transitions: pending → revoked (a write), already-revoked →
   * idempotent no-op, accepted or expired → 409 with no write. Returns nothing — the route answers 204.
   */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    invitationId: string,
  ): Promise<void> {
    // 1. Resolve by (tenant, id) BEFORE authorize (Known trap): a cross-tenant id is a 404, no write.
    const current = await this.repository.findStatus(runner, context, invitationId);
    if (!current) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    // 2. The real org-wide `org.manage` decision (the decorator is the coarse gate; this is the tested
    //    decision). A denial is a 403.
    this.requireOrgManage(principal, context);

    // 3. Terminal states that are not `revoked` cannot be revoked — a 409 with no write. A consumed or
    //    lapsed invitation is never re-armed through the revoked state.
    if (current.status === 'accepted' || current.status === 'expired') {
      throw new ApiError(
        409,
        'conflict',
        `This invitation is ${current.status} and can no longer be revoked.`,
        undefined,
        `invitation_management.revoke:${current.status}`,
      );
    }

    // 4. Already revoked → idempotent no-op (204, no second write).
    if (current.status === 'revoked') return;

    // 5. Pending → revoked. The predicate makes the write happen exactly once; a lost race (the row left
    //    `pending` between the read and the write) affects zero rows and is treated as idempotent.
    await this.repository.revokePending(runner, context, invitationId);
  }

  /**
   * The caller's real `org.manage` decision — org-wide, so `projectId: null` and an internal audience,
   * the shape the sibling administration reads use for the same capability. An internal role holding
   * `org.manage` passes; a client is refused (`org.manage` is internal-only), and a cross-tenant
   * principal by the tenant check inside `authorize`. A denial is a 403 with the cause on the audit code.
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
        `invitation_management.manage:${verdict.code}`,
      );
    }
  }
}
