import { uuidv7 } from '@tmanage/domain';
import type { QueryRows, TenantDatabase } from '../database/tenant-context.js';
import { growthCheckOf } from './growth-health.js';
import type { GrowthCheckState } from './growth-health.js';

/** GROWTH-FIX. The newest growth rollup's `computed_at`, for `growth-health.ts`. */
export const GROWTH_HEALTH_SQL = 'SELECT MAX(computed_at) AS at FROM platform_growth_rollups';

/** The read on the identity path (`platform_growth_rollups` is registered global). Never throws. */
export async function readGrowthHealth(
  database: TenantDatabase,
  now: Date,
): Promise<GrowthCheckState> {
  try {
    const at = await database.identityRead(
      { correlationId: uuidv7(), tables: ['platform_growth_rollups'] },
      async (runner) => {
        const [row] = await runner.query<QueryRows>(GROWTH_HEALTH_SQL);
        const raw = row?.['at'];
        return raw === null || raw === undefined ? null : new Date(raw as Date | string);
      },
    );
    return growthCheckOf(at, now);
  } catch {
    return 'not_configured';
  }
}
