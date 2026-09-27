import type { ApiClient } from './client';

/**
 * Audit-log retention policy (Administration module 18, x279).
 *
 * Wraps the admin audit-retention API: read the organization's retention window and a read-only preview
 * of how many audit events fall outside it, and set the window. The one exported response shape is
 * {@link AuditRetentionView}, paired Exact with the API's `AuditRetentionView` — the wire projection is
 * the policy and the preview only, and never echoes the tenant id or the actor. Preview only: this
 * surface stores a window and previews the count; the destructive purge is a later procedure.
 */

/** The organization's retention policy and purge preview. Paired Exact with the API. */
export interface AuditRetentionView {
  /** The stored retention window in days, or null if the organization has never set one. */
  readonly retentionDays: number | null;
  /** When the policy was last set (ISO 8601), or null if never set. */
  readonly updatedAt: string | null;
  /** How many audit events are older than `now - retentionDays`. 0 when no window is set. */
  readonly eventsOlderThanWindow: number;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/audit-retention`;
}

/** Read the organization's retention policy and the purge preview. */
export async function readAuditRetention(
  client: ApiClient,
  organizationSlug: string,
): Promise<AuditRetentionView> {
  const { data } = await client.request<AuditRetentionView>({ path: base(organizationSlug) });
  return data;
}

/** Set the organization's retention window (days). Returns the stored policy and fresh preview. */
export async function setAuditRetention(
  client: ApiClient,
  organizationSlug: string,
  input: { retentionDays: number },
): Promise<AuditRetentionView> {
  const { data } = await client.request<AuditRetentionView>({
    method: 'PUT',
    path: base(organizationSlug),
    body: { retentionDays: input.retentionDays },
  });
  return data;
}
