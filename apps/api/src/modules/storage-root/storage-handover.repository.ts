import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, storageConnections, users } from '../../common/database/schema.js';
import type { StorageConnectionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** The two company storage providers a hand-over applies to. */
export type StorageProvider = 'google_drive' | 'onedrive';

/** An active internal member of the acting tenant, with the role the server holds for them. */
export interface HandoverCandidateRow {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
}

/**
 * 51-17. Data access for the storage hand-over. Every query carries the acting tenant's
 * `organization_id`; no id is read from a request without it. `users` is a non-tenant table and
 * is joined by the membership's own user id only.
 */
export class StorageHandoverRepository {
  async findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    provider: StorageProvider,
  ): Promise<StorageConnectionRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.provider, provider),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Active members of this tenant (no hidden platform-support memberships), by name. */
  async listActiveMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly HandoverCandidateRow[]> {
    return tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          isNull(memberships.platformSupportSessionId),
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.userId));
  }

  async findActiveMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<HandoverCandidateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          isNull(memberships.platformSupportSessionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Name the admin who takes the live connection over. */
  async setHandoverTarget(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    toUserId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageConnections)
      .set({ handoverToUserId: toUserId, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.id, connectionId),
          ne(storageConnections.status, 'disconnected'),
        ),
      );
  }
}
