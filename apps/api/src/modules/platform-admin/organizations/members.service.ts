import { ASSIGNABLE_INTERNAL_ROLES, PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import type { InternalRole, Principal } from '@tmanage/domain';
import {
  createTenantContext,
  SERVICE_PRINCIPAL_ID,
} from '../../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { InvitationsRepository } from '../../tenancy/invitations.repository.js';
import { defaultOrgWideScope } from '../../tenancy/principal.repository.js';
import type { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import type { OffboardingService } from '../../tenancy/offboarding.service.js';
import { requireMayGrantRole } from '../../tenancy/role-grant-ceiling.js';
import { optionalReason, requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { PlatformOrganizationsRepository } from './organizations.repository.js';
import type { OrgRow } from './organizations.repository.js';
import type { PlatformOrganizationsService } from './organizations.service.js';

/**
 * Platform admin · Organizations · Members & roles (A6; SPEC §6). The operator changes roles with
 * the ceiling a live Support session has (`platform_support`: it may grant owner), adds an existing
 * TManage account as a member, offboards (reason required — destructive list) and revokes pending
 * invitations. Custom roles and per-member overrides are PA-04's pages, linked from the screen.
 *
 * The last active owner is never demoted here; ownership moves through the lifecycle transfer.
 */

export interface PlatformOrgMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly overrides: number;
}

export interface PlatformOrgMembersView {
  readonly internal: readonly PlatformOrgMemberView[];
  readonly clients: readonly {
    readonly membershipId: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: string;
    readonly status: string;
    readonly clientName: string | null;
  }[];
  readonly invitations: readonly {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly invitedByEmail: string | null;
  }[];
  readonly roles: readonly string[];
}

export interface PlatformOrgMemberWriteView {
  readonly member: PlatformOrgMemberView;
}

/** The principal the platform grants with: the Support-session ceiling, bound to one org. */
export function platformGrantPrincipal(organizationId: string): Principal {
  return {
    userId: SERVICE_PRINCIPAL_ID,
    organizationId,
    kind: 'internal',
    role: PLATFORM_SUPPORT_ROLE,
    membershipId: SERVICE_PRINCIPAL_ID,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function isAssignable(role: unknown): role is InternalRole {
  return (
    typeof role === 'string' && (ASSIGNABLE_INTERNAL_ROLES as readonly string[]).includes(role)
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PlatformOrganizationMembersService {
  constructor(
    private readonly organizations: PlatformOrganizationsService,
    private readonly orgs: PlatformOrganizationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly invitations: InvitationsRepository,
    private readonly offboarding: OffboardingService | null,
    private readonly audit: AuditService | null,
  ) {}

  async list(rawId: unknown, context: RequestContext): Promise<PlatformOrgMembersView> {
    const row = await this.organizations.require(rawId, context);
    const members = await this.orgs.members(row.id, context.correlationId);
    return {
      internal: members.internal.map((member) => ({
        membershipId: member.id,
        userId: member.userId,
        displayName: member.displayName,
        email: member.email,
        role: member.role,
        status: member.status,
        lastSignInAt: member.lastSignInAt ? member.lastSignInAt.toISOString() : null,
        mfaEnabled: member.mfaEnabled,
        overrides: member.overrides,
      })),
      clients: members.clients.map((member) => ({
        membershipId: member.id,
        displayName: member.displayName,
        email: member.email,
        role: member.role,
        status: member.status,
        clientName: member.clientName,
      })),
      invitations: members.invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
        invitedByEmail: invitation.invitedByEmail,
      })),
      roles: [...ASSIGNABLE_INTERNAL_ROLES],
    };
  }

  async changeRole(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawMembershipId: unknown,
    body: { readonly role?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgMemberWriteView> {
    const reason = optionalReason(body?.reason);
    const membershipId = requireId(rawMembershipId);
    const row = await this.organizations.require(rawId, context);
    const role = body?.role;
    if (!isAssignable(role)) {
      throw new ApiError(400, 'validation_failed', 'Choose a listed role.', [
        { field: 'role', message: 'unknown' },
      ]);
    }
    requireMayGrantRole(platformGrantPrincipal(row.id), role, row.id, 'platform.member_role');
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.member_role_changed', reason, { membershipId, role }),
      async (tx, tenant) => {
        const target = await this.memberships.findById(tx, tenant, membershipId);
        if (!target || target.role === PLATFORM_SUPPORT_ROLE || target.status === 'offboarded') {
          throw new ApiError(404, 'not_found', MESSAGES.notFound);
        }
        if (target.role === role)
          throw new ApiError(409, 'conflict', 'This person already has this role.');
        if (target.role === 'owner') {
          const others = await this.memberships.countActiveHoldersOfRoles(
            tx,
            tenant,
            ['owner'],
            target.id,
          );
          if (others === 0) {
            throw new ApiError(
              409,
              'conflict',
              'This is the only owner. Transfer ownership from the Lifecycle tab first.',
            );
          }
        }
        await this.memberships.changeRole(tx, tenant, target.id, target.version, role);
        await this.audit?.record(tx, tenant, {
          action: 'membership.role_changed',
          objectId: target.id,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: { target_user_id: target.userId, via: 'platform_admin' },
          changes: [{ field: 'role', before: target.role, after: role }],
        });
      },
    );
    return this.memberView(row.id, membershipId, context);
  }

  async add(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly email?: unknown; readonly role?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgMemberWriteView> {
    const reason = optionalReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) {
      throw new ApiError(400, 'validation_failed', 'Type an email address.', [
        { field: 'email', message: 'email' },
      ]);
    }
    const role = body?.role ?? 'member';
    if (!isAssignable(role)) {
      throw new ApiError(400, 'validation_failed', 'Choose a listed role.', [
        { field: 'role', message: 'unknown' },
      ]);
    }
    requireMayGrantRole(platformGrantPrincipal(row.id), role, row.id, 'platform.member_add');
    const user = await this.orgs.findUserByEmail(email, context.correlationId);
    if (!user) {
      throw new ApiError(
        404,
        'not_found',
        'No TManage account uses this address. Ask the person to sign up first.',
        [{ field: 'email', message: 'unknown' }],
      );
    }
    const membershipId = await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.member_added', reason, { userId: user.id, role }),
      async (tx, tenant) => {
        const existing = await this.memberships.findByUserId(tx, tenant, user.id);
        if (existing && existing.status !== 'offboarded') {
          throw new ApiError(409, 'conflict', 'This person is already a member.', [
            { field: 'email', message: 'member' },
          ]);
        }
        return PlatformOrganizationsRepository.addMember(
          tx,
          row.id,
          user.id,
          role,
          defaultOrgWideScope(role),
        );
      },
    );
    return this.memberView(row.id, membershipId, context);
  }

  async offboard(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawMembershipId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly offboardedMembershipId: string }> {
    const reason = requireReason(body?.reason);
    const membershipId = requireId(rawMembershipId);
    const row = await this.organizations.require(rawId, context);
    const members = await this.orgs.members(row.id, context.correlationId);
    const target = members.internal.find((member) => member.id === membershipId);
    if (!target) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    if (target.role === 'owner') {
      throw new ApiError(409, 'conflict', 'Owners cannot be offboarded. Transfer ownership first.');
    }
    if (!this.offboarding) throw new ApiError(500, 'internal_error', MESSAGES.notFound);
    // The offboarding service records `membership.offboarded` as the context's user: the
    // operator's own account, never the all-zero service principal (an FK to `users`).
    const tenant = createTenantContext({
      organizationId: row.id,
      userId: actor.account.userId,
      principalKind: 'service',
      membershipId: SERVICE_PRINCIPAL_ID,
      capabilities: [],
      policyVersion: 'platform-admin',
      correlationId: context.correlationId,
    });
    await this.offboarding.offboard(tenant, platformGrantPrincipal(row.id), target.userId);
    await this.orgs.recordAudit(
      audit(actor, context, row, 'platform.member_offboarded', reason, { membershipId }),
    );
    return { offboardedMembershipId: membershipId };
  }

  async revokeInvitation(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawInvitationId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly revokedInvitationId: string }> {
    const reason = optionalReason(body?.reason);
    const invitationId = requireId(rawInvitationId);
    const row = await this.organizations.require(rawId, context);
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.invitation_revoked', reason, { invitationId }),
      async (tx, tenant) => {
        const invitation = await this.invitations.findById(tx, tenant, invitationId);
        if (!invitation || invitation.status !== 'pending') {
          throw new ApiError(404, 'not_found', MESSAGES.notFound);
        }
        await this.invitations.revoke(tx, tenant, invitationId);
        await this.audit?.record(tx, tenant, {
          action: 'invitation.revoked',
          objectId: invitationId,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: { revocation: 'platform_admin' },
        });
      },
    );
    return { revokedInvitationId: invitationId };
  }

  private async memberView(
    organizationId: string,
    membershipId: string,
    context: RequestContext,
  ): Promise<PlatformOrgMemberWriteView> {
    const view = await this.list(organizationId, context);
    const member = view.internal.find((item) => item.membershipId === membershipId);
    if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { member };
  }
}

function audit(
  actor: PlatformAdminActor,
  context: RequestContext,
  row: OrgRow,
  action: string,
  reason: string | null,
  after: Record<string, unknown>,
) {
  return {
    ...platformAuditFor(actor, context, {
      action,
      targetType: 'organization' as const,
      targetId: row.id,
      targetLabel: row.name,
      organizationId: row.id,
      reason,
    }),
    afterJson: JSON.stringify(after),
  };
}
