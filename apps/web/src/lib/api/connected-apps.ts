import type { ApiClient } from './client';

/**
 * Connected apps (MCP connector S11) — the AI apps connected to a workspace, disconnecting one,
 * and the owner's "Allow AI apps in this workspace" switch. Mirrors `ConnectedAppsView` in
 * `apps/api/src/modules/oauth/grants.service.ts`. A member sees only their own connections; an
 * owner sees all of them and the switch.
 */

export interface ConnectedApp {
  readonly id: string;
  readonly clientName: string;
  readonly verified: boolean;
  readonly scopes: readonly string[];
  readonly memberName: string;
  readonly mine: boolean;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

export interface ConnectedAppsView {
  readonly owner: boolean;
  readonly viewerName: string;
  readonly aiAccessEnabled: boolean;
  readonly apps: readonly ConnectedApp[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/oauth`;
}

export async function getConnectedApps(
  client: ApiClient,
  organizationSlug: string,
): Promise<ConnectedAppsView> {
  const { data } = await client.request<ConnectedAppsView>({
    path: `${base(organizationSlug)}/grants`,
  });
  return data;
}

export async function revokeConnectedApp(
  client: ApiClient,
  organizationSlug: string,
  grantId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${base(organizationSlug)}/grants/${encodeURIComponent(grantId)}/revoke`,
  });
}

export async function setWorkspaceAiAccess(
  client: ApiClient,
  organizationSlug: string,
  enabled: boolean,
): Promise<{ readonly aiAccessEnabled: boolean }> {
  const { data } = await client.request<{ readonly aiAccessEnabled: boolean }>({
    method: 'PUT',
    path: `${base(organizationSlug)}/ai-access`,
    body: { enabled },
  });
  return data;
}
