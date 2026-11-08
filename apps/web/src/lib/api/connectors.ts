import type { ApiClient } from './client';

/**
 * 54-01. The connector framework's endpoints, owner/admin only (`org.manage`). Mirrors
 * `ConnectorView` in `apps/api/src/modules/connectors/connectors.service.ts`. A view never carries
 * a credential: an API key goes into the token vault on install and never comes back.
 */

export type ConnectorAuthType = 'oauth2' | 'api-key';
export type ConnectorState = 'connected' | 'not_connected' | 'installed' | 'not_installed';

export interface ConnectorView {
  readonly key: string;
  readonly name: string;
  readonly authType: ConnectorAuthType;
  readonly scopes: readonly string[];
  readonly capabilities: readonly string[];
  readonly scope: 'organization' | 'member';
  readonly managed: 'built-in' | 'framework';
  readonly state: ConnectorState;
  readonly credentialHint: string | null;
  readonly installedAt: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/connectors`;
}

export async function listConnectors(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ConnectorView[]> {
  const { data } = await client.request<{ connectors: readonly ConnectorView[] }>({
    path: base(organizationSlug),
  });
  return data.connectors;
}

export async function installConnector(
  client: ApiClient,
  organizationSlug: string,
  key: string,
  apiKey: string,
): Promise<ConnectorView> {
  const { data } = await client.request<ConnectorView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(key)}/install`,
    body: { apiKey },
  });
  return data;
}

export async function uninstallConnector(
  client: ApiClient,
  organizationSlug: string,
  key: string,
): Promise<ConnectorView> {
  const { data } = await client.request<ConnectorView>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(key)}`,
  });
  return data;
}
