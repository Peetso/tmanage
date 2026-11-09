import type { ApiClient } from './client';
import type { ChannelLinkView } from './channel-links';

/**
 * FIX5 — one-click Connect for GitHub, Slack and Microsoft Teams (owner/admin). Mirrors the API's
 * `app-connect` module. No token ever reaches the browser: a view says whether the provider's app
 * is set up on this server, whether this workspace is connected, and the account's name.
 */

export const APP_CONNECT_PROVIDERS = ['github', 'slack', 'teams'] as const;
export type AppConnectProvider = (typeof APP_CONNECT_PROVIDERS)[number];

export interface AppConnectView {
  readonly provider: AppConnectProvider;
  /** The server has this provider's app registered. `false` → "Not set up yet". */
  readonly setUp: boolean;
  readonly connected: boolean;
  /** GitHub login, Slack workspace or Microsoft account. */
  readonly account: string | null;
  /** Slack: the channel chosen on Slack's own screen. */
  readonly channel: string | null;
}

export interface AppConnectOption {
  readonly id: string;
  readonly name: string;
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

/** Slack: its channels. Teams: your teams, or with `teamId` that team's channels. */
export async function listAppConnectChannels(
  client: ApiClient,
  slug: string,
  provider: 'slack' | 'teams',
  teamId?: string,
): Promise<{
  readonly teams?: readonly AppConnectOption[];
  readonly channels?: readonly AppConnectOption[];
}> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  const { data } = await client.request<{
    readonly teams?: readonly AppConnectOption[];
    readonly channels?: readonly AppConnectOption[];
  }>({ method: 'GET', path: `${path(slug, provider)}/channels${query}` });
  return data;
}

export async function addAppConnectChannel(
  client: ApiClient,
  slug: string,
  provider: 'slack' | 'teams',
  body: { readonly channelId: string; readonly teamId?: string; readonly locale?: 'en' | 'ar' },
): Promise<ChannelLinkView> {
  const { data } = await client.request<ChannelLinkView>({
    method: 'POST',
    path: `${path(slug, provider)}/channels`,
    body,
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
