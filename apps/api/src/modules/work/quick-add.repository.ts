import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  orgFinanceProfiles,
  projectMemberships,
  projects,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 55-25 — the reads behind quick-add's candidate lookup. No table of its own, no write.
 *
 * - **People** are the directory's rows (`PeopleDirectoryRepository.list`): active memberships of
 *   this organization joined to the global `users` row, the hidden Support-mode role excluded.
 *   With a project they are narrowed to that project's members through `project_memberships`,
 *   whose join is tied to the same `organization_id`.
 * - **Projects** are this organization's unarchived projects; the service keeps only the ones the
 *   caller may read (`work.read`, as `ProjectsService.list` does).
 * - **Digits** is `org_finance_profiles.digits` (`latn` when the organization has no profile).
 *
 * Every statement binds `organization_id` from the context. Bounded: a quick-add line names a
 * person or project by prefix, and the Arabic-aware match (tashkeel, hamza forms, ة/ه) runs in the
 * domain, so the rows are read once and capped rather than `LIKE`-filtered in SQL.
 */

export const QUICK_ADD_MAX_PEOPLE = 2000;
export const QUICK_ADD_MAX_PROJECTS = 1000;

export interface QuickAddPersonRow {
  readonly userId: string;
  readonly displayName: string;
}

export interface QuickAddProjectRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

export class QuickAddRepository {
  /** Active members by name; only `projectId`'s members when one is given. */
  async listPeople(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string | null,
  ): Promise<readonly QuickAddPersonRow[]> {
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(memberships.organizationId, context.organizationId),
      inArray(memberships.status, ['active']),
      ne(memberships.role, PLATFORM_SUPPORT_ROLE),
    ];
    if (projectId === null) {
      return db
        .select({ userId: memberships.userId, displayName: users.displayName })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(...predicates))
        .orderBy(asc(memberships.id))
        .limit(QUICK_ADD_MAX_PEOPLE);
    }
    return db
      .select({ userId: memberships.userId, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.organizationId, memberships.organizationId),
          eq(projectMemberships.userId, memberships.userId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .where(and(...predicates))
      .orderBy(asc(memberships.id))
      .limit(QUICK_ADD_MAX_PEOPLE);
  }

  /** This organization's unarchived projects (the service filters to the readable ones). */
  async listProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly QuickAddProjectRow[]> {
    return tenantDrizzle(runner)
      .select({ id: projects.id, organizationId: projects.organizationId, name: projects.name })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), isNull(projects.archivedAt)))
      .orderBy(asc(projects.id))
      .limit(QUICK_ADD_MAX_PROJECTS);
  }

  /** `latn` or `arab`, from the finance profile; `latn` without one. */
  async digits(runner: TenantQueryRunner, context: TenantContext): Promise<'latn' | 'arab'> {
    const rows = await tenantDrizzle(runner)
      .select({ digits: orgFinanceProfiles.digits })
      .from(orgFinanceProfiles)
      .where(eq(orgFinanceProfiles.organizationId, context.organizationId))
      .limit(1);
    return rows[0]?.digits === 'arab' ? 'arab' : 'latn';
  }
}
