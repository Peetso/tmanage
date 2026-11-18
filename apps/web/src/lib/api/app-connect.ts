import type { ApiClient } from './client';

/**
 * FIX5 — one-click Connect for GitHub (owner/admin). Mirrors the API's
 * `app-connect` module. No token ever reaches the browser: a view says whether the provider's app
 * is set up on this server, whether this workspace is connected, and the account's name.
 */

export const APP_CONNECT_PROVIDERS = ['github'] as const;
export type AppConnectProvider = (typeof APP_CONNECT_PROVIDERS)[number];

export interface AppConnectView {
  readonly provider: AppConnectProvider;
  /** The server has this provider's app registered. `false` → "Not set up yet". */
  readonly setUp: boolean;
  readonly connected: boolean;
  /** The GitHub login. */
  readonly account: string | null;
  /** PAUSED-FLAG: present on the status read while the platform has switched the service off. */
  readonly paused?: true;
}

const path = (slug: string, provider: AppConnectProvider) =>
  `/v1/organizations/${encodeURIComponent(slug)}/app-connect/${provider}`;

export async function getAppConnect(
  client: ApiClient,
  slug: string,
  provider: AppConnectProvider,
): Promise<AppConnectView> {
  const { data } = await client.request<AppConnectView>({
    method: 'GET',
    path: path(slug, provider),
  });
  return data;
}

/** The provider's consent address; the browser goes there in the same click. */
export async function startAppConnect(
  client: ApiClient,
  slug: string,
  provider: AppConnectProvider,
): Promise<{ readonly url: string }> {
  const { data } = await client.request<{ readonly url: string }>({
    method: 'POST',
    path: `${path(slug, provider)}/start`,
  });
  return data;
}

export async function completeAppConnect(
  client: ApiClient,
  slug: string,
  provider: AppConnectProvider,
  body: { readonly code: string; readonly state: string },
): Promise<AppConnectView> {
  const { data } = await client.request<AppConnectView>({
    method: 'POST',
    path: `${path(slug, provider)}/complete`,
    body,
  });
  return data;
}

export async function disconnectAppConnect(
  client: ApiClient,
  slug: string,
  provider: AppConnectProvider,
): Promise<AppConnectView> {
  const { data } = await client.request<AppConnectView>({
    method: 'DELETE',
    path: path(slug, provider),
  });
  return data;
}

/** The provider's return (`#github=complete&code=…&state=…`), or null when the hash is not one. */
export function readAppConnectReturn(hash: string):
  | {
      readonly provider: AppConnectProvider;
      readonly kind: 'complete';
      readonly code: string;
      readonly state: string;
    }
  | { readonly provider: AppConnectProvider; readonly kind: 'error' }
  | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  for (const provider of APP_CONNECT_PROVIDERS) {
    const kind = params.get(provider);
    if (kind === 'error') return { provider, kind: 'error' };
    if (kind !== 'complete') continue;
    const code = params.get('code') ?? '';
    const state = params.get('state') ?? '';
    return code !== '' && state !== ''
      ? { provider, kind: 'complete', code, state }
      : { provider, kind: 'error' };
  }
  return null;
}
