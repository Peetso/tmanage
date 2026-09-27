import type { ApiClient } from './client';

/**
 * Billing & entitlements (module 19, x200).
 *
 * This module wraps the usage-alerts API: list an organization's usage-alert threshold rules, create
 * one, update a rule's threshold/active, and read which active rules are currently breached. The two
 * exported response shapes are {@link UsageAlertSummary} (paired Exact with the API's `UsageAlertView`)
 * and {@link UsageAlertStatus} (paired Exact with `UsageAlertStatusView`). Alert delivery is Needs-Peter.
 */

/** The metered dimensions a rule may watch. Mirrors the API's `USAGE_ALERT_METRICS`. */
export type UsageAlertMetric = 'seats' | 'storage' | 'api';

/**
 * One usage-alert rule — paired Exact with the API's `UsageAlertView`. `organizationId` is absent on
 * both sides: the wire projection never echoes the tenant id. `metric` is `string` (not the union
 * above), matching the API view exactly — the closed set is enforced server side.
 */
export interface UsageAlertSummary {
  readonly id: string;
  readonly metric: string;
  readonly thresholdPercent: number;
  readonly active: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One rule's current evaluation — paired Exact with the API's `UsageAlertStatusView`. `breached` is the
 * server's decision (active and current band at or above the threshold); the client renders it.
 */
export interface UsageAlertStatus {
  readonly metric: string;
  readonly thresholdPercent: number;
  readonly active: boolean;
  readonly currentPercent: number;
  readonly breached: boolean;
}

/** The fields a create sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateUsageAlertInput {
  readonly metric: UsageAlertMetric;
  readonly thresholdPercent: number;
  readonly active?: boolean;
}

/** The fields an update sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface UpdateUsageAlertInput {
  readonly thresholdPercent?: number;
  readonly active?: boolean;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/usage-alerts`;
}

/** List the organization's usage-alert rules, metric-ascending. */
export async function listUsageAlerts(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly UsageAlertSummary[]> {
  const { data } = await client.request<{ alerts: readonly UsageAlertSummary[] }>({
    path: base(organizationSlug),
  });
  return data.alerts;
}

/** Read which rules are currently breached. */
export async function readUsageAlertStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly UsageAlertStatus[]> {
  const { data } = await client.request<{ statuses: readonly UsageAlertStatus[] }>({
    path: `${base(organizationSlug)}/status`,
  });
  return data.statuses;
}

/** Create a usage-alert rule. */
export async function createUsageAlert(
  client: ApiClient,
  organizationSlug: string,
  input: CreateUsageAlertInput,
): Promise<UsageAlertSummary> {
  const { data } = await client.request<UsageAlertSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Update a rule's threshold and/or active flag. */
export async function updateUsageAlert(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  input: UpdateUsageAlertInput,
): Promise<UsageAlertSummary> {
  const { data } = await client.request<UsageAlertSummary>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
    body: input,
  });
  return data;
}
