import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { calendarConnections, users } from '../../common/database/schema.js';
import type { CalendarConnectionRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 0237. A person's calendar connections. Every query carries `organization_id`; a person reads and
 * writes only their own row (`user_id = context.userId`) except where a meeting's organizer's
 * connection is looked up to push that meeting, which names the organizer explicitly.
 */

export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionStatus = 'connected' | 'error' | 'disconnected';

export interface ConnectionPatch {
  readonly status?: CalendarConnectionStatus;
  readonly accountEmail?: string | null;
  readonly refreshTokenEnc?: string | null;
  readonly grantedScopes?: string | null;
  readonly syncCursor?: string | null;
  readonly lastErrorCode?: string | null;
  readonly lastSyncedAt?: Date;
  readonly connectedAt?: Date;
  readonly disconnectedAt?: Date | null;
}

/** What the sync job needs to visit a connection under its organization's service context. */
export interface ConnectionRef {
  readonly organizationId: string;
  readonly id: string;
  readonly provider: string;
}

export class GoogleCalendarRepository {
  async findFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    provider: CalendarProvider,
  ): Promise<CalendarConnectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.organizationId, context.organizationId),
          eq(calendarConnections.userId, userId),
          eq(calendarConnections.provider, provider),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
  ): Promise<CalendarConnectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.organizationId, context.organizationId),
          eq(calendarConnections.id, connectionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Connect (or reconnect): one row per (organization, person, provider). */
  async saveConnected(
    runner: TenantQueryRunner,
    context: TenantContext,
    provider: CalendarProvider,
    input: { accountEmail: string | null; refreshTokenEnc: string; grantedScopes: string | null },
  ): Promise<void> {
    const values = {
      status: 'connected',
      accountEmail: input.accountEmail,
      refreshTokenEnc: input.refreshTokenEnc,
      grantedScopes: input.grantedScopes,
      syncCursor: null,
      lastErrorCode: null,
      connectedAt: new Date(),
      disconnectedAt: null,
    };
    await tenantDrizzle(runner)
      .insert(calendarConnections)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId: context.userId,
        provider,
        ...values,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { ...values, updatedAt: sql`current_timestamp(3)` } });
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(calendarConnections)
      .set({ ...patch, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(calendarConnections.organizationId, context.organizationId),
          eq(calendarConnections.id, connectionId),
        ),
      );
  }

  /** A TManage user's sign-in address — what the provider calls them in an attendee list. */
  async userEmail(runner: TenantQueryRunner, userId: string): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.email.toLowerCase() ?? null;
  }

  /**
   * The owners' "Your team's calendars" list: each person's connection per provider, any status.
   * Provider and status only: an owner sees who is connected, never a token or an address.
   */
  async listForOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly { userId: string; provider: string; status: string }[]> {
    return tenantDrizzle(runner)
      .select({
        userId: calendarConnections.userId,
        provider: calendarConnections.provider,
        status: calendarConnections.status,
      })
      .from(calendarConnections)
      .where(eq(calendarConnections.organizationId, context.organizationId))
      .orderBy(asc(calendarConnections.userId), asc(calendarConnections.provider))
      .limit(2000);
  }

  /** The sync job's bootstrap read: every connected connection of the given providers. */
  async connectedAcrossOrganizations(
    runner: BootstrapQueryRunner,
    providers: readonly string[],
  ): Promise<readonly ConnectionRef[]> {
    if (providers.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        organizationId: calendarConnections.organizationId,
        id: calendarConnections.id,
        provider: calendarConnections.provider,
      })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.status, 'connected'),
          inArray(calendarConnections.provider, [...providers]),
        ),
      )
      .orderBy(asc(calendarConnections.organizationId), asc(calendarConnections.id))
      .limit(5000);
  }
}
