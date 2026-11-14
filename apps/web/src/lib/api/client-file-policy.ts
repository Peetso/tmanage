import type { ApiClient } from './client';

/**
 * FIX6 item 1 — the owner setting "Files clients can receive"
 * (`GET/PATCH /v1/organizations/:orgSlug/client-file-policy`, both behind `org.manage`; only the
 * owner may PATCH). `checked`: files that passed TManage's own safety checks may be sent to
 * clients, labelled "Checked" (the default when no virus scanner is set up). `virus_scanned`: only
 * files a virus scanner cleared; with no scanner nothing can be sent (`sharingPossible: false`).
 */
export type ClientFilesPolicy = 'checked' | 'virus_scanned';

/** Mirrors the API's `ClientFilePolicyView`. */
export interface ClientFilePolicyView {
  readonly clientFiles: ClientFilesPolicy;
  readonly scannerConfigured: boolean;
  readonly sharingPossible: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-file-policy`;
}

export function isClientFilesPolicy(value: unknown): value is ClientFilesPolicy {
  return value === 'checked' || value === 'virus_scanned';
}

export async function readClientFilePolicy(
  client: ApiClient,
  organizationSlug: string,
): Promise<ClientFilePolicyView> {
  const { data } = await client.request<ClientFilePolicyView>({ path: path(organizationSlug) });
  return data;
}

/** Owner only — any other role gets `403`. The change is audited server-side. */
export async function updateClientFilePolicy(
  client: ApiClient,
  organizationSlug: string,
  clientFiles: ClientFilesPolicy,
): Promise<ClientFilePolicyView> {
  const { data } = await client.request<ClientFilePolicyView>({
    method: 'PATCH',
    path: path(organizationSlug),
    body: { clientFiles },
  });
  return data;
}
