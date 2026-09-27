import type { ApiClient } from './client';

/**
 * Automations app directory (module 17, x165).
 *
 * This module wraps the directory API: read the static app catalog merged with the organization's
 * connections, and record a connection against a catalog app. The two exported response shapes —
 * {@link IntegrationAppView} and {@link IntegrationConnectionView} — are paired Exact with the API's
 * types in the contracts gate. No secret is ever sent or stored: `config` is non-secret settings only.
 */

/** An integration connection's status: a live connection, or an intent awaiting a later exchange. */
export type IntegrationConnectionStatus = 'connected' | 'pending';

/** A connection's non-secret settings bag. Mirrors the API's `IntegrationConnectionConfig`. */
export type IntegrationConnectionConfig = Readonly<Record<string, string | number | boolean>>;

/**
 * One recorded connection — paired Exact with the API's `IntegrationConnectionView`. `organizationId`
 * is absent on both sides: the wire projection never echoes the tenant id.
 */
export interface IntegrationConnectionView {
  readonly id: string;
  readonly appId: string;
  readonly label: string;
  readonly status: IntegrationConnectionStatus;
  readonly config: IntegrationConnectionConfig;
  readonly createdAt: string;
}

/**
 * One catalog app with the org's connections merged onto it — paired Exact with the API's
 * `IntegrationAppView`. `capabilities` are the integration's own descriptive capabilities, not RBAC.
 */
export interface IntegrationAppView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly capabilities: readonly string[];
  readonly connections: readonly IntegrationConnectionView[];
}

/** The fields a create sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateConnectionInput {
  readonly label: string;
  readonly status?: IntegrationConnectionStatus;
  readonly config?: Record<string, string | number | boolean>;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/apps`;
}

/** List the app catalog merged with the organization's connections. */
export async function listIntegrationApps(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly IntegrationAppView[]> {
  const { data } = await client.request<{ apps: readonly IntegrationAppView[] }>({
    path: base(organizationSlug),
  });
  return data.apps;
}

/** Record a connection against a catalog app. An off-catalog app is a 404 from the API. */
export async function connectIntegrationApp(
  client: ApiClient,
  organizationSlug: string,
  appId: string,
  input: CreateConnectionInput,
): Promise<IntegrationConnectionView> {
  const { data } = await client.request<IntegrationConnectionView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(appId)}/connections`,
    body: input,
  });
  return data;
}
