import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { uploadSessions } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 56-06 (R19-e) — how many uploads one person started since the start of the UTC day.
 *
 * Counted on `upload_sessions` (which carries the opener, `actor_user_id`; `file_versions` does
 * not), over the sessions that still hold or became a file: `reserved`, `completing`, `completed`.
 * A cancelled, expired or failed attempt gives its slot back. One COUNT, tenant-scoped.
 */
export const COUNTED_UPLOAD_STATUSES = ['reserved', 'completing', 'completed'] as const;

/** Midnight UTC of the day `now` falls in. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export class DailyUploadCountRepository {
  async countSince(
    runner: TenantQueryRunner,
    context: TenantContext,
    actorUserId: string,
    since: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ started: sql<number>`count(*)` })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.actorUserId, actorUserId),
          inArray(uploadSessions.status, [...COUNTED_UPLOAD_STATUSES]),
          gte(uploadSessions.createdAt, since),
        ),
      );
    return Number(rows[0]?.started ?? 0);
  }
}
