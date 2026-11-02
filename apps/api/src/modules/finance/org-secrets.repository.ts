import { and, count, desc, eq, gte } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEvents, orgSecrets } from '../../common/database/schema.js';
import type { OrgSecretRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-12 (R22-a) — storage for `org_secrets` (0313). Every statement carries the `organization_id`
 * predicate. Only {@link findActive} returns the `ciphertext`; the meta reads leave it out, so a
 * caller that only shows a certificate's status never holds the envelope. No DELETE: a replaced
 * secret is `rotated`, a removed one `revoked`.
 */

export type OrgSecretMetaRow = Omit<OrgSecretRow, 'ciphertext'>;

const META_COLUMNS = {
  id: orgSecrets.id,
  organizationId: orgSecrets.organizationId,
  secretKey: orgSecrets.secretKey,
  keyVersion: orgSecrets.keyVersion,
  metaJson: orgSecrets.metaJson,
  status: orgSecrets.status,
  createdBy: orgSecrets.createdBy,
  createdAt: orgSecrets.createdAt,
  rotatedAt: orgSecrets.rotatedAt,
};

export class OrgSecretsRepository {
  /** The active secret of a kind, with its envelope; `forUpdate` inside a replacing transaction. */
  async findActive(
    runner: TenantQueryRunner,
    organizationId: string,
    secretKey: string,
    forUpdate = false,
  ): Promise<OrgSecretRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(orgSecrets)
      .where(
        and(
          eq(orgSecrets.organizationId, organizationId),
          eq(orgSecrets.secretKey, secretKey),
          eq(orgSecrets.status, 'active'),
        ),
      )
      .orderBy(desc(orgSecrets.createdAt))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insert(runner: TenantQueryRunner, row: OrgSecretRow): Promise<void> {
    await tenantDrizzle(runner).insert(orgSecrets).values(row);
  }

  /** `rotated` (replaced, kept for old documents) or `revoked` (removed by a person). */
  async markStatus(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    status: 'rotated' | 'revoked',
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(orgSecrets)
      .set({ status, rotatedAt: at })
      .where(and(eq(orgSecrets.organizationId, organizationId), eq(orgSecrets.id, id)));
  }

  /** Every secret of a kind, newest first, without envelopes (few rows: one per replacement). */
  async listMeta(
    runner: TenantQueryRunner,
    organizationId: string,
    secretKey: string,
  ): Promise<readonly OrgSecretMetaRow[]> {
    return tenantDrizzle(runner)
      .select(META_COLUMNS)
      .from(orgSecrets)
      .where(
        and(eq(orgSecrets.organizationId, organizationId), eq(orgSecrets.secretKey, secretKey)),
      )
      .orderBy(desc(orgSecrets.createdAt));
  }

  /** The secret whose certificate has this SHA-256 fingerprint, any status; meta only. */
  async findByFingerprint(
    runner: TenantQueryRunner,
    organizationId: string,
    secretKey: string,
    fingerprint: string,
  ): Promise<OrgSecretMetaRow | null> {
    const rows = await this.listMeta(runner, organizationId, secretKey);
    return (
      rows.find((row) => {
        try {
          return (
            (JSON.parse(row.metaJson) as { fingerprint256?: unknown }).fingerprint256 ===
            fingerprint
          );
        } catch {
          return false;
        }
      }) ?? null
    );
  }

  /** How many `client_invoice.sign_failed` audit rows the organization has since `since`. */
  async signFailuresSince(
    runner: TenantQueryRunner,
    organizationId: string,
    since: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, organizationId),
          eq(auditEvents.action, 'client_invoice.sign_failed'),
          gte(auditEvents.createdAt, since),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}
