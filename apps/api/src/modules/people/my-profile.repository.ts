import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberProfiles, memberships, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The repository seam behind `GET/PUT …/me/profile` (t2-b Profile & preferences) — the signed-in
 * member's own name, sign-in email and job title.
 *
 * The name and email live on the person's `users` row (one account across every studio); the job
 * title is tenant-local and lives in `member_profiles.job_title` (0215). Every read starts from the
 * caller's own membership resolved by `(organization_id, id)`, so a membership of another tenant is
 * never found. The writes touch exactly two things: `users.display_name` for the caller's OWN user
 * id (never anybody else's — the controller passes only the resolved own membership's user), and
 * `member_profiles.job_title` for `(organization_id, user_id)`. The email is never written here.
 */

/** The caller's own profile as stored. `jobTitle` is null when no title (or no profile row) exists. */
export interface MyProfileRow {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string | null;
}

export class MyProfileRepository {
  /**
   * Read the caller's own profile: the membership (tenant-scoped) joined to its user for the name and
   * email, and left-joined to this studio's profile row for the job title. `null` when the membership
   * is not in this tenant — the controller turns that into a 404.
   */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MyProfileRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
        email: users.email,
        jobTitle: memberProfiles.jobTitle,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.organizationId, memberships.organizationId),
          eq(memberProfiles.userId, memberships.userId),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, jobTitle: row.jobTitle ?? null };
  }

  /** Set the caller's own display name. `userId` is always the resolved own membership's user. */
  async updateDisplayName(
    runner: TenantQueryRunner,
    userId: string,
    displayName: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(users)
      .set({ displayName, updatedAt: sql`current_timestamp(3)` })
      .where(eq(users.id, userId));
  }

  /**
   * Set the caller's job title in this studio — an upsert on `uq_member_profiles_org_user` that, on
   * the update path, moves ONLY `job_title`, so the admin-edited department, bio and contact fields
   * (x216) are left exactly as they were.
   */
  async upsertJobTitle(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    jobTitle: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(memberProfiles)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId,
        jobTitle,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { jobTitle } });
  }
}
