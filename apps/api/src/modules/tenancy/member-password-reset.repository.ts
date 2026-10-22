import { and, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, users } from '../../common/database/schema.js';
import type { MembershipStatus } from './memberships.repository.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** The member an organization admin is about to send a reset link to. */
export interface ResetMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly status: MembershipStatus;
  /** The sign-in address the link goes to. Never returned to the admin. */
  readonly email: string;
}

/**
 * Q4 — the one read the org-admin reset needs: a membership **in the acting tenant** with its
 * person's sign-in address. Scoped by `(organization_id, id)`, so a membership id from another
 * organization reads exactly like an unknown one. A repository of its own because
 * `MembershipsRepository.listWithNames` deliberately never projects `users.email`.
 */
export class MemberPasswordResetRepository {
  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<ResetMember | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        status: memberships.status,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
