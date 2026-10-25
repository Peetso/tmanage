import { Body, Controller, Get, Inject, Optional, Param, Patch } from '@nestjs/common';
import {
  CAPABILITIES,
  capabilitiesFor,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  isInternalRole,
  mayGrantCapability,
  PROJECT_ROLES,
} from '@tmanage/domain';
import type { Capability, InternalRole, Principal, Role } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
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
 *
 * ## A custom role (F1, Figma 389:4749)
 *
 * The same route also gives one member a **custom role** from Control > Roles: the body carries
 * `customRoleId` instead of `role`. The role is resolved tenant-scoped first (a role in another
 * studio, or none, is a 404 with no write), and every capability it carries is re-checked against
 * the caller with `mayGrantCapability` — the escalation guard the bulk route and the roles editor
 * run — so nobody can hand out a role that grants more than they hold (403, no write). The stored
 * `memberships.role` is the custom role id, exactly as the bulk assign writes it, and the member's
 * org-wide scope is left as it was: a role change never silently widens or narrows reach.
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
  /** F1: a custom role id from Control > Roles, sent instead of `role`. */
  readonly customRoleId?: unknown;
  readonly version?: unknown;
}

/** Whether a stored string is one of the fixed allowlisted capabilities. */
function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/** Parse a custom role's stored capability JSON defensively, keeping only allowlisted strings. */
export function customRoleCapabilities(json: string): readonly Capability[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isCapability) : [];
  } catch {
    return [];
  }
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
    @Optional()
    @Inject(MemberBulkRoleRepository)
    private readonly customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
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
    const customRoleId =
      typeof body?.customRoleId === 'string' ? body.customRoleId.trim() : undefined;
    if (body?.customRoleId !== undefined && (customRoleId === undefined || customRoleId === '')) {
      throw new ApiError(400, 'validation_failed', 'Choose a role.', [
        { field: 'customRoleId', message: 'must be a custom role id' },
      ]);
    }
    const role = customRoleId ?? (typeof body?.role === 'string' ? body.role.trim() : '');
    if (customRoleId === undefined && !isInternalRole(role)) {
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
      if (customRoleId !== undefined) {
        // F1: resolve the custom role tenant-scoped before anything else (a foreign id is a 404
        // like an unknown one), then the escalation guard on its capability subset (403).
        const custom = await this.customRoles.findRoleById(tx, context, customRoleId);
        if (!custom) throw new ApiError(404, 'not_found', MESSAGES.notFound);
        for (const capability of customRoleCapabilities(custom.capabilitiesJson)) {
          const verdict = mayGrantCapability(principal, capability, context.organizationId);
          if (!verdict.allowed) {
            throw new ApiError(
              403,
              'forbidden',
              'You can only give a role whose rights you hold yourself.',
              undefined,
              `member_role.escalation:${verdict.code}`,
            );
          }
        }
      }
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
          // A custom role id is stored in `memberships.role` as the bulk assign stores it; the
          // org-wide scope stays as it was rather than defaulting from a role name.
          role as InternalRole,
          customRoleId === undefined ? undefined : current.hasOrgWideScope,
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
        metadata: {
          target_user_id: updated.userId,
          previous_role: previousRole,
          new_role: role,
          ...(customRoleId === undefined ? {} : { custom_role_id: customRoleId }),
        },
      });
      return view(updated, true);
    });
  }
}
