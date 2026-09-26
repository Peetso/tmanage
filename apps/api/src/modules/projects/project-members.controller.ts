import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { authorize, INTERNAL_ROLES, isInternalRole } from '@tmanage/domain';
import type { InternalRole, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  MEMBERSHIPS_REPOSITORY,
  PROJECTS_REPOSITORY,
  PROJECT_MEMBERSHIPS_REPOSITORY,
  PROJECT_MEMBERSHIPS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectMembershipRow } from '../../common/database/schema.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { ProjectMembershipsRepository } from './project-memberships.repository.js';
import {
  ProjectMembershipConflictError,
  ProjectMembershipNotFoundError,
} from './project-memberships.repository.js';
import type { ProjectMembershipsService } from './project-memberships.service.js';

/**
 * ADM-02 — the administration surface for who is on a project and in what role.
 *
 * `ProjectMembershipsService.{add,changeRole,remove}` and its repository have existed since
 * PROJ-001, writing `project_membership.*` audit rows in the same transaction as the state
 * change, but nothing exposed them over HTTP — the note atop `projects.module.ts` says so
 * ("No controller yet"). This is that controller, and it is where the two decisions the service
 * deliberately does not make are made: the **object-level authorization** (the service's header
 * records that a project membership has no audience/lifecycle of its own, so the honest gate is
 * the project's, "which means it belongs with the controller that will expose them"), and the
 * **privilege-escalation guard** on a role assignment.
 *
 * ## Two authorization layers, then the escalation guard
 *
 * `CapabilityGuard` on each route asks the coarse question `project.member.manage`: does this
 * role's ceiling include managing members at all. That is all a guard can honestly answer with
 * no object loaded. Each handler then resolves the named `projectId` **inside this tenant first**
 * (`ProjectsRepository.findById` is tenant-scoped) and runs `authorize()` with the project in
 * hand — the relation check. A `projectId` that is unknown or belongs to another organization,
 * or a caller who is not a member of it, produces **not found**, never forbidden: 403 would
 * confirm the project exists, and which projects a studio runs is exactly what a non-member must
 * not be able to enumerate (`MeetingsService.create`'s reasoning, after `75e2913`). Every other
 * named id — the target user, the membership row — is likewise resolved tenant-scoped before any
 * write, so a cross-tenant id is a 404 and never reaches a foreign key as a 500.
 *
 * The escalation guard is the security substance this slice adds, and it is enforced **here**
 * rather than in the service because the service is shared with the audit database test, which
 * calls it with a `TenantContext` and no `Principal`. A role assignment carries a `Principal`;
 * these guards need it, so they live with the HTTP surface that has one:
 *
 *   - **Ceiling.** A caller may never grant, or act on a member who already holds, a role more
 *     privileged than the caller's own. `INTERNAL_ROLES` is ordered most-privileged first, so
 *     rank is the array index and "more privileged" is a smaller index. Without this, a manager
 *     could make themselves — or anyone — an owner.
 *   - **Self.** A caller may not change their own role. Self-elevation is the escalation this
 *     most obviously invites, and there is no legitimate reason to change your own project role
 *     through the admin surface.
 *   - **Last owner.** The final `owner` membership on a project may not be demoted or removed.
 *     A project with no owner is one nothing can be escalated to, and the removal would be
 *     unrecoverable through this surface.
 *
 * Each guard refuses with 403 and writes nothing.
 */

const MANAGE = 'project.member.manage' as const;

/**
 * What a caller is allowed to see of a project membership.
 *
 * `organizationId` is deliberately absent (`25-AUTH-AND-TENANT-ISOLATION` §7). The person's
 * display name is **not** projected here: `project_memberships` carries only a `user_id`, and
 * resolving names would be a cross-table join with no database proof this slice. The screen
 * pairs these rows against the member directory (`GET …/members`, already proven) by `userId`,
 * so the name is resolved from the one endpoint that owns it rather than duplicated onto this one.
 */
export interface ProjectMemberView {
  readonly projectMembershipId: string;
  readonly userId: string;
  readonly role: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

interface AddMemberBody {
  readonly userId?: unknown;
  readonly role?: unknown;
}

interface ChangeRoleBody {
  readonly role?: unknown;
  /** The role the caller believes is current — the service's compare-and-swap token. */
  readonly expectedRole?: unknown;
}

function toView(row: ProjectMembershipRow): ProjectMemberView {
  return {
    projectMembershipId: row.id,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');

const forbidden = (auditCode: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, auditCode);

/** Rank by `INTERNAL_ROLES` order: most-privileged first, so a smaller index outranks. */
function rank(role: string): number {
  return (INTERNAL_ROLES as readonly string[]).indexOf(role);
}

/** True when `candidate` is strictly more privileged than `ceiling`. */
function outranks(candidate: string, ceiling: string): boolean {
  const candidateRank = rank(candidate);
  const ceilingRank = rank(ceiling);
  // An unknown role (rank -1) is treated as outranking everything: it can never be assigned or
  // acted on by this surface, which only knows the fixed internal roles.
  if (candidateRank === -1) return true;
  if (ceilingRank === -1) return true;
  return candidateRank < ceilingRank;
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/members')
export class ProjectMembersController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PROJECTS_REPOSITORY) private readonly projects: ProjectsRepository,
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
    @Inject(PROJECT_MEMBERSHIPS_REPOSITORY)
    private readonly projectMemberships: ProjectMembershipsRepository,
    @Inject(PROJECT_MEMBERSHIPS_SERVICE)
    private readonly command: ProjectMembershipsService,
  ) {}

  /** Everyone on the project, within the acting tenant. */
  @Get()
  @RequireCapability(MANAGE)
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly members: readonly ProjectMemberView[] }> {
    await this.resolveManageableProject(context, principal, projectId);

    const rows = await this.database.read(context, (runner) =>
      this.projectMemberships.listByProject(runner, context, projectId),
    );

    return { members: rows.map(toView) };
  }

  /** Add a member to the project with a role. */
  @Post()
  @RequireCapability(MANAGE)
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: AddMemberBody,
  ): Promise<ProjectMemberView> {
    await this.resolveManageableProject(context, principal, projectId);

    const userId = typeof body?.userId === 'string' && body.userId !== '' ? body.userId : undefined;
    const role = this.requireInternalRole(body?.role, 'role');
    if (!userId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'userId', message: 'must be a non-empty string' },
      ]);
    }

    // Ceiling: a caller cannot grant a role more privileged than their own.
    if (outranks(role, principal.role)) {
      throw forbidden('role_above_caller_ceiling');
    }

    // Resolve the target user inside this tenant before the write. `project_memberships` does not
    // key its user column to the organization, so an unknown or cross-tenant `userId` would
    // otherwise reach the row as a member of a project they are not in this tenant for.
    const target = await this.database.read(context, (runner) =>
      this.memberships.findByUserId(runner, context, userId),
    );
    if (!target) throw notFound();

    // Idempotence guard against a duplicate grant: the identity unique key would refuse it as a
    // 500, so the readable answer is a pre-check to a 409.
    const existing = await this.database.read(context, (runner) =>
      this.projectMemberships.findByProjectAndUser(runner, context, projectId, userId),
    );
    if (existing) {
      throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'membership_exists');
    }

    const row = await this.command.add(context, { projectId, userId, role });
    return toView(row);
  }

  /** Change a member's role (optimistic on `expectedRole`). */
  @Patch(':projectMembershipId')
  @RequireCapability(MANAGE)
  async changeRole(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('projectMembershipId') projectMembershipId: string,
    @Body() body: ChangeRoleBody,
  ): Promise<ProjectMemberView> {
    await this.resolveManageableProject(context, principal, projectId);

    const role = this.requireInternalRole(body?.role, 'role');
    const expectedRole = this.requireInternalRole(body?.expectedRole, 'expectedRole');

    const membership = await this.resolveMembership(context, projectId, projectMembershipId);

    // Self: a caller may not change their own role through the admin surface.
    if (membership.userId === principal.userId) {
      throw forbidden('cannot_change_own_role');
    }
    // Ceiling: neither the role being assigned nor the member's current role may outrank the
    // caller. The second half stops a caller acting on someone more privileged than themselves.
    if (outranks(role, principal.role) || outranks(membership.role, principal.role)) {
      throw forbidden('role_above_caller_ceiling');
    }
    // Last owner: the final owner seat may not be demoted away.
    if (membership.role === 'owner' && role !== 'owner') {
      await this.assertNotLastOwner(context, projectId);
    }

    try {
      const row = await this.command.changeRole(context, projectMembershipId, expectedRole, role);
      return toView(row);
    } catch (error) {
      throw this.mapCommandError(error);
    }
  }

  /** Remove a member from the project. Idempotent. */
  @Delete(':projectMembershipId')
  @RequireCapability(MANAGE)
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('projectMembershipId') projectMembershipId: string,
  ): Promise<void> {
    await this.resolveManageableProject(context, principal, projectId);

    const membership = await this.resolveMembership(context, projectId, projectMembershipId);

    // Ceiling: a caller may not remove a member more privileged than themselves.
    if (outranks(membership.role, principal.role)) {
      throw forbidden('role_above_caller_ceiling');
    }
    // Last owner: the final owner seat may not be removed.
    if (membership.role === 'owner') {
      await this.assertNotLastOwner(context, projectId);
    }

    await this.command.remove(context, projectMembershipId);
  }

  /**
   * Resolve a project inside this tenant and confirm the caller may manage its members.
   *
   * Tenant-scoped resolution first, then the relation check, both surfacing the same not-found:
   * a caller learns neither which projects exist nor which they are barred from.
   */
  private async resolveManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) throw notFound();

    const permitted = authorize({
      principal,
      capability: MANAGE,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: project.archivedAt ? 'archived' : 'active',
      },
    }).allowed;
    if (!permitted) throw notFound();
  }

  /** Resolve a membership tenant-scoped and confirm it belongs to the named project. */
  private async resolveMembership(
    context: TenantContext,
    projectId: string,
    projectMembershipId: string,
  ): Promise<ProjectMembershipRow> {
    const membership = await this.database.read(context, (runner) =>
      this.projectMemberships.findById(runner, context, projectMembershipId),
    );
    if (!membership || membership.projectId !== projectId) throw notFound();
    return membership;
  }

  /** Refuse the action when the project has exactly one owner. */
  private async assertNotLastOwner(context: TenantContext, projectId: string): Promise<void> {
    const rows = await this.database.read(context, (runner) =>
      this.projectMemberships.listByProject(runner, context, projectId, { limit: 200 }),
    );
    const owners = rows.filter((row) => row.role === 'owner').length;
    if (owners <= 1) throw forbidden('last_owner_seat');
  }

  private requireInternalRole(raw: unknown, field: string): InternalRole {
    if (typeof raw === 'string' && isInternalRole(raw)) return raw;
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be one of the internal roles' },
    ]);
  }

  private mapCommandError(error: unknown): ApiError {
    if (error instanceof ProjectMembershipNotFoundError) return notFound();
    if (error instanceof ProjectMembershipConflictError) {
      return new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'role_conflict');
    }
    if (error instanceof ApiError) return error;
    throw error;
  }
}
