import { Body, Controller, Get, Inject, Optional, Param, Patch } from '@nestjs/common';
import {
  capabilitiesFor,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  isInternalRole,
  PROJECT_ROLES,
} from '@tmanage/domain';
import type { Capability, InternalRole, Principal, Role } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MembershipsRepository, MembershipVersionConflictError } from './memberships.repository.js';

/**
 * ADM-01 — a member's built-in role, chosen on invite and changed later (audit gap 5).
 *
 * Inviting with any internal role, Manager included, is `InvitationsController`'s job and already
 * accepts every `INTERNAL_ROLES` value. What was missing is the other two halves:
 *
 * 1. `GET admin/roles/built-in` — every built-in role with the capabilities it grants, so the
 *    invite dialog and the People screen can offer a choice with its consequences in view. Each
 *    entry says whether **this caller** may hand it out: only an owner may grant `owner`.
 * 2. `PATCH members/:userId/role` — change one member's role. Addressed by user id, like
 *    offboarding, because the member directory projects `userId` and never `membershipId`.
 *
 * ## Who may change a role
 *
 * `org.manage` is the coarse gate, and the handler narrows it to the two roles the matrix names for
 * role assignment: `owner` and `org_admin`. Only an owner may touch an owner's seat or grant
 * `owner` (the CQ-06 rule the bulk route also keeps), and the organization's **last active owner**
 * cannot be demoted — an organization nobody owns cannot be recovered from inside. Every landed
 * change writes `membership.role_changed` in the same transaction, and `changeRole` bumps
 * `policy_version`, so a context minted under the old role is rotated on the next request.
 */

export interface BuiltInRoleView {
  readonly role: Role;
  readonly kind: 'internal' | 'client';
  readonly capabilities: readonly Capability[];
  /** Also offered on a project team (`PROJECT_ROLES`). */
  readonly projectRole: boolean;
  /** Whether the caller may invite someone with, or change someone to, this role. */
  readonly assignable: boolean;
}

export interface MemberRoleChangeView {
  readonly userId: string;
  readonly membershipId: string;
  readonly previousRole: string;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly changed: boolean;
}

interface ChangeRoleBody {
  readonly role?: unknown;
  readonly version?: unknown;
}

/** The roles that may assign roles at all (`12-PERMISSION-MATRIX` §2 "Assign roles"). */
const ROLE_ASSIGNERS: readonly string[] = ['owner', 'org_admin'];

function isOwner(principal: Principal): boolean {
  return principal.kind === 'internal' && principal.role === 'owner';
}

function requireRoleAssigner(principal: Principal): void {
  if (principal.kind !== 'internal' || !ROLE_ASSIGNERS.includes(principal.role)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'member_role.assigner');
  }
}

/** Every built-in role with its capability ceiling, internal roles first (most-privileged first). */
export function builtInRoles(principal: Principal): readonly BuiltInRoleView[] {
  const assigner = principal.kind === 'internal' && ROLE_ASSIGNERS.includes(principal.role);
  const internal = INTERNAL_ROLES.map((role) => ({
    role,
    kind: 'internal' as const,
    capabilities: capabilitiesFor(role),
    projectRole: (PROJECT_ROLES as readonly string[]).includes(role),
    assignable: assigner && (role !== 'owner' || isOwner(principal)),
  }));
  const client = CLIENT_ROLES.map((role) => ({
    role,
    kind: 'client' as const,
    capabilities: capabilitiesFor(role),
    projectRole: false,
    assignable: assigner,
  }));
  return [...internal, ...client];
}

@Controller('v1/organizations/:orgSlug/admin/roles/built-in')
export class BuiltInRolesController {
  @Get()
  @RequireCapability('org.manage')
  list(@CurrentPrincipal() principal: Principal): { readonly roles: readonly BuiltInRoleView[] } {
    return { roles: builtInRoles(principal) };
  }
}

@Controller('v1/organizations/:orgSlug/members')
export class MemberRoleController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  /**
   * Change one member's built-in role (200). Order: validate the body (400), narrow to an owner or
   * organization admin (403), resolve the member tenant-scoped (404 — a foreign user id is
   * indistinguishable from an unknown one), refuse an offboarded member (409), keep the owner seat
   * owner-only (403) and the last owner in place (409), then the compare-and-swap write and its
   * audit row in one transaction.
   */
  @Patch(':userId/role')
  @RequireCapability('org.manage')
  async change(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Body() body: ChangeRoleBody,
  ): Promise<MemberRoleChangeView> {
    const role = typeof body?.role === 'string' ? body.role.trim() : '';
    if (!isInternalRole(role)) {
      throw new ApiError(400, 'validation_failed', 'Choose a role.', [
        { field: 'role', message: 'must be one of the built-in staff roles' },
      ]);
    }
    const version = body?.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'version', message: 'must be a positive integer' },
      ]);
    }
    requireRoleAssigner(principal);

    return this.database.transaction(context, async (tx) => {
      const current = await this.memberships.findByUserId(tx, context, userId);
      if (!current) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      if (current.status === 'offboarded') {
        throw new ApiError(409, 'conflict', 'This person has left the organization.');
      }
      if (version !== undefined && version !== current.version) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict);
      }
      const previousRole = current.role;
      const view = (row: typeof current, changed: boolean): MemberRoleChangeView => ({
        userId: row.userId,
        membershipId: row.id,
        previousRole,
        role: row.role,
        status: row.status,
        version: row.version,
        changed,
      });
      if (current.role === role) return view(current, false);

      if ((current.role === 'owner' || role === 'owner') && !isOwner(principal)) {
        throw new ApiError(
          403,
          'forbidden',
          'Only an owner can change who owns the organization.',
          [{ field: 'role', message: 'Choose a role other than Owner.' }],
          'member_role.owner_seat',
        );
      }
      if (current.role === 'owner' && current.status === 'active') {
        const otherOwners = await this.memberships.countActiveHoldersOfRoles(
          tx,
          context,
          ['owner'],
          current.id,
        );
        if (otherOwners === 0) {
          throw new ApiError(
            409,
            'conflict',
            'Make someone else an owner before changing the last owner’s role.',
          );
        }
      }

      let updated: typeof current;
      try {
        updated = await this.memberships.changeRole(
          tx,
          context,
          current.id,
          current.version,
          role as InternalRole,
        );
      } catch (error) {
        if (error instanceof MembershipVersionConflictError) {
          throw new ApiError(409, 'conflict', MESSAGES.conflict);
        }
        throw error;
      }

      await this.audit?.record(tx, context, {
        action: 'membership.role_changed',
        objectId: updated.id,
        result: 'allowed',
        metadata: { target_user_id: updated.userId, previous_role: previousRole, new_role: role },
      });
      return view(updated, true);
    });
  }
}
