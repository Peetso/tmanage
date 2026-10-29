import { Body, Controller, Get, Inject, Optional, Param, Put, Query, Req } from '@nestjs/common';
import {
  authorize,
  computeEffectivePermissions,
  customRoleIdOf,
  customRoleKey,
  effectiveCapabilitySet,
  isCustomRoleId,
} from '@tmanage/domain';
import type {
  Capability,
  EffectivePermissionsView,
  PermissionOverrides,
  Principal,
  PrincipalRole,
} from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { MembershipOverridesRepository } from './membership-overrides.repository.js';
import type {
  MembershipOverrideRecord,
  OverrideMember,
} from './membership-overrides.repository.js';
import { parseOverrides, requireMayOverride } from './override-ceiling.js';
import { capabilitiesOfStoredRole, ROLE_ASSIGN_CAPABILITY } from './role-grant-ceiling.js';

/**
 * platform-admin v2 · PA-01 — the organization side of per-member permission overrides
 * (SPEC §3.3, §5.7; screens D8 arrive in PA-04).
 *
 *   - `GET  …/people/:membershipId/permissions/overrides` — the member's unrevoked overrides,
 *     live and expired (`roles.assign`).
 *   - `PUT  …/people/:membershipId/permissions/overrides` — replace them (`roles.assign` plus
 *     `override-ceiling.ts`): an allow only names a permission the caller holds, an owner takes no
 *     overrides, a deny never lands on TManage support. Revoked rows stay; audited in the same
 *     transaction.
 *   - `GET  …/people/:membershipId/effective-permissions?projectId=` — "what can this person do",
 *     the real `authorize()` per capability (`people.view` for one's own membership, `roles.assign`
 *     for anybody else's).
 *   - `GET  …/me` — the caller's own principal view: role, effective capabilities, overrides and the
 *     support session when the caller is TManage support.
 *
 * The membership id is resolved tenant-scoped before any decision about it: a membership of another
 * organization is a 404, indistinguishable from an unknown one.
 */

/** One override as the wire carries it. */
export interface MembershipOverrideView {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly live: boolean;
}

export interface MembershipOverridesView {
  readonly membershipId: string;
  readonly role: string;
  /** False for an owner: an owner always has every permission and takes no overrides. */
  readonly editable: boolean;
  readonly overrides: readonly MembershipOverrideView[];
}

export interface MembershipOverridesChangeView extends MembershipOverridesView {
  readonly added: number;
  readonly removed: number;
}

export interface MemberEffectivePermissionsView {
  readonly membershipId: string;
  readonly role: string;
  readonly projectId: string | null;
  readonly overrides: PermissionOverrides;
  readonly permissions: EffectivePermissionsView;
}

export interface OrganizationMeView {
  readonly membershipId: string;
  readonly userId: string;
  readonly kind: Principal['kind'];
  /** A built-in role name, or a custom role's id. */
  readonly role: string;
  readonly capabilities: readonly Capability[];
  readonly overrides: PermissionOverrides;
  readonly supportSession: { readonly id: string; readonly expiresAt: string | null } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function orgResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

function toView(row: MembershipOverrideRecord): MembershipOverrideView {
  return {
    id: row.id,
    capability: row.capability,
    effect: row.effect,
    reason: row.reason,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    live: row.live,
  };
}

/** A stored role as the wire names it: the built-in name, or the custom role's id. */
function wireRole(role: string): string {
  return customRoleIdOf(role) ?? role;
}

function iso(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

@Controller('v1/organizations/:orgSlug')
export class MembershipOverridesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(MembershipOverridesRepository)
    private readonly overrides: MembershipOverridesRepository = new MembershipOverridesRepository(),
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
    @Optional()
    @Inject(MemberBulkRoleRepository)
    private readonly customRoles: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
  ) {}

  /** The caller's own principal view (200). Every role holds `approval.read`. */
  @Get('me')
  @RequireCapability('approval.read')
  me(@CurrentPrincipal() principal: Principal, @Req() request: object): OrganizationMeView {
    const session = requestState(request)?.membership?.supportSession ?? null;
    const set = effectiveCapabilitySet(principal);
    return {
      membershipId: principal.membershipId,
      userId: principal.userId,
      kind: principal.kind,
      role: wireRole(principal.role),
      capabilities: [...set],
      overrides: principal.overrides ?? { allow: [], deny: [] },
      supportSession:
        session === null ? null : { id: session.id, expiresAt: iso(session.expiresAt) },
    };
  }

  /** The member's unrevoked overrides (200). */
  @Get('people/:membershipId/permissions/overrides')
  @RequireCapability(ROLE_ASSIGN_CAPABILITY)
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<MembershipOverridesView> {
    return this.database.read(context, async (runner) => {
      const member = await this.memberOr404(runner, context, membershipId);
      this.requireRoleAssign(principal, context, 'membership_overrides.read');
      const rows = await this.overrides.list(runner, context, member.id);
      return {
        membershipId: member.id,
        role: wireRole(member.role),
        editable: member.role !== 'owner',
        overrides: rows.map(toView),
      };
    });
  }

  /**
   * Replace the member's overrides (200). Order: resolve the member (404), `roles.assign` (403),
   * validate the body (400), refuse one's own overrides (403) and an offboarded member (409), the
   * override ceiling (400/403), then the write and its audit row in one transaction.
   */
  @Put('people/:membershipId/permissions/overrides')
  @RequireCapability(ROLE_ASSIGN_CAPABILITY)
  async replace(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<MembershipOverridesChangeView> {
    const action = 'membership_overrides.replace';
    return this.database.transaction(context, async (tx) => {
      const member = await this.memberOr404(tx, context, membershipId);
      this.requireRoleAssign(principal, context, action);
      const next = parseOverrides(body);
      // The ceiling first: an owner target is a 400 ("Owners always have every permission")
      // whoever asks, including the owner themselves.
      requireMayOverride(
        principal,
        { role: member.role, audience: 'internal' },
        next,
        context.organizationId,
        action,
      );
      if (member.id === principal.membershipId) {
        throw new ApiError(
          403,
          'forbidden',
          'You cannot change your own permissions.',
          undefined,
          `${action}:self`,
        );
      }
      if (member.status === 'offboarded') {
        throw new ApiError(409, 'conflict', 'This person has left the organization.');
      }
      const change = await this.overrides.replace(tx, context, member.id, next, context.userId);
      if (change.added.length > 0 || change.revoked.length > 0) {
        await this.audit?.record(tx, context, {
          action: 'membership.permission_overrides_changed',
          objectId: member.id,
          result: 'allowed',
          metadata: {
            target_user_id: member.userId,
            added: change.added.length,
            removed: change.revoked.length,
          },
          changes: [
            ...change.revoked.map((row) => ({
              field: `override.${row.capability}`,
              before: row.effect,
              after: null,
            })),
            ...change.added.map((entry) => ({
              field: `override.${entry.capability}`,
              before: null,
              after: entry.effect,
            })),
          ],
        });
      }
      const rows = await this.overrides.list(tx, context, member.id);
      return {
        membershipId: member.id,
        role: wireRole(member.role),
        editable: true,
        overrides: rows.map(toView),
        added: change.added.length,
        removed: change.revoked.length,
      };
    });
  }

  /** "What can this person do" (200), optionally simulated on one project. */
  @Get('people/:membershipId/effective-permissions')
  @RequireCapability('people.view')
  async effective(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Query('projectId') projectId?: string,
  ): Promise<MemberEffectivePermissionsView> {
    if (projectId !== undefined && projectId !== '' && !UUID.test(projectId)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'projectId', message: 'must be a project id' },
      ]);
    }
    const project = projectId ? { id: projectId } : null;
    return this.database.read(context, async (runner) => {
      const member = await this.memberOr404(runner, context, membershipId);
      if (member.id !== principal.membershipId) {
        this.requireRoleAssign(principal, context, 'membership_overrides.effective');
      }
      const live = await this.overrides.liveOverrides(runner, context, member.id);
      const target: Principal = {
        userId: member.userId,
        organizationId: context.organizationId,
        kind: 'internal',
        role: await this.roleKeyOf(runner, context, member.role),
        membershipId: member.id,
        // An invitee is previewed with what they will get on accepting; a suspended or departed
        // member exercises nothing.
        membershipStatus:
          member.status === 'active' || member.status === 'invited' ? 'active' : 'suspended',
        clientOrganizationId: null,
        projectIds: await this.overrides.projectIdsOf(runner, context, member),
        hasOrgWideScope: member.hasOrgWideScope,
        overrides: live,
      };
      return {
        membershipId: member.id,
        role: wireRole(member.role),
        projectId: project?.id ?? null,
        overrides: live,
        permissions: computeEffectivePermissions({ principal: target, project }),
      };
    });
  }

  private async memberOr404(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<OverrideMember> {
    if (!UUID.test(membershipId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const member = await this.overrides.findMember(runner, context, membershipId);
    if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return member;
  }

  /** A custom role's stored id becomes the evaluator's key with its row's capabilities. */
  private async roleKeyOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    storedRole: string,
  ): Promise<PrincipalRole> {
    if (!isCustomRoleId(storedRole)) return storedRole as PrincipalRole;
    const capabilities = await capabilitiesOfStoredRole(
      runner,
      context,
      storedRole,
      this.customRoles,
    );
    return customRoleKey(storedRole, capabilities);
  }

  private requireRoleAssign(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: ROLE_ASSIGN_CAPABILITY,
      resource: orgResource(context),
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
