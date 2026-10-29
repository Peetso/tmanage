import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * 51-11 — the API half of `email_suppressions` (0252): record that an address hash unsubscribed.
 *
 * GLOBAL (no `organization_id`, in the tenant guard's `NON_TENANT_TABLES`), so it runs through
 * `identityTransaction` like `rate_limit_buckets`. Insert-or-touch: a second click on the same
 * link refreshes `updated_at` and answers the same — one-click must be idempotent (RFC 8058 §3).
 */
const TABLES = ['email_suppressions'] as const;

const UPSERT_SQL = `insert into email_suppressions (address_hash, scope, reason, created_at, updated_at)
  values (?, 'notifications', 'one_click', ?, ?)
  on duplicate key update updated_at = values(updated_at)`;

export interface EmailSuppressionWriter {
  suppress(addressHash: string, correlationId: string, at?: Date): Promise<void>;
}

export class EmailSuppressionsRepository implements EmailSuppressionWriter {
  constructor(private readonly database: TenantDatabase) {}

  async suppress(addressHash: string, correlationId: string, at: Date = new Date()): Promise<void> {
    await this.database.identityTransaction({ correlationId, tables: [...TABLES] }, async (tx) => {
      await tx.query(UPSERT_SQL, [addressHash, at, at]);
    });
  }
}
