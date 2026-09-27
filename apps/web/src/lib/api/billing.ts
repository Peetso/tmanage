import type { ApiClient } from './client';

/**
 * The billing-profile endpoints — module 19 (x180), behind the billing-settings screen (audit #10).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 *
 * The read and the update are gated on the server by `org.manage` — owners only — so a member who
 * reaches this client gets the ordinary 403 the shared client turns into an error. There is no
 * organization-id argument: the tenant is the slug in the path resolved against the caller's
 * membership, never a value the caller supplies. Only non-secret metadata is carried here — there is
 * no card or bank field, by design; payment instruments are held by the payment provider.
 *
 * Billing & entitlements (module 19, x200) also wraps the usage-alerts API: list an organization's
 * usage-alert threshold rules, create one, update a rule's threshold/active, and read which active
 * rules are currently breached. The two exported response shapes are {@link UsageAlertSummary} (paired
 * Exact with the API's `UsageAlertView`) and {@link UsageAlertStatus} (paired Exact with
 * `UsageAlertStatusView`). Alert delivery is Needs-Peter.
 */

/** A billing address. A `type` alias (an object literal), so the contracts gate does not enumerate it
 * as a projection of its own — it travels inside {@link BillingProfileView}. Mirrors the API's
 * `BillingAddress`. */
export type BillingAddress = {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
};

/**
 * One billing profile — paired Exact with the API's `BillingProfileView`. `organizationId` is absent
 * on both sides: the wire projection never echoes the tenant id. `updatedAt` is null until the profile
 * is first saved.
 */
export interface BillingProfileView {
  readonly billingEmail: string | null;
  readonly companyName: string | null;
  readonly taxId: string | null;
  readonly address: BillingAddress;
  readonly updatedAt: string | null;
}

/**
 * The fields an update sends. Request-side (suffix `Input`), so the contracts gate ignores it. Every
 * field is optional; an omitted or null field clears that value.
 */
export interface UpdateBillingProfileInput {
  readonly billingEmail?: string | null;
  readonly companyName?: string | null;
  readonly taxId?: string | null;
  readonly address?: {
    readonly line1?: string | null;
    readonly line2?: string | null;
    readonly city?: string | null;
    readonly region?: string | null;
    readonly postalCode?: string | null;
    readonly country?: string | null;
  };
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/profile`;
}

/** Read the organization's billing profile (defaults when none has been saved). */
export async function fetchBillingProfile(
  client: ApiClient,
  organizationSlug: string,
): Promise<BillingProfileView> {
  const { data } = await client.request<BillingProfileView>({ path: path(organizationSlug) });
  return data;
}

/** Create or replace the organization's billing profile. */
export async function updateBillingProfile(
  client: ApiClient,
  organizationSlug: string,
  input: UpdateBillingProfileInput,
): Promise<BillingProfileView> {
  const { data } = await client.request<BillingProfileView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: input,
  });
  return data;
}

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
