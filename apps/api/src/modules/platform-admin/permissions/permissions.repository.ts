import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  clientMemberships,
  customRoles,
  memberships,
  organizations,
  projectMemberships,
  projects,
  users,
} from '../../../common/database/schema.js';
import type { CustomRoleRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../../common/database/tenant-context.js';

/**
 * platform-admin v2 · PA-04 — the reads and writes the platform-side permission editors need on
 * top of PA-01's `membership-overrides.repository.ts` and x195's `role-edit.repository.ts`.
 *
 * Every statement runs on the ordinary tenant path (a service context bound to ONE organization,
 * `policyVersion: 'platform-admin'`) and carries `organization_id = context.organizationId`, so
 * an id from another organization matches nothing — the same isolation a member's request gets.
 *
 * ## Deleting a custom role without DELETE
 *
 * The app credential has no DELETE on `custom_roles` (`scripts/db/users.sql`), and this slice has
 * no migration. A deleted role is therefore *retired*: its holders are moved to the replacement
 * role first, then the row's capabilities are emptied and its name is replaced by a tombstone
 * ({@link DELETED_ROLE_PREFIX} + id), which frees the original name and which every list in this
 * slice filters out. Nobody holds it, and it grants nothing.
 */

/** The name prefix of a retired custom role. A user-typed name never starts with it. */
export const DELETED_ROLE_PREFIX = '†deleted:';

export function isRetiredRoleName(name: string): boolean {
  return name.startsWith(DELETED_ROLE_PREFIX);
}

export interface PermissionsOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface MemberIdentity {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly displayName: string;
  readonly email: string;
  readonly hasOrgWideScope: boolean;
  readonly workspaceScopeId: string | null;
  readonly kind: 'internal' | 'client';
  readonly clientOrganizationId: string | null;
}

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

/** How many projects the "Simulate on project" select offers at most. */
export const PROJECT_OPTIONS_MAX = 100;

export class PlatformPermissionsRepository {
  async organization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<PermissionsOrganization | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /** The organization's live custom roles (retired ones left out), by name. */
  async customRoles(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly CustomRoleRow[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(customRoles)
      .where(eq(customRoles.organizationId, context.organizationId))
      .orderBy(asc(customRoles.name));
    return rows.filter((row) => !isRetiredRoleName(row.name));
  }

  /** Active and invited holders per stored role value (built-in name or custom role id). */
  async internalHolders(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, number>> {
    const rows = await tenantDrizzle(runner)
      .select({ role: memberships.role, holders: sql<number>`count(*)` })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.status, ['active', 'invited']),
          ne(memberships.role, 'platform_support'),
        ),
      )
      .groupBy(memberships.role);
    return new Map(rows.map((row) => [row.role, Number(row.holders)]));
  }

  async clientHolders(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, number>> {
    const rows = await tenantDrizzle(runner)
      .select({ role: clientMemberships.role, holders: sql<number>`count(*)` })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.status, ['active', 'invited']),
        ),
      )
      .groupBy(clientMemberships.role);
    return new Map(rows.map((row) => [row.role, Number(row.holders)]));
  }

  /** Every membership (any status but offboarded) holding one stored role value. */
  async holdersOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    role: string,
  ): Promise<
    readonly { readonly id: string; readonly userId: string; readonly version: number }[]
  > {
    return tenantDrizzle(runner)
      .select({ id: memberships.id, userId: memberships.userId, version: memberships.version })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.role, role),
          ne(memberships.status, 'offboarded'),
        ),
      )
      .orderBy(asc(memberships.id));
  }

  /** Retire a custom role: no capabilities, a tombstone name (see the file comment). */
  async retireRole(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .update(customRoles)
      .set({ name: `${DELETED_ROLE_PREFIX}${id}`, capabilitiesJson: '[]' })
      .where(and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, id)));
  }

  /** The member (internal first, then client contact) with their name and email. */
  async member(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MemberIdentity | undefined> {
    const db = tenantDrizzle(runner);
    const internal = await db
      .select({
        id: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        hasOrgWideScope: memberships.hasOrgWideScope,
        workspaceScopeId: memberships.workspaceScopeId,
        displayName: users.displayName,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
          // TManage support's hidden row is never edited from here.
          ne(memberships.role, 'platform_support'),
        ),
      )
      .limit(1);
    const row = internal[0];
    if (row) return { ...row, kind: 'internal', clientOrganizationId: null };

    const client = await db
      .select({
        id: clientMemberships.id,
        userId: clientMemberships.userId,
        role: clientMemberships.role,
        status: clientMemberships.status,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        displayName: users.displayName,
        email: users.email,
      })
      .from(clientMemberships)
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.id, membershipId),
        ),
      )
      .limit(1);
    const contact = client[0];
    if (!contact) return undefined;
    return {
      ...contact,
      hasOrgWideScope: false,
      workspaceScopeId: null,
      kind: 'client',
    };
  }

  /** The display name of the users who wrote overrides ("by Peter"). */
  async userNames(
    runner: TenantQueryRunner,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /**
   * The projects "Simulate on project" offers: the ones the member is on (or, for an org-wide or
   * workspace member, the organization's projects), by name, at most {@link PROJECT_OPTIONS_MAX}.
   */
  async projectOptions(
    runner: TenantQueryRunner,
    context: TenantContext,
    member: MemberIdentity,
  ): Promise<readonly ProjectOption[]> {
    const db = tenantDrizzle(runner);
    if (member.kind === 'internal' && !member.hasOrgWideScope && member.workspaceScopeId === null) {
      return db
        .select({ id: projects.id, name: projects.name })
        .from(projectMemberships)
        .innerJoin(
          projects,
          and(
            eq(projects.organizationId, projectMemberships.organizationId),
            eq(projects.id, projectMemberships.projectId),
          ),
        )
        .where(
          and(
            eq(projectMemberships.organizationId, context.organizationId),
            eq(projectMemberships.userId, member.userId),
          ),
        )
        .orderBy(asc(projects.name))
        .limit(PROJECT_OPTIONS_MAX);
    }
    const scope =
      member.workspaceScopeId !== null
        ? and(
            eq(projects.organizationId, context.organizationId),
            eq(projects.workspaceId, member.workspaceScopeId),
          )
        : eq(projects.organizationId, context.organizationId);
    return db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(scope)
      .orderBy(asc(projects.name))
      .limit(PROJECT_OPTIONS_MAX);
  }
}
