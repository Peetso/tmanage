import { parseMembershipKind } from '@tmanage/domain';
import type { MembershipKind } from '@tmanage/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 60-08 (plan 60 v2 §4.7) — the one read the Work AI-people gate needs from the database:
 * whether each named member is a person or an AI employee. Tenant-scoped and bound.
 */
/** The facts the gate reads: each person's membership kind (active members only). */
export class WorkAiPeopleRepository {
  async kinds(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, { readonly membershipId: string; readonly kind: MembershipKind | null }>
  > {
    if (userIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: memberships.id, userId: memberships.userId, kind: memberships.kind })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.userId, [...userIds]),
          eq(memberships.status, 'active'),
        ),
      );
    return new Map(
      rows.map((row) => [
        row.userId,
        { membershipId: row.id, kind: parseMembershipKind(row.kind) },
      ]),
    );
  }
}
