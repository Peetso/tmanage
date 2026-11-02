import { DEFAULT_DAY_END, DEFAULT_DAY_START, isValidTimeZone } from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 53-02: the company's working calendar as the sweep and the weekend hold read it — the org row of
 * `org_working_calendars` (0283) and its holidays — or `null` when the company never saved one,
 * which keeps today's Friday–Saturday rule. Grants: SELECT on both tables (`scripts/db/users.sql`,
 * 0283 block). Bounded: one row, at most 400 holidays (the API's cap; 500 read defensively).
 */
export async function readOrganizationCalendar(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<WorkingCalendar | null> {
  const rows = await tx.query<unknown>(
    `SELECT id, working_days_mask, day_start, day_end, time_zone
       FROM org_working_calendars
      WHERE organization_id = ? AND scope = 'org' AND project_id IS NULL
      LIMIT 1`,
    [organizationId],
  );
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (row === undefined || row === null || typeof row['id'] !== 'string') return null;
  const holidayRows = await tx.query<unknown>(
    `SELECT date FROM org_holidays
      WHERE organization_id = ? AND calendar_id = ?
      ORDER BY date
      LIMIT 500`,
    [organizationId, row['id']],
  );
  const holidays = new Set<string>();
  if (Array.isArray(holidayRows)) {
    for (const holiday of holidayRows as readonly Record<string, unknown>[]) {
      const date = holiday['date'];
      if (typeof date === 'string') holidays.add(date.slice(0, 10));
      else if (date instanceof Date) holidays.add(date.toISOString().slice(0, 10));
    }
  }
  const zone = row['time_zone'];
  return {
    workingDaysMask: Number(row['working_days_mask']),
    dayStart: typeof row['day_start'] === 'string' ? row['day_start'] : DEFAULT_DAY_START,
    dayEnd: typeof row['day_end'] === 'string' ? row['day_end'] : DEFAULT_DAY_END,
    timeZone: typeof zone === 'string' && isValidTimeZone(zone) ? zone : 'UTC',
    holidays,
  };
}
