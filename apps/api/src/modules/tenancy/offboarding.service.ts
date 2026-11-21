import {
  authorize,
  capabilitySetFor,
  hasCapability,
  INTERNAL_ROLES,
  mayActOnMember,
  memberAuthorityTier,
} from '@tmanage/domain';
import type { InternalRole, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { MembershipRow } from '../../common/database/schema.js';
import type { MembershipsRepository } from './memberships.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { InvitationsRepository } from './invitations.repository.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { capabilitiesOfStoredRole, exceedsCaller, isRoleAssigner } from './role-grant-ceiling.js';
import type { StorageHold, StorageHoldsHook } from '../storage-root/storage-holds.js';
import type { StorageProvider } from '../storage-root/storage-handover.repository.js';
import { actorTier, MEMBER_RANK_MESSAGE } from './member-authority.js';

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
 * 1. **Resolve tenant-scoped before any write (the Known trap).** Both entry points name a member
 *    by their user id. The membership is resolved with the tenant-scoped `findByUserId` first, so
 *    an unknown or cross-tenant id is a 404 with no write — never a 500 from a composite foreign
 *    key a write would otherwise drive it into (the order `MeetingsService.create` re-learned after
 *    `75e2913`). The capability check that precedes it is org-level and categorical — it needs no
 *    object — so running it first is the cheap check §3 puts before object lookup, not a relation
 *    decision that would need the row.
 *
 *    The routes are keyed by **user id**, not membership id, because the member directory (D16,
 *    `MembersController`) deliberately projects `userId` and never `membershipId` — the membership
 *    id is only its keyset cursor. A `membershipId`-keyed offboard route would be one the member
 *    picker that drives this feature could never call. `(organization_id, user_id)` is a unique
 *    key, so the resolution is exactly as tenant-scoped and single-valued as a by-id lookup.
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
  /**
   * 51-17. The company storage this member connected: hand it over before (or right after)
   * offboarding, or the files stop syncing when their account is removed.
   */
  readonly storageConnections: readonly StorageProvider[];
}

/** The confirmation ADM-13 returns after an offboard. `organizationId` is deliberately absent. */
export interface OffboardedMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  /**
   * 51-17. Company storage this member still holds. Nothing was disconnected; the workspace owners
   * were told to hand it over (inbox + e-mail).
   */
  readonly storageHandoverRequired: readonly StorageProvider[];
}

/** The internal roles whose ceiling includes `org.manage` — computed, never hard-coded to `owner`. */
const ORG_MANAGE_ROLES: readonly InternalRole[] = INTERNAL_ROLES.filter((role) =>
  hasCapability(role, 'org.manage'),
);

function toImpactView(
  row: MembershipRow,
  counts: {
    readonly projectMembershipCount: number;
    readonly ownedWorkItemCount: number;
  },
  holds: readonly StorageHold[],
): MemberOffboardingImpactView {
  return {
    membershipId: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    projectMembershipCount: counts.projectMembershipCount,
    ownedWorkItemCount: counts.ownedWorkItemCount,
    offboardable: row.status !== 'offboarded',
    storageConnections: holds.map((hold) => hold.provider),
  };
}

function toOffboardedView(row: MembershipRow, holds: readonly StorageHold[]): OffboardedMemberView {
  return {
    membershipId: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    storageHandoverRequired: holds.map((hold) => hold.provider),
  };
}

/** 60-04: the one write offboarding needs from the AI-employee table (same bounded context). */
export interface AiEmployeeSponsorHook {
  pauseForSponsor(
    runner: TenantQueryRunner,
    context: TenantContext,
    sponsorMembershipId: string,
    at: Date,
  ): Promise<number>;
}

export class OffboardingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService,
    /**
     * The impact preview counts a member's project memberships and owned work; the offboard
     * itself removes those memberships and clears that work (ADM-06, ADM-07). Both are read for
     * the preview and written inside the offboard transaction. Stateless like the others, so they
     * are constructed here rather than injected (the reasoning `MeetingsService` records for the
     * repositories it owns a second handle on).
     */
    private readonly projectMemberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    /** F06: the pending invitations the member issued are withdrawn with their access. */
    private readonly invitations: InvitationsRepository = new InvitationsRepository(),
    /** F23: resolves a custom role the target holds, for the authority ceiling. */
    private readonly customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
    /** 51-17. The company storage this member holds; null (tests) reads none. */
    private readonly storageHolds: StorageHoldsHook | null = null,
    /**
     * 60-04 (plan 60 v2 §4.5): pauses the AI employees this member sponsors (`sponsor_left`) in the
     * offboarding transaction. Null (tests) pauses none.
     */
    private readonly aiEmployees: AiEmployeeSponsorHook | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * F23 — nobody removes someone holding more authority than they do. An organization admin
   * is offboarded only by an owner or organization admin, and any other target must hold no
   * capability the caller lacks (the subset rule, custom roles included). Owners keep their own
   * guard (Guard 1b). 403 with no write.
   */
  private async assertTargetWithinCeiling(
    context: TenantContext,
    principal: Principal,
    membership: MembershipRow,
  ): Promise<void> {
    if (membership.role === 'owner') return;
    if (membership.role === 'org_admin' && !isRoleAssigner(principal)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_admin');
    }
    const target = await this.database.read(context, (db) =>
      capabilitiesOfStoredRole(db, context, membership.role, this.customRoles),
    );
    // QA-FIX-P S3: an admin-tier target (org.manage, built-in or custom) is removed only by
    // someone who outranks it — the owner. Member-tier targets keep the subset rule below.
    const tier = memberAuthorityTier(membership.role, target);
    if (tier !== 'member' && !mayActOnMember(actorTier(principal, context), tier)) {
      throw new ApiError(403, 'forbidden', MEMBER_RANK_MESSAGE, undefined, 'offboard:member_rank');
    }
    if (exceedsCaller(target, capabilitySetFor(principal.role))) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_ceiling');
    }
  }

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

  /** Resolve the named member's membership inside the acting tenant, or throw a stranger's not-found. */
  private async resolve(context: TenantContext, userId: string): Promise<MembershipRow> {
    const membership = await this.database.read(context, (db) =>
      this.memberships.findByUserId(db, context, userId),
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
    userId: string,
  ): Promise<MemberOffboardingImpactView> {
    this.assertMayOffboard(context, principal);
    const membership = await this.resolve(context, userId);
    await this.assertTargetWithinCeiling(context, principal, membership);

    const counts = await this.database.read(context, async (db) => ({
      projectMembershipCount: await this.projectMemberships.countByUser(
        db,
        context,
        membership.userId,
      ),
      ownedWorkItemCount: await this.workItems.countOwnedByUser(db, context, membership.userId),
      holds: (await this.storageHolds?.heldBy(db, context, membership.userId)) ?? [],
    }));

    return toImpactView(membership, counts, counts.holds);
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
    userId: string,
  ): Promise<OffboardedMemberView> {
    this.assertMayOffboard(context, principal);
    const membership = await this.resolve(context, userId);

    // Guard 1 — a caller may not offboard themselves. Compared by membership id, which is the row
    // that authorised this very context: revoking one's own access mid-request is never a decision
    // to take by accident, and there is always someone else who can take it.
    if (membership.id === context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_self');
    }

    // Guard 1a — 60-04: an AI employee leaves through its own lifecycle (Retire), which offboards
    // the membership and closes the companion row together; never through People.
    if (membership.kind !== 'human') {
      throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'offboard_ai_employee');
    }

    // Guard 1b — only an owner may offboard an owner (CQ-06). The organization admin holds
    // `member.offboard` and `org.manage`; without this an admin could remove every owner.
    if (
      membership.role === 'owner' &&
      !(principal.kind === 'internal' && principal.role === 'owner')
    ) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_owner');
    }
    await this.assertTargetWithinCeiling(context, principal, membership);

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

    // Guard 3b — ACCOUNT item 3 (live persona test 2026-11-15): the last owner. An organization
    // admin also holds `org.manage`, so Guard 3 alone let the last owner go while an admin
    // remained, and the organization was left with nobody who owns it (an admin cannot grant
    // `owner`). The same rule the role change keeps: someone else is made an owner first.
    if (membership.role === 'owner') {
      const otherOwners = await this.database.read(context, (db) =>
        this.memberships.countActiveHoldersOfRoles(db, context, ['owner'], membership.id),
      );
      if (otherOwners === 0) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'offboard_last_owner');
      }
    }

    const { updated, holds } = await this.database.transaction(context, async (tx) => {
      const row = await this.memberships.transitionStatus(
        tx,
        context,
        membership.id,
        membership.version,
        'offboarded',
      );

      // Revoke access and release work in the same unit of work as the status change
      // (ADM-06, ADM-07). Every project membership is a grant into a project the member can
      // reach, so offboarding removes them — a status flip that left the grants standing would
      // leave an offboarded person still on the project team, named by a raw id. Owned work is
      // set back to unassigned rather than left reading as "Former or hidden member" on a row
      // nobody can act on. Both commit with the transition, so there is never a half-revoked
      // member, and the counts are recorded on the one audit row.
      const projectMembershipsRemoved = await this.projectMemberships.removeAllForUser(
        tx,
        context,
        row.userId,
      );
      const ownedWorkItemsCleared = await this.workItems.clearOwnerForUser(tx, context, row.userId);
      // F06: invitations this member issued would otherwise let them, or whoever holds a link
      // they kept, rejoin with the authority being removed now.
      const invitationsRevoked = await this.invitations.revokePendingIssuedBy(
        tx,
        context,
        row.userId,
      );

      const aiEmployeesPaused =
        (await this.aiEmployees?.pauseForSponsor(tx, context, row.id, this.now())) ?? 0;

      await this.audit.record(tx, context, {
        action: 'membership.offboarded',
        result: 'allowed',
        objectId: row.id,
        metadata: {
          membership_id: row.id,
          target_user_id: row.userId,
          previous_status: membership.status,
          project_memberships_removed: projectMembershipsRemoved,
          owned_work_items_cleared: ownedWorkItemsCleared,
          invitations_revoked: invitationsRevoked,
          ai_employees_paused: aiEmployeesPaused,
        },
      });
      // 51-17: storage this member connected keeps working on their token; the owners are told
      // in the same unit of work, so a committed offboard always carries its warning.
      const held = (await this.storageHolds?.heldBy(tx, context, row.userId)) ?? [];
      await this.storageHolds?.announceLeft(tx, context, held, `${row.id}:${String(row.version)}`);
      return { updated: row, holds: held };
    });

    return toOffboardedView(updated, holds);
  }
}
