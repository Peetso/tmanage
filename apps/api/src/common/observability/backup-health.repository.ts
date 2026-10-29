import { uuidv7 } from '@tmanage/domain';
import type { QueryRows, TenantDatabase } from '../database/tenant-context.js';
import { evaluateBackupHealth } from './backup-health.js';
import type { BackupCheckState } from './backup-health.js';

/**
 * The read: the last few successful non-drill runs on the identity path (`platform_backup_runs`
 * is registered global in `tenant-guard.ts`; the runtime user may SELECT it). Never throws:
 * an unreadable table is `not_configured` (the migrations check reports a schema that did not land).
 */
export async function readBackupHealth(
  database: TenantDatabase,
  now: Date,
  options: { readonly sixHourly?: boolean } = {},
): Promise<BackupCheckState> {
  try {
    const runs = await database.identityRead(
      { correlationId: uuidv7(), tables: ['platform_backup_runs'] },
      async (runner) => {
        const rows = await runner.query<QueryRows>(
          "SELECT finished_at, offsite_status, offsite_at FROM platform_backup_runs WHERE status = 'ok' AND kind <> 'drill' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 8",
        );
        return rows.map((r) => ({
          finishedAt: new Date(r['finished_at'] as Date | string),
          offsiteStatus: String(r['offsite_status']),
          offsiteAt: r['offsite_at'] === null ? null : new Date(r['offsite_at'] as Date | string),
        }));
      },
    );
    return evaluateBackupHealth(runs, now, options);
  } catch {
    return 'not_configured';
  }
}
