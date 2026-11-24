import {
  parseAiEmployeePauseReason,
  parseAiEmployeeStatus,
  parseMembershipKind,
  type AiEmployeePauseReason,
  type AiEmployeeStatus,
  type MembershipKind,
} from '@tmanage/domain';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  aiEmployees,
  aiExcludedProjects,
  memberships,
  organizations,
  projectClients,
  projectMemberships,
  projects,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 60-03 (0399) — `ai_employees`, read beside the membership and user rows of the same bounded
 * context (Tenancy & People, VIEWS §4). Bound SQL only (DA-3); the organization comes from the
 * verified context on every tenant table of every statement (DA-12); times are bound by the
 * service (DA-10). Edits are conditional on `version` (DA-1, lost update).
 */

/** One AI employee as the service reads it: the companion row with its member and sponsor. */
export interface AiEmployeeRecord {
  readonly id: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly membershipStatus: string;
  readonly sponsorMembershipId: string;
  readonly sponsorDisplayName: string | null;
  readonly createdByMembershipId: string;
  readonly jobTitle: string;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly status: AiEmployeeStatus;
  readonly pausedReason: AiEmployeePauseReason | null;
  readonly pausedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly timezone: string;
  readonly workingHoursJson: string | null;
  readonly limitsJson: string | null;
  readonly discloseToClients: boolean;
  /** 60-07: the task type keys it may be given (JSON list), NULL = none chosen yet. */
  readonly allowedTaskTypesJson: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 60-07: a project as the hire and profile need it (its boundary, plan §4.6 rule 6). */
export interface AiProjectFacts {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** The project has a client company (`project_clients`). */
  readonly isClient: boolean;
}

/** A membership of this workspace as a sponsor check needs it. */
export interface MemberFacts {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  /** `null` when the stored kind cannot be read (refused everywhere). */
  readonly kind: MembershipKind | null;
}

/**
 * 60-06: what the agent gate needs about the AI employee behind a credential, read on every agent
 * call by the one unique key `(organization_id, membership_id)`. No joins: the gate runs on every
 * bound-token request, and a person's token answers `null` here at the cost of one index probe.
 */
export interface AiEmployeeStamp {
  readonly id: string;
  readonly membershipId: string;
  readonly sponsorMembershipId: string;
  readonly status: AiEmployeeStatus | null;
  readonly timezone: string;
  readonly workingHoursJson: string | null;
  readonly limitsJson: string | null;
  readonly allowedTaskTypesJson: string | null;
}

/** One project the workspace keeps away from AI employees (0402). */
export interface ExcludedProjectRecord {
  readonly projectId: string;
  readonly name: string;
  readonly setByMembershipId: string;
  readonly createdAt: Date;
}

export interface NewAiEmployee {
  readonly id: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly sponsorMembershipId: string;
  readonly createdByMembershipId: string;
  readonly jobTitle: string;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly timezone: string;
  readonly workingHoursJson: string | null;
  readonly limitsJson: string;
  readonly discloseToClients: boolean;
  readonly allowedTaskTypesJson: string | null;
  readonly at: Date;
}

/** The columns an edit may set. Absent = unchanged. */
export interface AiEmployeeChange {
  readonly jobTitle?: string;
  readonly departmentKey?: string | null;
  readonly vendorLabel?: string | null;
  readonly modelLabel?: string | null;
  readonly timezone?: string;
  readonly workingHoursJson?: string | null;
  readonly limitsJson?: string;
  readonly discloseToClients?: boolean;
  readonly allowedTaskTypesJson?: string | null;
  readonly sponsorMembershipId?: string;
  readonly status?: AiEmployeeStatus;
  readonly pausedReason?: AiEmployeePauseReason | null;
  readonly pausedAt?: Date | null;
  readonly retiredAt?: Date;
  readonly retiredByMembershipId?: string;
}

export class AiEmployeesRepository {
  /**
   * DA-1 (write skew on "at most N AI employees" and "one live name"): every hire takes the
   * organization row `FOR UPDATE` first, so two hires in one workspace run one after the other
   * and the count and the name check each see the other's row. One lock, always taken first.
   */
  async lockOrganization(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .for('update');
  }

  /**
   * DA-1 (write skew on "at most 3 live credentials"): a key create or rotate takes the AI
   * employee's row `FOR UPDATE` first, so two creates for one AI employee run one after the
   * other and each count sees the other's key. `false` when the id is not this workspace's.
   */
  async lockById(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: aiEmployees.id })
      .from(aiEmployees)
      .where(and(eq(aiEmployees.organizationId, context.organizationId), eq(aiEmployees.id, id)))
      .for('update');
    return rows.length > 0;
  }

  /** AI employees that are not retired (the beta cap counts these). */
  async countLive(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(aiEmployees)
      .where(
        and(
          eq(aiEmployees.organizationId, context.organizationId),
          ne(aiEmployees.status, 'retired'),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Is this display name already used by an AI employee that is not retired (any case)? */
  async liveNameTaken(
    runner: TenantQueryRunner,
    context: TenantContext,
    displayName: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: aiEmployees.id })
      .from(aiEmployees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, aiEmployees.organizationId),
          eq(memberships.id, aiEmployees.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(aiEmployees.organizationId, context.organizationId),
          eq(memberships.organizationId, context.organizationId),
          ne(aiEmployees.status, 'retired'),
          sql`lower(${users.displayName}) = lower(${displayName})`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MemberFacts | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        kind: memberships.kind,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, kind: parseMembershipKind(row.kind) };
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: NewAiEmployee,
  ): Promise<void> {
    await tenantDrizzle(runner).insert(aiEmployees).values({
      id: row.id,
      organizationId: context.organizationId,
      membershipId: row.membershipId,
      userId: row.userId,
      sponsorMembershipId: row.sponsorMembershipId,
      createdByMembershipId: row.createdByMembershipId,
      jobTitle: row.jobTitle,
      departmentKey: row.departmentKey,
      vendorLabel: row.vendorLabel,
      modelLabel: row.modelLabel,
      status: 'active',
      pausedReason: null,
      pausedAt: null,
      retiredAt: null,
      retiredByMembershipId: null,
      allowedTaskTypesJson: row.allowedTaskTypesJson,
      timezone: row.timezone,
      workingHoursJson: row.workingHoursJson,
      limitsJson: row.limitsJson,
      discloseToClients: row.discloseToClients,
      version: 1,
      createdAt: row.at,
      updatedAt: row.at,
    });
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AiEmployeeRecord[]> {
    return this.select(runner, context, null);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord | null> {
    const rows = await this.select(runner, context, id);
    return rows[0] ?? null;
  }

  /** A conditional edit: `true` when the row at `expectedVersion` was changed, else `false`. */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    expectedVersion: number,
    change: AiEmployeeChange,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(aiEmployees)
      .set({ ...change, version: sql`${aiEmployees.version} + 1`, updatedAt: at })
      .where(
        and(
          eq(aiEmployees.organizationId, context.organizationId),
          eq(aiEmployees.id, id),
          eq(aiEmployees.version, expectedVersion),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /**
   * 60-04 offboarding rule (plan 60 v2 §4.5): when a person leaves, every active AI employee they
   * sponsor is paused with reason `sponsor_left`, in the offboarding transaction. A paused one
   * stays paused (its first reason stands); resuming needs a new, active sponsor. Returns how many
   * were paused, for the offboarding audit row.
   */
  async pauseForSponsor(
    runner: TenantQueryRunner,
    context: TenantContext,
    sponsorMembershipId: string,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(aiEmployees)
      .set({
        status: 'paused',
        pausedReason: 'sponsor_left',
        pausedAt: at,
        version: sql`${aiEmployees.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(aiEmployees.organizationId, context.organizationId),
          eq(aiEmployees.sponsorMembershipId, sponsorMembershipId),
          eq(aiEmployees.status, 'active'),
        ),
      );
    return result[0].affectedRows;
  }

  private async select(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string | null,
  ): Promise<readonly AiEmployeeRecord[]> {
    const predicates = [
      eq(aiEmployees.organizationId, context.organizationId),
      eq(memberships.organizationId, context.organizationId),
    ];
    if (id !== null) predicates.push(eq(aiEmployees.id, id));
    const rows = await tenantDrizzle(runner)
      .select({
        id: aiEmployees.id,
        membershipId: aiEmployees.membershipId,
        userId: aiEmployees.userId,
        displayName: users.displayName,
        role: memberships.role,
        membershipStatus: memberships.status,
        sponsorMembershipId: aiEmployees.sponsorMembershipId,
        createdByMembershipId: aiEmployees.createdByMembershipId,
        jobTitle: aiEmployees.jobTitle,
        departmentKey: aiEmployees.departmentKey,
        vendorLabel: aiEmployees.vendorLabel,
        modelLabel: aiEmployees.modelLabel,
        status: aiEmployees.status,
        pausedReason: aiEmployees.pausedReason,
        pausedAt: aiEmployees.pausedAt,
        retiredAt: aiEmployees.retiredAt,
        timezone: aiEmployees.timezone,
        workingHoursJson: aiEmployees.workingHoursJson,
        limitsJson: aiEmployees.limitsJson,
        discloseToClients: aiEmployees.discloseToClients,
        allowedTaskTypesJson: aiEmployees.allowedTaskTypesJson,
        version: aiEmployees.version,
        createdAt: aiEmployees.createdAt,
        updatedAt: aiEmployees.updatedAt,
      })
      .from(aiEmployees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, aiEmployees.organizationId),
          eq(memberships.id, aiEmployees.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(...predicates))
      .orderBy(asc(aiEmployees.createdAt), asc(aiEmployees.id));
    const sponsors = await this.displayNames(runner, context, [
      ...new Set(rows.map((row) => row.sponsorMembershipId)),
    ]);
    const out: AiEmployeeRecord[] = [];
    for (const row of rows) {
      const status = parseAiEmployeeStatus(row.status);
      // A row whose status cannot be read is a defect, not "active": it is left out (deny).
      if (status === null) continue;
      out.push({
        ...row,
        status,
        pausedReason: parseAiEmployeePauseReason(row.pausedReason),
        sponsorDisplayName: sponsors.get(row.sponsorMembershipId) ?? null,
      });
    }
    return out;
  }

  /** The display name of each membership id of this workspace (a second read, no alias joins). */
  /** 60-06: the AI employee behind a membership, or `null` (a person's membership). */
  async findStampByMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<AiEmployeeStamp | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: aiEmployees.id,
        membershipId: aiEmployees.membershipId,
        sponsorMembershipId: aiEmployees.sponsorMembershipId,
        status: aiEmployees.status,
        timezone: aiEmployees.timezone,
        workingHoursJson: aiEmployees.workingHoursJson,
        limitsJson: aiEmployees.limitsJson,
        allowedTaskTypesJson: aiEmployees.allowedTaskTypesJson,
      })
      .from(aiEmployees)
      .where(
        and(
          eq(aiEmployees.organizationId, context.organizationId),
          eq(aiEmployees.membershipId, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, status: parseAiEmployeeStatus(row.status) };
  }

  /** 60-06 (M5, 0402): the projects the workspace keeps away from AI employees. */
  async excludedProjectIds(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: aiExcludedProjects.projectId })
      .from(aiExcludedProjects)
      .where(eq(aiExcludedProjects.organizationId, context.organizationId));
    return rows.map((row) => row.projectId);
  }

  /** Project exclusion (M5): the excluded projects with their names, by name. */
  async listExcludedProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ExcludedProjectRecord[]> {
    return tenantDrizzle(runner)
      .select({
        projectId: aiExcludedProjects.projectId,
        name: projects.name,
        setByMembershipId: aiExcludedProjects.setByMembershipId,
        createdAt: aiExcludedProjects.createdAt,
      })
      .from(aiExcludedProjects)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, aiExcludedProjects.organizationId),
          eq(projects.id, aiExcludedProjects.projectId),
        ),
      )
      .where(eq(aiExcludedProjects.organizationId, context.organizationId))
      .orderBy(asc(projects.name), asc(projects.id));
  }

  /** Whether the project is one of this workspace's (any status: an archived one may stay excluded). */
  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  async isProjectExcluded(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: aiExcludedProjects.projectId })
      .from(aiExcludedProjects)
      .where(
        and(
          eq(aiExcludedProjects.organizationId, context.organizationId),
          eq(aiExcludedProjects.projectId, projectId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Insert-only (the grant is INSERT, DELETE): the caller checked it is not there under a lock. */
  async excludeProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    setByMembershipId: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner).insert(aiExcludedProjects).values({
      organizationId: context.organizationId,
      projectId,
      setByMembershipId,
      createdAt: at,
    });
  }

  /** `true` when a row was removed. */
  async includeProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(aiExcludedProjects)
      .where(
        and(
          eq(aiExcludedProjects.organizationId, context.organizationId),
          eq(aiExcludedProjects.projectId, projectId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** 60-06: id and name of the given projects of this workspace, in name order. */
  async projectNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly { id: string; name: string }[]> {
    if (projectIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          inArray(projects.id, [...projectIds]),
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
  }

  /** 60-07: the named projects of this workspace, each with whether it has a client company. */
  async projectFacts(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly AiProjectFacts[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          inArray(projects.id, [...projectIds]),
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
    const clients = new Set(await this.clientProjectIds(runner, context, projectIds));
    return rows.map((row) => ({ ...row, isClient: clients.has(row.id) }));
  }

  /**
   * 60-07: the projects with a client company — of `among`, or of the whole workspace when it is
   * omitted (the agent gate's "only internal projects" rule).
   */
  async clientProjectIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    among?: readonly string[],
  ): Promise<readonly string[]> {
    if (among !== undefined && among.length === 0) return [];
    const predicates = [eq(projectClients.organizationId, context.organizationId)];
    if (among !== undefined) predicates.push(inArray(projectClients.projectId, [...among]));
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ projectId: projectClients.projectId })
      .from(projectClients)
      .where(and(...predicates));
    return rows.map((row) => row.projectId);
  }

  /**
   * 60-07: each AI employee's projects (its `project_memberships`), keyed by user id, in one read
   * for the whole list (never one per row).
   */
  async projectsOfUsers(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AiProjectFacts[]>> {
    const out = new Map<string, AiProjectFacts[]>();
    if (userIds.length === 0) return out;
    const rows = await tenantDrizzle(runner)
      .select({
        userId: projectMemberships.userId,
        id: projects.id,
        name: projects.name,
        status: projects.status,
      })
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
          inArray(projectMemberships.userId, [...userIds]),
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
    const clients = new Set(
      await this.clientProjectIds(runner, context, [...new Set(rows.map((row) => row.id))]),
    );
    for (const row of rows) {
      const list = out.get(row.userId) ?? [];
      list.push({ id: row.id, name: row.name, status: row.status, isClient: clients.has(row.id) });
      out.set(row.userId, list);
    }
    return out;
  }

  private async displayNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (membershipIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ membershipId: memberships.id, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.id, [...membershipIds]),
        ),
      );
    return new Map(rows.map((row) => [row.membershipId, row.displayName] as const));
  }
}
