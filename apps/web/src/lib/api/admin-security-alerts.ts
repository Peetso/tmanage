import type { ApiClient } from './client';

/**
 * Admin security-event alert configuration (Administration, security monitoring, x329).
 *
 * Wraps the admin security-alerts API: list the allowlist + the tenant's config + a read-only preview
 * of recent matching audit events, toggle an alert on/off for one event-type key, and remove a key's
 * config. {@link SecurityAlertsView} pairs Exact with the API's `SecurityAlertsView` in the contracts
 * gate — the wire projection carries no request content and never echoes the tenant id.
 */

/** One configured alert. Paired Exact with the API. */
export interface SecurityAlertConfig {
  readonly eventTypeKey: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** One recent matching audit event, read-only. Paired Exact with the API. */
export interface SecurityAlertMatch {
  readonly id: string;
  readonly eventTypeKey: string;
  readonly result: string;
  readonly actorUserId: string | null;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly occurredAt: string;
}

/** The security-alerts screen's read model. Paired Exact with the API. */
export interface SecurityAlertsView {
  readonly allowedEventTypes: readonly string[];
  readonly configs: readonly SecurityAlertConfig[];
  readonly recentMatches: readonly SecurityAlertMatch[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/security-alerts`;
}

/** Read the allowlist, the tenant's config, and the recent matches for the enabled keys. */
export async function readSecurityAlerts(
  client: ApiClient,
  organizationSlug: string,
): Promise<SecurityAlertsView> {
  const { data } = await client.request<SecurityAlertsView>({ path: base(organizationSlug) });
  return data;
}

/** Turn an alert on or off for one event-type key. Returns the config after the write. */
export async function setSecurityAlert(
  client: ApiClient,
  organizationSlug: string,
  input: { eventTypeKey: string; enabled: boolean },
): Promise<SecurityAlertsView> {
  const { data } = await client.request<SecurityAlertsView>({
    method: 'PUT',
    path: base(organizationSlug),
    body: { eventTypeKey: input.eventTypeKey, enabled: input.enabled },
  });
  return data;
}

/** Remove an event-type key's config (204). */
export async function removeSecurityAlert(
  client: ApiClient,
  organizationSlug: string,
  eventTypeKey: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: base(organizationSlug),
    body: { eventTypeKey },
  });
}
