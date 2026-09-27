/**
 * ADM-09 filtered export (x197) — the client half of the date-windowed audit CSV download.
 *
 * Distinct from `admin-audit.ts`'s `auditExportUrl` (x118), which exports the whole trail filtered by
 * actor/entity. This one carries a bounded **from/to window** and an optional **action** filter, and
 * targets the `export.csv` route the `AuditExportController` serves behind `audit.export`.
 *
 * The export is a **browser download**, not a JSON read: the screen renders it as a plain download
 * link whose `href` is this URL, so the browser fetches the CSV with the session cookie (a `GET`, so
 * no CSRF token is needed) and the API's `Content-Disposition: attachment` saves it. No bytes are
 * proxied through the SPA and there is no response projection to pair — the payload is CSV.
 */

/**
 * The export's filters. Named `…Query`, so the contracts gate treats it as request-side and never
 * enumerates it as a response shape. `from`/`to` are ISO-8601 instants and required by the API
 * (a missing, malformed, inverted or over-wide window is a 400); `actor`/`action` are optional.
 */
export interface AuditExportQuery {
  readonly from: string;
  readonly to: string;
  readonly actor?: string;
  readonly action?: string;
}

/** The widest window the API accepts, in days — mirrors the controller's `MAX_EXPORT_WINDOW_DAYS`. */
export const MAX_AUDIT_EXPORT_WINDOW_DAYS = 366;

/**
 * The absolute URL of the filtered CSV export. The screen sets it as a download link's `href`; the
 * browser fetches it with the session cookie and the API forces the save. Only non-empty filters are
 * appended, and never as anything but query parameters on the API origin.
 */
export function auditFilteredExportUrl(
  baseUrl: string,
  organizationSlug: string,
  query: AuditExportQuery,
): string {
  const parameters = new URLSearchParams();
  parameters.set('from', query.from);
  parameters.set('to', query.to);
  if (query.actor && query.actor !== '') parameters.set('actor', query.actor);
  if (query.action && query.action !== '') parameters.set('action', query.action);
  return `${baseUrl}/v1/organizations/${encodeURIComponent(
    organizationSlug,
  )}/audit/export.csv?${parameters.toString()}`;
}
