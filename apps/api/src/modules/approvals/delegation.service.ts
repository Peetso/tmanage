import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ApprovalDelegationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApprovalDelegationRepository } from './delegation.repository.js';

/**
 * Approval delegation (x300) — an approver delegates their OWN approval authority to another member
 * for a time window, lists their active delegations, and revokes one. A per-delegator surface kept in
 * its own table `approval_delegations`, registered on the existing `ApprovalsModule`.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse capability question a guard can answer with no row loaded:
 * `approval.decide` to create or revoke (a member delegates the authority they themselves hold), and
 * `approval.read` to list. That is the same coarse-ceiling use the sibling `ApprovalsController`
 * makes of `approval.read`, and it is the source of the 403 a caller without the capability gets.
 *
 * This service adds the row-level facts the guard cannot see, and it never trusts the caller for the
 * *delegator*: the delegator is always `context.membershipId`, so a member records, lists and revokes
 * only their own delegations and the request has no way to name another. The *delegate* is resolved
 * **tenant-scoped before** anything is written (the Known-trap order): a delegate id that is missing,
 * that belongs to another tenant, or that is not an active membership is a **404** with nothing
 * written — never a foreign-key 500, and never a 403 that would confirm a membership the caller may
 * not see exists.
 *
 * This slice records only; it does not modify the decide guard. The decide path reads these rows
 * read-side in a follow-up.
 */

/**
 * One delegation on the wire — paired Exact with the web's `ApprovalDelegationSummary`. The delegator
 * is always the caller, so it is not echoed; `organizationId` is deliberately absent (the wire
 * projection never echoes the tenant id, `25-AUTH` §7). Dates are ISO-8601 strings, the shape
 * `JSON.stringify` emits.
 */
export interface ApprovalDelegationView {
  readonly id: string;
  readonly delegateMembershipId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly createdAt: string;
}

/** What creating a delegation supplies. The delegator and the tenant are not the caller's to name. */
export interface CreateDelegationInput {
  readonly delegateMembershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

function toView(row: ApprovalDelegationRow): ApprovalDelegationView {
  return {
    id: row.id,
    delegateMembershipId: row.delegateMembershipId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class ApprovalDelegationService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly delegations: ApprovalDelegationRepository = new ApprovalDelegationRepository(),
  ) {}

  /**
   * Delegate the caller's approval authority to another active member of the same tenant for a
   * window. `endsAt <= startsAt` is a 400 with nothing written; delegating to oneself is a 400; a
   * delegate that is missing, cross-tenant, or not active is a 404 resolved before the insert.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateDelegationInput,
  ): Promise<ApprovalDelegationView> {
    const delegatorMembershipId = principal.membershipId;

    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new ApiError(400, 'validation_failed', 'The delegation window is invalid', [
        { field: 'endsAt', message: 'must be after startsAt' },
      ]);
    }

    if (input.delegateMembershipId === delegatorMembershipId) {
      throw new ApiError(400, 'validation_failed', 'The delegation is invalid', [
        { field: 'delegateMembershipId', message: 'cannot delegate to yourself' },
      ]);
    }

    return this.database.transaction(context, async (tx) => {
      const delegate = await this.delegations.findMembership(
        tx,
        context,
        input.delegateMembershipId,
      );
      if (!delegate || delegate.status !== 'active') {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'delegate_not_an_active_member',
        );
      }

      const row = await this.delegations.insert(tx, context, {
        delegatorMembershipId,
        delegateMembershipId: input.delegateMembershipId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });
      return toView(row);
    });
  }

  /** List the caller's own delegations, newest first. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ApprovalDelegationView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.delegations.listForDelegator(runner, context, principal.membershipId),
    );
    return rows.map(toView);
  }

  /**
   * Revoke one of the caller's own delegations, idempotently. A missing id — including one that
   * belongs to another delegator or another tenant, neither of which matches the delegator-scoped
   * predicate — removes nothing and is still success.
   */
  async revoke(context: TenantContext, principal: Principal, id: string): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.delegations.remove(tx, context, id, principal.membershipId),
    );
  }
}
