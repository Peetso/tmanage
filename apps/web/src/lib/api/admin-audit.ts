import type { ApiClient } from './client';

/**
 * The Administration audit viewer — ADM (x115). `GET .../audit/events`, behind `audit.read`.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection
 * (`AdminAuditEventView`) in the `e2e/contracts` shape check so the two cannot drift. The read is
 * tenant-scoped on the server from the caller's membership — there is no organization argument
 * here beyond the slug in the path — and the projection is deliberately narrow: no metadata, no
 * correlation id, so a broad admin list cannot surface a producer's payload (x49/x58 redaction).
 */

/**
 * One row of the trail. Paired Exact with the API's `AdminAuditEventView` in the contracts gate;
 * every field is a stable identifier or a derived, non-sensitive summary.
 */
export interface AdminAuditEvent {
  readonly id: string;
  /** The server's commit time, ISO-8601. */
  readonly occurredAt: string;
  /** Who acted, or `null` for a system-initiated event. */
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  /** The object the action names, or `null` when the action is not about a row. */
  readonly entityId: string | null;
  readonly summary: string;
}

/**
 * The read's response body. An object-literal `type` alias rather than an exported interface, so
 * the contracts gate does not enumerate it as a second response shape: the paired projection is
 * the row {@link AdminAuditEvent}, and the wrapper leaves room for a later `nextBefore` cursor.
 */
type AdminAuditPage = { readonly events: readonly AdminAuditEvent[] };

/** The viewer's filters. Named `…Options`, so the contracts gate treats it as request-side. */
export interface ListAuditEventsOptions {
  /** `1..50`; the API defaults to 20 and rejects an out-of-range value with a 400. */
  readonly limit?: number;
  /** Keyset cursor — the id of the oldest row already held; the API returns the ones before it. */
  readonly before?: string;
  readonly actorId?: string;
  readonly entityId?: string;
}

/** The largest page the viewer route returns — the API's `VIEWER_MAX_PAGE_SIZE`. */
export const MAX_AUDIT_PAGE = 50;

export async function listAuditEvents(
  client: ApiClient,
  organizationSlug: string,
  options: ListAuditEventsOptions = {},
): Promise<readonly AdminAuditEvent[]> {
  const parameters = new URLSearchParams();
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));
  if (options.before) parameters.set('before', options.before);
  if (options.actorId) parameters.set('actorId', options.actorId);
  if (options.entityId) parameters.set('entityId', options.entityId);

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<AdminAuditPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/audit/events${suffix}`,
  });
  return data.events;
}

/**
 * The absolute URL of the CSV export — ADM-09 (x118), behind `audit.export`.
 *
 * The export is a **browser download**, not a JSON read: the screen renders it as a plain
 * download link whose `href` is this URL, so the browser fetches the CSV with the session cookie
 * (a `GET`, so no CSRF token is needed) and the API's `Content-Disposition: attachment` saves it.
 * No bytes are proxied through the SPA or any new storage. The filter arguments mirror the
 * viewer's applied filters so an export matches what the operator is looking at; there is no
 * `limit`, because the export is bounded by the API's row cap (413 past it), not a page size.
 */
export function auditExportUrl(
  baseUrl: string,
  organizationSlug: string,
  options: Pick<ListAuditEventsOptions, 'actorId' | 'entityId' | 'before'> = {},
): string {
  const parameters = new URLSearchParams();
  if (options.actorId) parameters.set('actorId', options.actorId);
  if (options.entityId) parameters.set('entityId', options.entityId);
  if (options.before) parameters.set('before', options.before);

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  return `${baseUrl}/v1/organizations/${encodeURIComponent(organizationSlug)}/audit/events/export${suffix}`;
}
