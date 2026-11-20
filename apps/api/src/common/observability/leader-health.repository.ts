import { uuidv7 } from '@tmanage/domain';
import type { QueryRows, TenantDatabase } from '../database/tenant-context.js';
import { leaderCheckOf } from './leader-health.js';
import type { LeaderCheck } from './leader-health.js';

/** DC-3. The leader lease row, for `leader-health.ts`. Bound name, no server clock. */
export const LEADER_HEALTH_SQL =
  'SELECT holder, expires_at FROM runtime_leases WHERE name = ? LIMIT 1';

/** The read on the identity path (`runtime_leases` is registered global). Never throws. */
export async function readLeaderHealth(database: TenantDatabase, now: Date): Promise<LeaderCheck> {
  try {
    const row = await database.identityRead(
      { correlationId: uuidv7(), tables: ['runtime_leases'] },
      async (runner) => {
        const [found] = await runner.query<QueryRows>(LEADER_HEALTH_SQL, ['leader']);
        if (found === undefined) return null;
        const expires = found['expires_at'];
        return {
          holder: String(found['holder'] ?? ''),
          expiresAt: expires instanceof Date ? expires : new Date(String(expires)),
        };
      },
    );
    return leaderCheckOf(row, now);
  } catch {
    return { state: 'not_configured' };
  }
}
