/**
 * Billing usage export (x227) — the client half of the date-windowed usage CSV download.
 *
 * Distinct from `billing.ts`'s usage-alerts wrapper (x200): this carries a bounded **from/to window**
 * and targets the `export.csv` route the `UsageExportController` serves behind `org.manage`.
 *
 * The export is a **browser download**, not a JSON read: the screen renders it as a plain download
 * link whose `href` is this URL, so the browser fetches the CSV with the session cookie (a `GET`, so
 * no CSRF token is needed) and the API's `Content-Disposition: attachment` saves it. No bytes are
 * proxied through the SPA — the payload is CSV, whose columns are documented by {@link UsageExportColumns}.
 */

/**
 * One row of the export's CSV, as a typed record — paired Exact with the API's `UsageExportView` in the
 * contracts gate so the emitted columns and the client's understanding of them cannot drift. The CSV
 * itself is fetched as a file by the browser; this shape is the column contract, not a parsed payload.
 * `organizationId` and the counter's storage internals are deliberately absent, exactly as on the API.
 */
export interface UsageExportColumns {
  readonly metricKey: string;
  readonly usedValue: number;
  readonly reservedValue: number;
  readonly thresholdBand: number;
  /** The last reconciliation instant (ISO-8601), or `null` when the counter was never reconciled. */
  readonly reconciledAt: string | null;
  /** The last update instant, ISO-8601. The export is windowed on this field. */
  readonly updatedAt: string;
}

/**
 * The export's filters. Named `…Query`, so the contracts gate treats it as request-side and never
 * enumerates it as a response shape. `from`/`to` are ISO-8601 instants and required by the API (a
 * missing, malformed, inverted or over-wide window is a 400).
 */
export interface UsageExportQuery {
  readonly from: string;
  readonly to: string;
}

/** The widest window the API accepts, in days — mirrors the controller's `MAX_EXPORT_WINDOW_DAYS`. */
export const MAX_USAGE_EXPORT_WINDOW_DAYS = 366;

/**
 * The absolute URL of the usage CSV export. The screen sets it as a download link's `href`; the browser
 * fetches it with the session cookie and the API forces the save. `from`/`to` are appended only as
 * query parameters on the API origin.
 */
export function usageExportUrl(
  baseUrl: string,
  organizationSlug: string,
  query: UsageExportQuery,
): string {
  const parameters = new URLSearchParams();
  parameters.set('from', query.from);
  parameters.set('to', query.to);
  return `${baseUrl}/v1/organizations/${encodeURIComponent(
    organizationSlug,
  )}/billing/usage/export.csv?${parameters.toString()}`;
}
