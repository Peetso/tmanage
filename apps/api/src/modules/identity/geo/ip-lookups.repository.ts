import { and, eq, gte, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  ipLookups,
  type IpLookupRow,
  type IpNetworkKind,
} from '../../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../../common/database/tenant-context.js';

/** How long a cached answer is trusted before the address is looked up again. */
export const IP_LOOKUP_REFRESH_DAYS = 30;

export interface IpLookupValues {
  readonly ip: string;
  readonly countryCode: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly asn: number | null;
  readonly networkOwner: string | null;
  readonly networkKind: IpNetworkKind;
  readonly isTor: boolean;
  readonly vpnOrProxy: 'likely' | 'unknown';
  readonly source: string | null;
}

/** R12 (0280). The global IP cache. Times come from the database clock, never the process. */
export class IpLookupsRepository {
  async find(runner: IdentityQueryRunner, ip: string): Promise<IpLookupRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(ipLookups)
      .where(eq(ipLookups.ip, ip))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Bump `last_seen_at` of a fresh row. `false` when there is no row, or it is due a refresh. */
  async touchIfFresh(runner: IdentityQueryRunner, ip: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(ipLookups)
      .set({ lastSeenAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(ipLookups.ip, ip),
          gte(
            ipLookups.lookedUpAt,
            sql`date_sub(current_timestamp(3), interval ${IP_LOOKUP_REFRESH_DAYS} day)`,
          ),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** Write a fresh lookup (new address, or one due a refresh). */
  async upsert(runner: IdentityQueryRunner, values: IpLookupValues): Promise<void> {
    const { ip, ...fields } = values;
    const now = sql`current_timestamp(3)`;
    await tenantDrizzle(runner)
      .insert(ipLookups)
      .values({ ip, ...fields, lookedUpAt: now, lastSeenAt: now })
      .onDuplicateKeyUpdate({ set: { ...fields, lookedUpAt: now, lastSeenAt: now } });
  }
}
