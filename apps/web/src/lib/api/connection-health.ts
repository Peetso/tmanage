import type { ApiClient } from './client';

/**
 * Automations connection health (module 17, x220).
 *
 * Wraps the read-only health API: a deterministic, in-app validity verdict over the organization's
 * recorded integration connections (x165) — is the catalog app still known, are the required
 * non-secret config keys present, and is the connection live rather than a `pending` intent. The
 * exported {@link ConnectionHealthView} is paired Exact with the API type in the contracts gate.
 *
 * No secret is ever fetched or shown: the verdict carries only the *names* of any missing required
 * keys, never a stored config value, and the client makes no third-party network call — the API
 * computes the verdict from data already in hand (a live probe is out of scope, Needs-Peter).
 */

/** A machine-readable health issue code. Mirrors the API's `ConnectionHealthIssue`. */
export type ConnectionHealthIssue = 'unknown_app' | 'missing_config' | 'not_connected';

/** A connection's status. Mirrors the API's `IntegrationConnectionStatus`. */
export type ConnectionHealthStatus = 'connected' | 'pending';

/**
 * The health verdict for one connection — paired Exact with the API's `ConnectionHealthView`. Carries
 * no config value: `missingConfigKeys` are required key *names* found absent.
 */
export interface ConnectionHealthView {
  readonly connectionId: string;
  readonly appId: string;
  readonly label: string;
  readonly status: ConnectionHealthStatus;
  readonly healthy: boolean;
  readonly issues: readonly ConnectionHealthIssue[];
  readonly missingConfigKeys: readonly string[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/connections`;
}

/** Roll up the health of every connection the organization has recorded. */
export async function listConnectionHealth(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ConnectionHealthView[]> {
  const { data } = await client.request<{ connections: readonly ConnectionHealthView[] }>({
    path: `${base(organizationSlug)}/health`,
  });
  return data.connections;
}

/** The health verdict for one connection. A cross-tenant or unknown id is a 404 from the API. */
export async function getConnectionHealth(
  client: ApiClient,
  organizationSlug: string,
  connectionId: string,
): Promise<ConnectionHealthView> {
  const { data } = await client.request<ConnectionHealthView>({
    path: `${base(organizationSlug)}/${encodeURIComponent(connectionId)}/health`,
  });
  return data;
}
