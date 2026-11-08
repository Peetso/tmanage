import { and, eq, inArray, isNull, like, ne, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, users, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';

/** Descriptions read per project to find earlier imports; a bigger project is an outlier. */
export const MAX_MARKER_ROWS = 20_000;

/**
 * R45 L3 (54-25). The reads the token import needs beyond the shared repositories. Every
 * statement carries the tenant predicate; `organization_id` comes from the context.
 */
export class PmImportRepository {
  /** Descriptions in the project that carry an import provenance line (soft-deleted ones excluded). */
  async importedDescriptions(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly (string | null)[]> {
    const rows = await tenantDrizzle(runner)
      .select({ description: workItems.description })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
          or(
            like(workItems.description, '%Imported from Trello: https://trello.com/c/%'),
            like(workItems.description, '%Imported from Asana: https://app.asana.com/0/%'),
          ),
        ),
      )
      .limit(MAX_MARKER_ROWS);
    return rows.map((row) => row.description);
  }

  /**
   * Active members whose sign-in e-mail is exactly one of `emails` (lower-cased). Only the user id
   * comes back, keyed by the address the caller already holds: no address list is disclosed.
   */
  async activeUserIdsByEmail(
    runner: TenantQueryRunner,
    context: TenantContext,
    emails: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (emails.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE),
          inArray(users.email, [...emails].slice(0, 500)),
        ),
      )
      .limit(500);
    const wanted = new Set(emails);
    const found = new Map<string, string>();
    for (const row of rows) {
      const email = row.email.toLowerCase();
      if (wanted.has(email)) found.set(email, row.userId);
    }
    return found;
  }

  /** Which of `userIds` are active members of this organization. */
  async activeUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE),
          inArray(memberships.userId, [...userIds].slice(0, 500)),
        ),
      );
    return new Set(rows.map((row) => row.userId));
  }
}
