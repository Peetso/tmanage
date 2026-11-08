import type { ApiClient } from './client';

/**
 * 56-11 — the audit chain's integrity check. `GET .../admin/audit/integrity`, behind `audit.read`
 * plus organization-wide scope (an own-activity reader is refused with 403).
 *
 * Mirrors the API's `AuditIntegrityReport`, narrowed to what the screen shows: the verdict, how
 * many entries were checked, and the first entry that does not verify. The server never returns
 * a broken row's content, only its id and chain position, so neither does this.
 */
export type AuditIntegrityStatus = 'intact' | 'broken' | 'not_started';

export interface AuditChainBreak {
  readonly reason:
    | 'missing_row'
    | 'prev_hash_mismatch'
    | 'row_hash_mismatch'
    | 'head_mismatch'
    | 'anchor_mismatch';
  readonly eventId: string | null;
  readonly chainSeq: number;
}

export interface AuditIntegrityReport {
  readonly status: AuditIntegrityStatus;
  /** False when the walk hit the server's cap before the head. */
  readonly complete: boolean;
  readonly checkedEvents: number;
  readonly firstBreak: AuditChainBreak | null;
}

export async function checkAuditIntegrity(
  client: ApiClient,
  organizationSlug: string,
): Promise<AuditIntegrityReport> {
  const { data } = await client.request<AuditIntegrityReport>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/audit/integrity`,
  });
  return data;
}
