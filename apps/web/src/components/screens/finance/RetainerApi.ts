import type { ApiClient } from '../../../lib/api/client';

/**
 * Retainers (52-07): `GET …/client-organizations/:id/retainers` and `GET …/retainers/:id/periods` on
 * `work.read`, and the `pause` / `resume` transitions on `finance.manage`. The amount and currency
 * arrive only for a caller with `finance.view`; the screen shows a dash otherwise. Mirrors the API's
 * `RetainerView` and `RetainerPeriodView` (fields this screen reads).
 */

export interface RetainerRow {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly name: string;
  readonly period: string;
  readonly hoursPerPeriod: number | null;
  readonly amountPerPeriodMinor?: number | null;
  readonly currency?: string | null;
  readonly rollover: string;
  readonly billingTiming: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly state: string;
  readonly clientVisible: boolean;
}

export interface RetainerPeriodRow {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly state: string;
  readonly allowanceMinutes: number;
  readonly rolloverInMinutes: number;
  readonly usedMinutes: number;
  readonly overageMinutes: number;
  readonly remainingMinutes: number;
  readonly locked: boolean;
}

function org(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

export async function listRetainers(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<readonly RetainerRow[]> {
  const { data } = await client.request<{ retainers: readonly RetainerRow[] }>({
    path: `${org(organizationSlug)}/client-organizations/${encodeURIComponent(clientOrganizationId)}/retainers`,
  });
  return data.retainers;
}

export async function listRetainerPeriods(
  client: ApiClient,
  organizationSlug: string,
  retainerId: string,
): Promise<readonly RetainerPeriodRow[]> {
  const { data } = await client.request<{ periods: readonly RetainerPeriodRow[] }>({
    path: `${org(organizationSlug)}/retainers/${encodeURIComponent(retainerId)}/periods`,
  });
  return data.periods;
}

export async function transitionRetainer(
  client: ApiClient,
  organizationSlug: string,
  retainerId: string,
  event: 'pause' | 'resume',
): Promise<RetainerRow> {
  const { data } = await client.request<RetainerRow>({
    method: 'POST',
    path: `${org(organizationSlug)}/retainers/${encodeURIComponent(retainerId)}/${event}`,
  });
  return data;
}
