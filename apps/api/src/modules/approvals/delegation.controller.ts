import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApprovalDelegationService, ApprovalDelegationView } from './delegation.service.js';

/**
 * Approval delegation (x300) — an approver delegates their own approval authority to another member
 * for a window (create), lists their delegations (read), and revokes one (delete).
 *
 * ## Capability, and the delegator is never the caller's to name
 *
 * Create and revoke are `approval.decide`: the delegator delegates the authority *they* hold, so the
 * capability every reviewer role holds is the coarse gate (the source of a 403 for a caller without
 * it), exactly as the sibling `ApprovalsController` route-guards `approval.read`. List is
 * `approval.read`. The delegator is always the authenticated `principal`'s membership — never a body
 * field, a header, or the `:orgSlug` segment — so no caller can record, list, or revoke another
 * member's delegations. The real row-level facts (window ordering, self-delegation, the delegate
 * resolved active-and-in-tenant → 404) are the service's, decided with the rows in hand.
 */

/** The DI token for {@link ApprovalDelegationService}, wired on `ApprovalsModule` (ADR-0003). */
export const APPROVAL_DELEGATION_SERVICE = Symbol.for('tmanage.ApprovalDelegationService');

interface CreateDelegationBody {
  readonly delegateMembershipId?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  return value;
}

/** An ISO-8601 instant, parsed to a Date. A non-string or unparseable value is a 400. */
function requireInstant(value: unknown, field: string): Date {
  const raw = requireString(value, field);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be an ISO-8601 date-time' },
    ]);
  }
  return date;
}

@Controller('v1/organizations/:orgSlug/approvals/delegations')
export class ApprovalDelegationController {
  constructor(
    @Inject(APPROVAL_DELEGATION_SERVICE) private readonly delegations: ApprovalDelegationService,
  ) {}

  /** Delegate the caller's approval authority to another member for a window. */
  @Post()
  @HttpCode(201)
  @RequireCapability('approval.decide')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateDelegationBody,
  ): Promise<ApprovalDelegationView> {
    const delegateMembershipId = requireString(body.delegateMembershipId, 'delegateMembershipId');
    const startsAt = requireInstant(body.startsAt, 'startsAt');
    const endsAt = requireInstant(body.endsAt, 'endsAt');
    return this.delegations.create(context, principal, { delegateMembershipId, startsAt, endsAt });
  }

  /** List the caller's own delegations, newest first. */
  @Get()
  @RequireCapability('approval.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly delegations: readonly ApprovalDelegationView[] }> {
    return { delegations: await this.delegations.list(context, principal) };
  }

  /** Revoke one of the caller's delegations. Idempotent: an unknown id is still 204. */
  @Delete(':delegationId')
  @HttpCode(204)
  @RequireCapability('approval.decide')
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('delegationId') delegationId: string,
  ): Promise<void> {
    requireString(delegationId, 'delegationId');
    await this.delegations.revoke(context, principal, delegationId);
  }
}
