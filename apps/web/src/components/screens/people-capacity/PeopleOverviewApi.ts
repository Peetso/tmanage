import type { ApiClient } from '../../../lib/api/client';

/**
 * The org-wide People reads behind the capacity, time-off and allocations screens (A13), plus the
 * two allocation writes the shared `person-allocations` client does not wrap (confirm, remove).
 * Shapes mirror the API's `people-overview.controller.ts`; the tenant id is never on the wire.
 */

export interface CapacityRosterEntry {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly weeklyHours: number | null;
  readonly effectiveFrom: string | null;
  readonly allocatedPercent: number;
  readonly tentativePercent: number;
  readonly awayThisWeek: boolean;
}

export interface CapacityRoster {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly members: readonly CapacityRosterEntry[];
}

export interface OverviewTimeOff {
  readonly id: string;
  readonly personUserId: string;
  readonly displayName: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly kind: string;
  readonly note: string | null;
}

export interface OverviewAllocation {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly membershipId: string;
  readonly displayName: string;
  readonly percent: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly status: string;
  readonly hoursPerWeek: number | null;
  readonly note: string | null;
}

function people(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people`;
}

function windowQuery(window?: { readonly from: string; readonly to: string }): string {
  if (window === undefined) return '';
  const parameters = new URLSearchParams({ from: window.from, to: window.to });
  return `?${parameters.toString()}`;
}

export async function getCapacityRoster(
  client: ApiClient,
  organizationSlug: string,
): Promise<CapacityRoster> {
  const { data } = await client.request<CapacityRoster>({
    path: `${people(organizationSlug)}/capacity`,
  });
  return data;
}

export async function listOrgTimeOff(
  client: ApiClient,
  organizationSlug: string,
  window?: { readonly from: string; readonly to: string },
): Promise<readonly OverviewTimeOff[]> {
  const { data } = await client.request<{ entries: readonly OverviewTimeOff[] }>({
    path: `${people(organizationSlug)}/time-off${windowQuery(window)}`,
  });
  return data.entries;
}

export async function listOrgAllocations(
  client: ApiClient,
  organizationSlug: string,
  window?: { readonly from: string; readonly to: string },
): Promise<readonly OverviewAllocation[]> {
  const { data } = await client.request<{ allocations: readonly OverviewAllocation[] }>({
    path: `${people(organizationSlug)}/allocations${windowQuery(window)}`,
  });
  return data.allocations;
}

function allocationPath(organizationSlug: string, projectId: string, id: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(
    projectId,
  )}/allocations/${encodeURIComponent(id)}`;
}

export async function confirmAllocation(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  id: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${allocationPath(organizationSlug, projectId, id)}/confirm`,
  });
}

export async function removeAllocation(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: allocationPath(organizationSlug, projectId, id),
  });
}
