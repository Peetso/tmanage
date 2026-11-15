import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { calendarDueMirrors, calendarFeedTokens } from '../../common/database/schema.js';
import type { CalendarDueMirrorRow, CalendarFeedTokenRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 0348 (53-14). The due-date mirror rows and the ICS feed tokens. Every tenant query carries
 * `organization_id`; a feed token is read or written only for `context.userId` except on the
 * signed-out feed route, which finds a row by its hash on a bootstrap read.
 */

/** Never more mirrored items per connection than this (a calendar is not a backlog export). */
export const MAX_MIRRORS_PER_CONNECTION = 300;

export class CalendarDueMirrorsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
  ): Promise<readonly CalendarDueMirrorRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(calendarDueMirrors)
      .where(
        and(
          eq(calendarDueMirrors.organizationId, context.organizationId),
          eq(calendarDueMirrors.connectionId, connectionId),
        ),
      )
      .orderBy(asc(calendarDueMirrors.id))
      .limit(MAX_MIRRORS_PER_CONNECTION * 2);
  }

  /** Record (or re-point) the event that mirrors one item's due date. */
  async save(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      connectionId: string;
      workItemId: string;
      externalEventId: string;
      fingerprint: string;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(calendarDueMirrors)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        ...input,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          externalEventId: input.externalEventId,
          fingerprint: input.fingerprint,
          updatedAt: sql`current_timestamp(3)`,
        },
      });
  }

  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(calendarDueMirrors)
      .where(
        and(
          eq(calendarDueMirrors.organizationId, context.organizationId),
          eq(calendarDueMirrors.id, id),
        ),
      );
  }
}

export class CalendarFeedTokensRepository {
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<CalendarFeedTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(calendarFeedTokens)
      .where(
        and(
          eq(calendarFeedTokens.organizationId, context.organizationId),
          eq(calendarFeedTokens.userId, context.userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create the caller's feed token, or replace its hash (rotate): the old address stops at once. */
  async saveOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    tokenHash: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(calendarFeedTokens)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId: context.userId,
        tokenHash,
        createdAt: sql`current_timestamp(3)`,
        lastUsedAt: null,
      })
      .onDuplicateKeyUpdate({
        set: { tokenHash, createdAt: sql`current_timestamp(3)`, lastUsedAt: null },
      });
  }

  async deleteOwn(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .delete(calendarFeedTokens)
      .where(
        and(
          eq(calendarFeedTokens.organizationId, context.organizationId),
          eq(calendarFeedTokens.userId, context.userId),
        ),
      );
  }

  /** The signed-out feed route's bootstrap read: whose feed a token hash opens, nothing more. */
  async findByHash(
    runner: BootstrapQueryRunner,
    tokenHash: string,
  ): Promise<{
    readonly organizationId: string;
    readonly userId: string;
    readonly id: string;
  } | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        organizationId: calendarFeedTokens.organizationId,
        userId: calendarFeedTokens.userId,
        id: calendarFeedTokens.id,
      })
      .from(calendarFeedTokens)
      .where(eq(calendarFeedTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async touch(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(calendarFeedTokens)
      .set({ lastUsedAt: at })
      .where(
        and(
          eq(calendarFeedTokens.organizationId, context.organizationId),
          eq(calendarFeedTokens.id, id),
        ),
      );
  }
}
