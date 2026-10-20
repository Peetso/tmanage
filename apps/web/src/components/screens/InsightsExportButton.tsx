'use client';

import { apiBaseUrl } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';

export interface InsightsExportButtonProps {
  organizationSlug: string;
  /**
   * The API origin the download link points at. Defaults to the configured API base URL; injected
   * in tests so the control renders without the `NEXT_PUBLIC_*` environment a real browser has.
   */
  baseUrl?: string;
}

/**
 * INS-05 — the workload CSV export control.
 *
 * A plain anchor to `GET …/insights/workload/export.csv` (behind `work.read` on the server, the
 * same read the workload table uses). It is a link, not a fetch: a top-level navigation carries the
 * session cookie to the API origin, and the server's `Content-Disposition: attachment` is what
 * actually saves the file — the `download` hint is advisory and (correctly) ignored cross-origin.
 * The screen never invents the file: an empty portfolio still exports its header and a zero totals
 * row, and a caller without the capability gets the ordinary 403 the server returns.
 */
export function InsightsExportButton({ organizationSlug, baseUrl }: InsightsExportButtonProps) {
  const t = useT();
  const origin = baseUrl ?? apiBaseUrl();
  const href = `${origin}/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/workload/export.csv`;

  return (
    <a className="tm-button tm-button--ink" href={href} download="workload.csv">
      {t('InsightsExportButton.exportWorkload')}
    </a>
  );
}
