import type { ApiClient } from './client';

/**
 * B5 — the owner setting "Downloads before a virus scan" (API lane B3,
 * `GET/PATCH /v1/organizations/:orgSlug/file-download-policy`, both behind `org.manage`; only the
 * owner may PATCH). `allow_labeled` (the default) serves a file before its scan, marked
 * "not scanned"; `block` refuses it with `409` until the scan is done. With no scanner configured
 * the server always behaves as `allow_labeled` (`effective`).
 */
export type DownloadsBeforeScan = 'allow_labeled' | 'block';

/** The policy as the API reports it. Mirrors the API's `DownloadScanPolicyView`. */
export interface DownloadScanPolicyView {
  readonly downloadsBeforeScan: DownloadsBeforeScan;
  readonly effective: DownloadsBeforeScan;
  readonly scannerConfigured: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/file-download-policy`;
}

export function isDownloadsBeforeScan(value: unknown): value is DownloadsBeforeScan {
  return value === 'allow_labeled' || value === 'block';
}

export async function readDownloadScanPolicy(
  client: ApiClient,
  organizationSlug: string,
): Promise<DownloadScanPolicyView> {
  const { data } = await client.request<DownloadScanPolicyView>({ path: path(organizationSlug) });
  return data;
}

/** Owner only — any other role gets `403`. The change is audited server-side. */
export async function updateDownloadScanPolicy(
  client: ApiClient,
  organizationSlug: string,
  downloadsBeforeScan: DownloadsBeforeScan,
): Promise<DownloadScanPolicyView> {
  const { data } = await client.request<DownloadScanPolicyView>({
    method: 'PATCH',
    path: path(organizationSlug),
    body: { downloadsBeforeScan },
  });
  return data;
}

/** What a download of a not-yet-scanned file came back with. */
export type NotScannedDownloadResult =
  { readonly kind: 'saved' } | { readonly kind: 'blocked' } | { readonly kind: 'failed' };

/**
 * Fetch a file that has not been scanned yet with the session cookie (a `GET`, no CSRF token) and
 * hand it to the browser as a save. A `409` whose details carry `scan_required_by_policy` means the
 * owner chose "Block until scanned"; anything else that is not `2xx` is a plain failure.
 */
export async function downloadNotScannedFile(
  url: string,
  fileName: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<NotScannedDownloadResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', credentials: 'include' });
  } catch {
    return { kind: 'failed' };
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      details?: readonly { message?: unknown }[];
    } | null;
    const blocked = (body?.details ?? []).some(
      (detail) => detail?.message === 'scan_required_by_policy',
    );
    return { kind: blocked ? 'blocked' : 'failed' };
  }
  if (!response.ok) return { kind: 'failed' };
  const blob = await response.blob();
  if (typeof URL.createObjectURL === 'function') {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
  return { kind: 'saved' };
}
