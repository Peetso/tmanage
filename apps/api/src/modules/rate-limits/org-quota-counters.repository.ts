import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { QuotaCounterStore } from './org-quotas.js';

/**
 * 56-05 — the MariaDB half of the daily org quotas: `org_quota_counters` (0250).
 *
 * Tenant-owned (`organization_id`, in `TENANT_TABLES`): every statement binds the acting
 * organization, so one studio's counter can never be read or charged by another. One row per
 * organization × metric × UTC day, unique on `(organization_id, metric_key, day_utc)`.
 *
 * Charge-then-check in one transaction: the upsert adds `amount` under the row lock, the read-back
 * sees the result, and a total over the limit rolls the whole transaction back — a refused call
 * spends nothing, and concurrent callers serialise on the unique key rather than on a value one of
 * them read first. Server clock for the stamps (`current_timestamp(3)`), as the identity writers.
 */
const CHARGE_SQL = `insert into org_quota_counters
    (id, organization_id, metric_key, day_utc, used_count, created_at, updated_at)
  values (?, ?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
  on duplicate key update
    used_count = used_count + values(used_count),
    updated_at = current_timestamp(3)`;

const READ_SQL = `select used_count from org_quota_counters
  where organization_id = ? and metric_key = ? and day_utc = ?`;

class RefusedQuota extends Error {
  constructor(readonly used: number) {
    super('quota refused');
  }
}

export class OrgQuotaCountersRepository implements QuotaCounterStore {
  constructor(private readonly database: TenantDatabase) {}

  async charge(
    input: Parameters<QuotaCounterStore['charge']>[0],
  ): ReturnType<QuotaCounterStore['charge']> {
    const { context, metric, day, amount, limit } = input;
    try {
      return await this.database.transaction(context, async (tx) => {
        await tx.execute(CHARGE_SQL, [uuidv7(), context.organizationId, metric, day, amount]);
        const rows = await tx.execute<RowDataPacket[]>(READ_SQL, [
          context.organizationId,
          metric,
          day,
        ]);
        const used = Number(rows[0]?.['used_count'] ?? amount);
        if (used > limit) throw new RefusedQuota(used - amount);
        return { admitted: true, used };
      });
    } catch (error) {
      if (error instanceof RefusedQuota) return { admitted: false, used: error.used };
      throw error;
    }
  }
}
