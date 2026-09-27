import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberProfiles, memberships } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x216's repository seam — the tenant-local member profile (module 14 People & capacity; re-scope of
 * BLOCKED x192). x169 built a read-only projection over memberships/users/projects and had no
 * writable person store; the only editable name field, `users.display_name`, is GLOBAL (the users
 * table carries no `organization_id`), so writing it from an org-scoped route would change how the
 * same person appears in every studio — the exact cross-tenant leak that blocked x192.
 *
 * This service owns `member_profiles` (0094) and nothing else. Every method is tenant-scoped in SQL:
 * the resolve is by `(organization_id, id)`, and the read and the upsert are by `(organization_id,
 * user_id)`, so a cross-tenant row is never touched. It carries NO policy — the `org.manage` route
 * gate and the belt-and-braces relation check live in the controller, and this seam **never** reads
 * or writes the global `users` row.
 */

/** The editable, tenant-local fields of a member's profile — all NULLable, a full replacement on PUT. */
export interface MemberProfileInput {
  readonly department: string | null;
  readonly bio: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

/** The stored profile fields, read back for the view. Absent row → every field null. */
export interface MemberProfileFields {
  readonly department: string | null;
  readonly bio: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

/** The resolved membership — the user it names, within this tenant. No `View` suffix: not a wire projection. */
export interface MemberProfileMemberRow {
  readonly membershipId: string;
  readonly userId: string;
}

export class MemberProfileRepository {
  /**
   * Resolve one membership by id within this tenant, to the user it names. Tenant-scoped by
   * `organization_id` (the Known-trap), so a cross-tenant or unknown id is not found — the
   * controller turns `null` into a 404 that is indistinguishable from the id never existing, before
   * any authorize or write.
   */
  async resolveMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MemberProfileMemberRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({ membershipId: memberships.id, userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Read a member's profile fields in this tenant, keyed by `(organization_id, user_id)`. Returns
   * every field null when no profile row exists yet — a member who has never saved one, which is the
   * common first-read state, not an error.
   */
  async findProfile(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<MemberProfileFields> {
    const rows = await tenantDrizzle(runner)
      .select({
        department: memberProfiles.department,
        bio: memberProfiles.bio,
        contactEmail: memberProfiles.contactEmail,
        contactPhone: memberProfiles.contactPhone,
      })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.organizationId, context.organizationId),
          eq(memberProfiles.userId, userId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return {
      department: row?.department ?? null,
      bio: row?.bio ?? null,
      contactEmail: row?.contactEmail ?? null,
      contactPhone: row?.contactPhone ?? null,
    };
  }

  /**
   * Create or replace a member's profile in this tenant — one `INSERT ... ON DUPLICATE KEY UPDATE`
   * against `uq_member_profiles_org_user`, so two saves racing for one member's row serialise on the
   * unique key rather than on a row this code read first (no lost update). The insert path fills
   * `id` and the create timestamp; the update path moves only the four fields, and `updated_at`
   * follows the column's `ON UPDATE`. Never touches the global `users` row.
   */
  async upsertProfile(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    input: MemberProfileInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(memberProfiles)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId,
        department: input.department,
        bio: input.bio,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          department: input.department,
          bio: input.bio,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
        },
      });
  }
}
