import type { WorkerTransaction } from './worker-database.js';

/**
 * Gap 10: the company's own clock. `organizations.timezone` (an IANA zone the settings page
 * validates) is what "Friday", "Saturday" and "Sunday morning" mean for a rule that skips weekends.
 * A missing row or an unreadable value reads as UTC, the column's default. Grant: SELECT on
 * `organizations` (scripts/db/users.sql).
 */
export async function findOrganizationTimeZone(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<string> {
  const rows = await tx.query<unknown>('SELECT timezone FROM organizations WHERE id = ? LIMIT 1', [
    organizationId,
  ]);
  if (!Array.isArray(rows)) return 'UTC';
  const first: unknown = rows[0];
  if (first === null || typeof first !== 'object') return 'UTC';
  const zone = (first as Record<string, unknown>)['timezone'];
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}
