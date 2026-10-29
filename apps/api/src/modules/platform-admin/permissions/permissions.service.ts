import {
  ASSIGNABLE_INTERNAL_ROLES,
  CAPABILITIES,
  CLIENT_ROLES,
  PLATFORM_SUPPORT_ROLE,
  capabilitiesFor,
  computeEffectivePermissions,
  customRoleIdOf,
  customRoleKey,
  isCustomRoleId,
  isInternalOnlyCapability,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type {
  Capability,
  ClientRole,
  EffectivePermissionsView,
  InternalRole,
  PermissionOverrides,
  Principal,
  PrincipalRole,
} from '@tmanage/domain';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { RoleEditRepository } from '../../admin/role-edit.repository.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuditChangeInput } from '../../audit/audit-redaction.js';
import { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import { MembershipOverridesRepository } from '../../tenancy/membership-overrides.repository.js';
import type { MembershipOverrideRecord } from '../../tenancy/membership-overrides.repository.js';
import type { MemberEffectivePermissionsView } from '../../tenancy/membership-overrides.controller.js';
import { parseOverrides, requireMayOverride } from '../../tenancy/override-ceiling.js';
import { optionalReason, requireId } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import { PlatformPermissionsRepository } from './permissions.repository.js';
import type {
  MemberIdentity,
  PermissionsOrganization,
  ProjectOption,
} from './permissions.repository.js';

/**
 * platform-admin v2 · PA-04 — the platform side of the permission editors (SPEC §5.2 roles and
 * member permissions, D7/D8).
 *
 * Same rules as the organization side, reached through the same code: x195's role repository,
 * PA-01's override repository, `override-ceiling.ts` and the real `computeEffectivePermissions`,
 * all on the ordinary tenant path (a service context bound to ONE organization). The platform
 * admin is not a member, so the "only what you hold yourself" ceiling is the owner's — what a
 * live Support session carries (SPEC §3.2) — while every other refusal is unchanged: an owner
 * takes no overrides (400), a client contact takes no internal-only permission (400), a deny
 * never lands on TManage support (400).
 *
 * Every write commits with two audit rows: the organization's own `audit_events` row (actor
 * null, effective actor = the platform admin, `changes[]` per capability) and the platform's
 * `platform_admin_audit_events` row (before/after, reason when given).
 */

export const PLATFORM_PERMISSIONS_POLICY_VERSION = 'platform-admin';

export interface PlatformOrgRoleView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'internal' | 'client';
  readonly builtIn: boolean;
  readonly capabilities: readonly Capability[];
  /** Active and invited people holding the role. */
  readonly holders: number;
  readonly createdAt: string | null;
}

export interface PlatformOrgRolesView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly slug: string;
  /** How many permissions exist ("18 of 56"). */
  readonly permissionCount: number;
  readonly roles: readonly PlatformOrgRoleView[];
}

export interface PlatformOrgRoleWriteView {
  readonly role: PlatformOrgRoleView;
}

export interface PlatformOrgRoleDeleteView {
  readonly deletedRoleId: string;
  readonly reassignedTo: string;
  readonly reassigned: number;
}

export interface PlatformMemberOverrideView {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly live: boolean;
}

export interface PlatformMemberPermissionsView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly slug: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly kind: 'internal' | 'client';
  /** A built-in role name, or a custom role's id. */
  readonly role: string;
  /** The custom role's name, or the built-in role name again. */
  readonly roleName: string;
  readonly status: string;
  readonly scope: 'org' | 'workspace' | 'projects';
  /** False for an owner and for a client contact: no per-person overrides there. */
  readonly editable: boolean;
  readonly overrides: readonly PlatformMemberOverrideView[];
  readonly effective: MemberEffectivePermissionsView;
  readonly projects: readonly ProjectOption[];
}

interface RoleBody {
  readonly name?: unknown;
  readonly capabilities?: unknown;
  readonly reason?: unknown;
}

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_NAME_MAX = 128;

function invalid(field: string, message: string, summary = 'The request is invalid'): ApiError {
  return new ApiError(400, 'validation_failed', summary, [{ field, message }]);
}

/** A role name: trimmed, 1–128 characters. */
export function validateRoleName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0)
    throw invalid('name', 'Enter a name for the role.', 'A role name is required.');
  if (name.length > ROLE_NAME_MAX) {
    throw invalid(
      'name',
      'Keep the name to 128 characters or fewer.',
      'That role name is too long.',
    );
  }
  if (name.startsWith('†')) throw invalid('name', 'That name is reserved.');
  return name;
}

/** A capability list: a non-empty array of known capabilities, deduplicated, in catalog order. */
export function validateCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(
      'capabilities',
      'Select one or more capabilities for the role.',
      'Choose at least one capability.',
    );
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !KNOWN.has(entry)) {
      throw invalid(
        'capabilities',
        'One or more capabilities are not recognised.',
        'That is not a capability we recognise.',
      );
    }
  }
  const held = new Set(value as string[]);
  return CAPABILITIES.filter((capability) => held.has(capability));
}

/** The before/after rows of a capability set change, one per capability that moved. */
export function capabilityChanges(
  before: readonly Capability[],
  after: readonly Capability[],
): AuditChangeInput[] {
  const was = new Set(before);
  const now = new Set(after);
  return CAPABILITIES.filter((capability) => was.has(capability) !== now.has(capability)).map(
    (capability) => ({
      field: `capability.${capability}`,
      before: was.has(capability),
      after: now.has(capability),
    }),
  );
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** The ceiling the platform side grants with: the owner's, as a live Support session does. */
function platformGranter(organizationId: string): Principal {
  return {
    userId: '00000000-0000-0000-0000-000000000000',
    organizationId,
    kind: 'internal',
    role: PLATFORM_SUPPORT_ROLE,
    membershipId: '00000000-0000-0000-0000-000000000000',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

export class PlatformPermissionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly platformAudit: PlatformAuditService,
    private readonly audit: AuditService | undefined,
    private readonly repository = new PlatformPermissionsRepository(),
    private readonly roles = new RoleEditRepository(),
    private readonly overrides = new MembershipOverridesRepository(),
    private readonly memberships = new MembershipsRepository(),
  ) {}

  private context(organizationId: string, request: PlatformRequestContext): TenantContext {
    return createServiceContext({
      organizationId: requireId(organizationId),
      correlationId: request.correlationId,
      policyVersion: PLATFORM_PERMISSIONS_POLICY_VERSION,
    });
  }

  private async organizationOr404(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<PermissionsOrganization> {
    const organization = await this.repository.organization(runner, context);
    if (!organization) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return organization;
  }

  private async customRoleOr404(
    runner: TenantQueryRunner,
    context: TenantContext,
    roleId: string,
  ): Promise<CustomRoleRow> {
    if (!UUID.test(roleId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const row = await this.roles.findById(runner, context, roleId);
    if (!row || row.name.startsWith('†')) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }

  private async requireFreeName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
    except?: string,
  ): Promise<void> {
    const clash = await this.roles.findByName(runner, context, name);
    if (clash && clash.id !== except) {
      throw new ApiError(409, 'conflict', 'A role with that name already exists.');
    }
  }

  private customView(row: CustomRoleRow, holders: number): PlatformOrgRoleView {
    return {
      id: row.id,
      name: row.name,
      kind: 'internal',
      builtIn: false,
      capabilities: parseCustomRoleCapabilities(row.capabilitiesJson),
      holders,
      createdAt: iso(row.createdAt),
    };
  }

  // ── Roles ────────────────────────────────────────────────────────────────

  async listRoles(
    organizationId: string,
    request: PlatformRequestContext,
  ): Promise<PlatformOrgRolesView> {
    const context = this.context(organizationId, request);
    return this.database.read(context, async (runner) => {
      const organization = await this.organizationOr404(runner, context);
      const [custom, internal, client] = await Promise.all([
        this.repository.customRoles(runner, context),
        this.repository.internalHolders(runner, context),
        this.repository.clientHolders(runner, context),
      ]);
      const roles: PlatformOrgRoleView[] = [
        ...ASSIGNABLE_INTERNAL_ROLES.map((role) => ({
          id: role,
          name: role,
          kind: 'internal' as const,
          builtIn: true,
          capabilities: capabilitiesFor(role),
          holders: internal.get(role) ?? 0,
          createdAt: null,
        })),
        ...CLIENT_ROLES.map((role) => ({
          id: role,
          name: role,
          kind: 'client' as const,
          builtIn: true,
          capabilities: capabilitiesFor(role),
          holders: client.get(role) ?? 0,
          createdAt: null,
        })),
        ...custom.map((row) => this.customView(row, internal.get(row.id) ?? 0)),
      ];
      return {
        organizationId: organization.id,
        organizationName: organization.name,
        slug: organization.slug,
        permissionCount: CAPABILITIES.length,
        roles,
      };
    });
  }

  async createRole(
    actor: PlatformAdminActor,
    organizationId: string,
    body: RoleBody,
    request: PlatformRequestContext,
  ): Promise<PlatformOrgRoleWriteView> {
    const context = this.context(organizationId, request);
    const name = validateRoleName(body.name);
    const capabilities = validateCapabilities(body.capabilities);
    const reason = optionalReason(body.reason);
    return this.database.transaction(context, async (tx) => {
      const organization = await this.organizationOr404(tx, context);
      await this.requireFreeName(tx, context, name);
      const row = await this.roles.insert(tx, context, {
        name,
        capabilities,
        createdBy: actor.account.userId,
      });
      await this.audit?.record(tx, context, {
        action: 'custom_role.created',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        effectiveActorId: actor.account.userId,
        metadata: { capability_count: capabilities.length, via: 'platform_admin' },
        changes: capabilityChanges([], capabilities),
      });
      await this.writePlatformAudit(tx, actor, request, {
        action: 'platform.org_role_created',
        organization,
        targetLabel: name,
        before: null,
        after: { name, capabilities },
        reason,
      });
      return { role: this.customView(row, 0) };
    });
  }

  async updateRole(
    actor: PlatformAdminActor,
    organizationId: string,
    roleId: string,
    body: RoleBody,
    request: PlatformRequestContext,
  ): Promise<PlatformOrgRoleWriteView> {
    const context = this.context(organizationId, request);
    const reason = optionalReason(body.reason);
    return this.database.transaction(context, async (tx) => {
      const organization = await this.organizationOr404(tx, context);
      const current = await this.customRoleOr404(tx, context, roleId);
      const before = parseCustomRoleCapabilities(current.capabilitiesJson);
      const name = body.name === undefined ? current.name : validateRoleName(body.name);
      const capabilities =
        body.capabilities === undefined ? [...before] : validateCapabilities(body.capabilities);
      await this.requireFreeName(tx, context, name, current.id);
      const updated = await this.roles.update(tx, context, { id: current.id, name, capabilities });
      const changes: AuditChangeInput[] = capabilityChanges(before, capabilities);
      if (name !== current.name)
        changes.unshift({ field: 'name', before: current.name, after: name });
      if (changes.length > 0) {
        await this.audit?.record(tx, context, {
          action: 'custom_role.updated',
          objectId: current.id,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: { capability_count: capabilities.length, via: 'platform_admin' },
          changes,
        });
        await this.writePlatformAudit(tx, actor, request, {
          action: 'platform.org_role_updated',
          organization,
          targetLabel: name,
          before: { name: current.name, capabilities: before },
          after: { name, capabilities },
          reason,
        });
      }
      const holders = await this.repository.holdersOf(tx, context, current.id);
      return { role: this.customView(updated, holders.length) };
    });
  }

  async cloneRole(
    actor: PlatformAdminActor,
    organizationId: string,
    roleId: string,
    body: RoleBody,
    request: PlatformRequestContext,
  ): Promise<PlatformOrgRoleWriteView> {
    const context = this.context(organizationId, request);
    const name = validateRoleName(body.name);
    const reason = optionalReason(body.reason);
    return this.database.transaction(context, async (tx) => {
      const organization = await this.organizationOr404(tx, context);
      // A built-in role can be the source too: its ceiling becomes the copy's starting set.
      const capabilities = await this.sourceCapabilities(tx, context, roleId);
      await this.requireFreeName(tx, context, name);
      const row = await this.roles.insert(tx, context, {
        name,
        capabilities,
        createdBy: actor.account.userId,
      });
      await this.audit?.record(tx, context, {
        action: 'custom_role.created',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        effectiveActorId: actor.account.userId,
        metadata: {
          capability_count: capabilities.length,
          cloned_from: roleId,
          via: 'platform_admin',
        },
        changes: capabilityChanges([], capabilities),
      });
      await this.writePlatformAudit(tx, actor, request, {
        action: 'platform.org_role_cloned',
        organization,
        targetLabel: name,
        before: { source: roleId },
        after: { name, capabilities },
        reason,
      });
      return { role: this.customView(row, 0) };
    });
  }

  private async sourceCapabilities(
    runner: TenantQueryRunner,
    context: TenantContext,
    roleId: string,
  ): Promise<Capability[]> {
    if ((ASSIGNABLE_INTERNAL_ROLES as readonly string[]).includes(roleId)) {
      return [...capabilitiesFor(roleId as InternalRole)];
    }
    const row = await this.customRoleOr404(runner, context, roleId);
    const capabilities = parseCustomRoleCapabilities(row.capabilitiesJson);
    if (capabilities.length === 0) throw invalid('roleId', 'This role grants nothing to copy.');
    return [...capabilities];
  }

  async deleteRole(
    actor: PlatformAdminActor,
    organizationId: string,
    roleId: string,
    body: { readonly reassignTo?: unknown; readonly reason?: unknown },
    request: PlatformRequestContext,
  ): Promise<PlatformOrgRoleDeleteView> {
    const context = this.context(organizationId, request);
    const reason = optionalReason(body.reason);
    const reassignTo = typeof body.reassignTo === 'string' ? body.reassignTo.trim() : '';
    if (reassignTo === '') {
      throw invalid(
        'reassignTo',
        'Choose the role its holders move to.',
        'A replacement role is required.',
      );
    }
    return this.database.transaction(context, async (tx) => {
      const organization = await this.organizationOr404(tx, context);
      const target = await this.customRoleOr404(tx, context, roleId);
      if (reassignTo === target.id) {
        throw invalid('reassignTo', 'Choose a different role.');
      }
      // Owner is never handed out by deleting a role; every other built-in role, or a live custom
      // role of this organization, may receive the holders.
      const builtIn = (ASSIGNABLE_INTERNAL_ROLES as readonly string[]).includes(reassignTo);
      if (reassignTo === 'owner') {
        throw invalid('reassignTo', 'Holders cannot be made owners this way.');
      }
      if (!builtIn) {
        if (!UUID.test(reassignTo))
          throw invalid('reassignTo', 'must be a role of this organization');
        const replacement = await this.roles.findById(tx, context, reassignTo);
        if (!replacement || replacement.name.startsWith('†')) {
          throw invalid('reassignTo', 'must be a role of this organization');
        }
      }
      const holders = await this.repository.holdersOf(tx, context, target.id);
      for (const holder of holders) {
        await this.memberships.changeRole(
          tx,
          context,
          holder.id,
          holder.version,
          reassignTo as InternalRole,
        );
        await this.audit?.record(tx, context, {
          action: 'membership.role_changed',
          objectId: holder.id,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: { target_user_id: holder.userId, via: 'platform_admin' },
          changes: [{ field: 'role', before: target.id, after: reassignTo }],
        });
      }
      const before = parseCustomRoleCapabilities(target.capabilitiesJson);
      await this.repository.retireRole(tx, context, target.id);
      await this.audit?.record(tx, context, {
        action: 'custom_role.deleted',
        objectId: target.id,
        result: 'allowed',
        actorUserId: null,
        effectiveActorId: actor.account.userId,
        metadata: { reassigned: holders.length, via: 'platform_admin' },
        changes: [{ field: 'name', before: target.name, after: null }],
      });
      await this.writePlatformAudit(tx, actor, request, {
        action: 'platform.org_role_deleted',
        organization,
        targetLabel: target.name,
        before: { name: target.name, capabilities: before, holders: holders.length },
        after: { reassignedTo: reassignTo },
        reason,
      });
      return { deletedRoleId: target.id, reassignedTo: reassignTo, reassigned: holders.length };
    });
  }

  // ── Member permissions ───────────────────────────────────────────────────

  async memberPermissions(
    organizationId: string,
    membershipId: string,
    projectId: string | undefined,
    request: PlatformRequestContext,
  ): Promise<PlatformMemberPermissionsView> {
    const context = this.context(organizationId, request);
    const project = parseProjectId(projectId);
    return this.database.read(context, (runner) =>
      this.memberView(runner, context, membershipId, project),
    );
  }

  async effectivePermissions(
    organizationId: string,
    membershipId: string,
    projectId: string | undefined,
    request: PlatformRequestContext,
  ): Promise<MemberEffectivePermissionsView> {
    const context = this.context(organizationId, request);
    const project = parseProjectId(projectId);
    return this.database.read(context, async (runner) => {
      await this.organizationOr404(runner, context);
      const member = await this.memberOr404(runner, context, membershipId);
      return this.effectiveOf(runner, context, member, project);
    });
  }

  async replaceOverrides(
    actor: PlatformAdminActor,
    organizationId: string,
    membershipId: string,
    body: unknown,
    request: PlatformRequestContext,
  ): Promise<PlatformMemberPermissionsView> {
    const context = this.context(organizationId, request);
    const reason = optionalReason((body as { reason?: unknown } | null)?.reason);
    const action = 'platform.member_overrides';
    return this.database.transaction(context, async (tx) => {
      const organization = await this.organizationOr404(tx, context);
      const member = await this.memberOr404(tx, context, membershipId);
      const next = parseOverrides(body);
      // The same ceiling helper as the organization side; the platform grants as the owner does.
      requireMayOverride(
        platformGranter(context.organizationId),
        { role: member.role, audience: member.kind },
        next,
        context.organizationId,
        action,
      );
      if (member.kind === 'client') {
        // 0242 reserves client overrides: its foreign key names `memberships` only.
        throw new ApiError(
          400,
          'validation_failed',
          'Client contacts take no per-person overrides; change their client role instead.',
          undefined,
          `${action}:client_overrides_unsupported`,
        );
      }
      if (member.status === 'offboarded') {
        throw new ApiError(409, 'conflict', 'This person has left the organization.');
      }
      const beforeRows = await this.overrides.list(tx, context, member.id);
      const change = await this.overrides.replace(
        tx,
        context,
        member.id,
        next,
        actor.account.userId,
      );
      if (change.added.length > 0 || change.revoked.length > 0) {
        await this.audit?.record(tx, context, {
          action: 'membership.permission_overrides_changed',
          objectId: member.id,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: {
            target_user_id: member.userId,
            added: change.added.length,
            removed: change.revoked.length,
            via: 'platform_admin',
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
        await this.writePlatformAudit(tx, actor, request, {
          action: 'platform.member_overrides_changed',
          organization,
          targetType: 'user',
          targetId: member.userId,
          targetLabel: member.email,
          before: beforeRows.map(overrideSummary),
          after: next.map((entry) => ({
            capability: entry.capability,
            effect: entry.effect,
            expiresAt: entry.expiresAt?.toISOString() ?? null,
          })),
          reason,
        });
      }
      return this.memberView(tx, context, member.id, null);
    });
  }

  private async memberOr404(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MemberIdentity> {
    if (!UUID.test(membershipId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const member = await this.repository.member(runner, context, membershipId);
    if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return member;
  }

  private async memberView(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    project: { id: string } | null,
  ): Promise<PlatformMemberPermissionsView> {
    const organization = await this.organizationOr404(runner, context);
    const member = await this.memberOr404(runner, context, membershipId);
    const rows: readonly MembershipOverrideRecord[] =
      member.kind === 'internal' ? await this.overrides.list(runner, context, member.id) : [];
    const names = await this.repository.userNames(
      runner,
      rows.map((row) => row.createdBy),
    );
    const effective = await this.effectiveOf(runner, context, member, project);
    const projects = await this.repository.projectOptions(runner, context, member);
    const roleName = await this.roleNameOf(runner, context, member.role);
    return {
      organizationId: organization.id,
      organizationName: organization.name,
      slug: organization.slug,
      membershipId: member.id,
      userId: member.userId,
      displayName: member.displayName,
      email: member.email,
      kind: member.kind,
      role: member.role,
      roleName,
      status: member.status,
      scope: member.hasOrgWideScope
        ? 'org'
        : member.workspaceScopeId !== null
          ? 'workspace'
          : 'projects',
      editable: member.kind === 'internal' && member.role !== 'owner',
      overrides: rows.map((row) => ({
        id: row.id,
        capability: row.capability,
        effect: row.effect,
        reason: row.reason,
        expiresAt: iso(row.expiresAt),
        createdBy: row.createdBy,
        createdByName: names.get(row.createdBy) ?? null,
        createdAt: row.createdAt.toISOString(),
        live: row.live,
      })),
      effective,
      projects,
    };
  }

  private async roleNameOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    role: string,
  ): Promise<string> {
    if (!isCustomRoleId(role)) return role;
    const row = await this.roles.findById(runner, context, role);
    return row?.name ?? role;
  }

  private async roleKeyOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    role: string,
  ): Promise<PrincipalRole> {
    if (!isCustomRoleId(role)) return role as PrincipalRole;
    const row = await this.roles.findById(runner, context, role);
    return customRoleKey(role, row ? parseCustomRoleCapabilities(row.capabilitiesJson) : []);
  }

  private async effectiveOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    member: MemberIdentity,
    project: { id: string } | null,
  ): Promise<MemberEffectivePermissionsView> {
    const live: PermissionOverrides =
      member.kind === 'internal'
        ? await this.overrides.liveOverrides(runner, context, member.id)
        : { allow: [], deny: [] };
    const projectIds =
      member.kind === 'internal'
        ? await this.overrides.projectIdsOf(runner, context, {
            id: member.id,
            userId: member.userId,
            role: member.role,
            status: member.status,
            hasOrgWideScope: member.hasOrgWideScope,
            workspaceScopeId: member.workspaceScopeId,
          })
        : [];
    const principal: Principal = {
      userId: member.userId,
      organizationId: context.organizationId,
      kind: member.kind,
      role:
        member.kind === 'internal'
          ? await this.roleKeyOf(runner, context, member.role)
          : (member.role as ClientRole),
      membershipId: member.id,
      membershipStatus:
        member.status === 'active' || member.status === 'invited' ? 'active' : 'suspended',
      clientOrganizationId: member.clientOrganizationId,
      projectIds,
      hasOrgWideScope: member.hasOrgWideScope,
      overrides: live,
    };
    let permissions: EffectivePermissionsView = computeEffectivePermissions({ principal, project });
    // A client contact never sees internal-only cells (D8 "client member").
    if (member.kind === 'client') {
      permissions = permissions.filter((entry) => !isInternalOnlyCapability(entry.capability));
    }
    return {
      membershipId: member.id,
      role: customRoleIdOf(member.role) ?? member.role,
      projectId: project?.id ?? null,
      overrides: live,
      permissions,
    };
  }

  private async writePlatformAudit(
    tx: TenantQueryRunner,
    actor: PlatformAdminActor,
    request: PlatformRequestContext,
    input: {
      readonly action: string;
      readonly organization: PermissionsOrganization;
      readonly targetType?: 'organization' | 'user';
      readonly targetId?: string;
      readonly targetLabel: string;
      readonly before: unknown;
      readonly after: unknown;
      readonly reason: string | null;
    },
  ): Promise<void> {
    const row = this.platformAudit.build({
      actor,
      action: input.action,
      targetType: input.targetType ?? 'organization',
      targetId: input.targetId ?? input.organization.id,
      targetLabel: input.targetLabel,
      organizationId: input.organization.id,
      before: input.before,
      after: input.after,
      reason: input.reason,
      reasonRequired: false,
      request: { ip: request.ip, userAgent: request.userAgent },
      correlationId: request.correlationId,
    });
    await this.platformAudit.insert(tx, row);
  }
}

function overrideSummary(row: MembershipOverrideRecord) {
  return {
    capability: row.capability,
    effect: row.effect,
    expiresAt: iso(row.expiresAt),
  };
}

function parseProjectId(projectId: string | undefined): { id: string } | null {
  if (projectId === undefined || projectId === '') return null;
  if (!UUID.test(projectId)) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'projectId', message: 'must be a project id' },
    ]);
  }
  return { id: projectId };
}
