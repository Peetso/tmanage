import { authorize, hasCapability, INTERNAL_ROLES } from '@tmanage/domain';
import type { InternalRole, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow } from '../../common/database/schema.js';
import { MembershipsRepository } from './memberships.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Member offboarding — ADM-12 (access-impact preview) and ADM-13 (execution). SEC:Administration.
 *
 * The `member.offboard` capability existed in `CAPABILITIES` since the role/capability grid
 * landed, but no route used it: offboarding an internal member was the one Administration write
 * boundary with a name and no door. This service is the door, and it is written as the security
 * substance it is — access revocation — rather than as a status flip with an audit line.
 *
 * ## Three properties carry the weight
 *
 * 1. **Resolve tenant-scoped before any write (the Known trap).** Both entry points name a
 *    membership by id. The membership is resolved with the tenant-scoped `findById` first, so an
 *    unknown or cross-tenant id is a 404 with no write — never a 500 from a composite foreign key
 *    a write would otherwise drive it into (the order `MeetingsService.create` re-learned after
 *    `75e2913`). The capability check that precedes it is org-level and categorical — it needs no
 *    object — so running it first is the cheap check §3 puts before object lookup, not a relation
 *    decision that would need the row.
 *
 * 2. **The guards are refusals with no write.** Offboarding is irreversible
 *    (`OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`; `offboarded` is terminal in the repository's
 *    `ALLOWED_TRANSITIONS`), so the three ways it can be a mistake are refused before the
 *    transition, each leaving no row and no audit: a caller offboarding themselves, offboarding
 *    the last member who can still administer the organization, and re-offboarding a member who
 *    is already terminal.
 *
 * 3. **The audit row and the transition commit together, or neither does.** The status change and
 *    `membership.offboarded` are written in one transaction (`25-AUTH-AND-TENANT-ISOLATION` §3
 *    step 8), so there is never a record of a revocation that did not happen, nor a revocation
 *    with no record. A refused or idempotent path writes neither — the count of audit rows is the
 *    count of actual revocations.
 */

/**
 * The access and work a member holds, as ADM-12 previews it before the decision. An explicit
 * projection (`25-AUTH-AND-TENANT-ISOLATION` §7); `organizationId` is deliberately absent.
 */
export interface MemberOffboardingImpactView {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  /** How many projects this member belongs to — the access offboarding would revoke. */
  readonly projectMembershipCount: number;
  /** How many live work items this member owns — the work that would be left without an owner. */
  readonly ownedWorkItemCount: number;
  /** False once the member is already terminal: offboarding again is refused. */
  readonly offboardable: boolean;
}

/** The confirmation ADM-13 returns after an offboard. `organizationId` is deliberately absent. */
export interface OffboardedMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
}

/** The internal roles whose ceiling includes `org.manage` — computed, never hard-coded to `owner`. */
const ORG_MANAGE_ROLES: readonly InternalRole[] = INTERNAL_ROLES.filter((role) =>
  hasCapability(role, 'org.manage'),
);

function toImpactView(row: MembershipRow, counts: {
  readonly projectMembershipCount: number;
  readonly ownedWorkItemCount: number;
}): MemberOffboardingImpactView {
  return {
    membershipId: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    projectMembershipCount: counts.projectMembershipCount,
    ownedWorkItemCount: counts.ownedWorkItemCount,
    offboardable: row.status !== 'offboarded',
  };
}

function toOffboardedView(row: MembershipRow): OffboardedMemberView {
  return { membershipId: row.id, userId: row.userId, role: row.role, status: row.status };
}

export class OffboardingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService,
    /**
     * Read-only, and used only for the impact preview's counts. Stateless like the others, so it
     * is constructed here rather than injected (the reasoning `MeetingsService` records for the
     * repositories it owns a second handle on).
     */
    private readonly projectMemberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
  ) {}

  /**
   * The categorical capability decision, run before any object lookup.
   *
   * `member.offboard` against an org-level resource: it depends on the role ceiling and the
   * active membership, not on the membership being acted on, so `authorize()` answers it without
   * the row. A caller the route guard did not already refuse — or a direct caller in a unit test
   * — is denied here with a 403 carrying the specific `DenialCode` for the audit trail while the
   * response stays the coarse `forbidden`.
   */
  private assertMayOffboard(context: TenantContext, principal: Principal): void {
    const decision = authorize({
      principal,
      capability: 'member.offboard',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, decision.code);
    }
  }

  /** Resolve the named membership inside the acting tenant, or throw the not-found a stranger throws. */
  private async resolve(context: TenantContext, membershipId: string): Promise<MembershipRow> {
    const membership = await this.database.read(context, (db) =>
      this.memberships.findById(db, context, membershipId),
    );
    if (!membership) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'membership_not_visible');
    }
    return membership;
  }

  /**
   * ADM-12 — the access-impact preview. Read-only, never mutates.
   *
   * The membership is resolved tenant-scoped first (an unknown or cross-tenant id is 404), then
   * the access and work it holds are counted over existing tables. No new table: impact is a read.
   */
  async impact(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
  ): Promise<MemberOffboardingImpactView> {
    this.assertMayOffboard(context, principal);
    const membership = await this.resolve(context, membershipId);

    const counts = await this.database.read(context, async (db) => ({
      projectMembershipCount: await this.projectMemberships.countByUser(
        db,
        context,
        membership.userId,
      ),
      ownedWorkItemCount: await this.workItems.countOwnedByUser(db, context, membership.userId),
    }));

    return toImpactView(membership, counts);
  }

  /**
   * ADM-13 — offboard a member, revoking access irreversibly.
   *
   * The membership is resolved tenant-scoped before any write (the Known trap); the three guards
   * refuse with no write and no audit; the transition and the audit row commit in one transaction.
   */
  async offboard(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
  ): Promise<OffboardedMemberView> {
    this.assertMayOffboard(context, principal);
    const membership = await this.resolve(context, membershipId);

    // Guard 1 — a caller may not offboard themselves. Compared by membership id, which is the row
    // that authorised this very context: revoking one's own access mid-request is never a decision
    // to take by accident, and there is always someone else who can take it.
    if (membership.id === context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_self');
    }

    // Guard 2 — re-offboarding a terminal member. `offboarded` has no outbound transition, so this
    // is refused before the write rather than left to the repository's transition error: no second
    // row, no second audit event, and a caller retrying a completed offboard gets a clean conflict
    // rather than a 500. The count of audit rows stays the count of actual revocations.
    if (membership.status === 'offboarded') {
      throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'already_offboarded');
    }

    // Guard 3 — the last member who can still administer the organization. Offboarding the final
    // `org.manage` holder would leave the tenant with no one able to manage it, and offboarding is
    // irreversible, so it is refused. The roles are computed from the capability, not hard-coded,
    // and the count excludes this membership so it reads as "is there anyone else".
    if ((ORG_MANAGE_ROLES as readonly string[]).includes(membership.role)) {
      const otherAdmins = await this.database.read(context, (db) =>
        this.memberships.countActiveHoldersOfRoles(db, context, ORG_MANAGE_ROLES, membership.id),
      );
      if (otherAdmins === 0) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_last_owner');
      }
    }

    const updated = await this.database.transaction(context, async (tx) => {
      const row = await this.memberships.transitionStatus(
        tx,
        context,
        membership.id,
        membership.version,
        'offboarded',
      );
      await this.audit.record(tx, context, {
        action: 'membership.offboarded',
        result: 'allowed',
        objectId: row.id,
        metadata: {
          membership_id: row.id,
          target_user_id: row.userId,
          previous_status: membership.status,
        },
      });
      return row;
    });

    return toOffboardedView(updated);
  }
}
