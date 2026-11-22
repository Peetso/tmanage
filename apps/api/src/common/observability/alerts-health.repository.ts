import { uuidv7 } from '@tmanage/domain';
import type { QueryRows, TenantDatabase } from '../database/tenant-context.js';
import { RECENT_NONE_MS } from './alerts-health.js';
import type { AlertsReading } from './alerts-health.js';

/**
 * SEC-ALERTS — the read behind the `alerts` check (`alerts-health.ts`): the oldest pending
 * security signal and whether one was marked `none` lately. `security_signals` is a tenant table
 * read across organizations, so it rides `bootstrapRead` with an audited reason (the
 * `security-signals.repository.ts` precedent). Aggregates only; no row data leaves.
 */
const REASON =
  'healthz alerts check: the oldest pending security signal and recent unmailed ones, no row data';

/** Never throws; null = unreadable. */
export async function readAlertsHealth(
  database: TenantDatabase,
  now: Date,
): Promise<AlertsReading | null> {
  try {
    return await database.bootstrapRead(
      { correlationId: uuidv7(), reason: REASON, tables: ['security_signals'] },
      async (runner) => {
        const pending = await runner.query<QueryRows>(
          "select min(first_seen) as at from security_signals where notify_status = 'pending'",
        );
        const none = await runner.query<QueryRows>(
          "select 1 as hit from security_signals where notify_status = 'none' and notified_at >= ? limit 1",
          [new Date(now.getTime() - RECENT_NONE_MS)],
        );
        const at = pending[0]?.['at'];
        return {
          oldestPending: at === null || at === undefined ? null : new Date(at as Date | string),
          recentNone: none.length > 0,
        };
      },
    );
  } catch {
    return null;
  }
}
