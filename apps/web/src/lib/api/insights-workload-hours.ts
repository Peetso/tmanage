import type { ApiClient } from './client';

/**
 * A14 — workload in hours with editable weekly capacity. `GET …/insights/workload-hours` behind
 * `report.view`; `PUT …/insights/workload-hours/capacity/:membershipId` behind `org.manage`
 * (owner and org admin only). Paired with the API projections in `e2e/contracts/api-web-shapes.ts`.
 */

interface WorkloadHoursPersonRow {
  readonly membershipId: string;
  readonly displayName: string;
  readonly plannedHours: number;
  readonly unscheduledHours: number;
  readonly capacityHours: number | null;
  readonly utilisation: number | null;
  readonly overCapacity: boolean;
}

export interface WorkloadHoursView {
  readonly people: readonly WorkloadHoursPersonRow[];
  readonly totals: {
    readonly plannedHours: number;
    readonly capacityHours: number;
    readonly overCapacityCount: number;
  };
  readonly canEditCapacity: boolean;
  readonly weekStartsAt: string;
  readonly computedAt: string;
}

export interface WorkloadCapacityView {
  readonly membershipId: string;
  readonly weeklyHours: number;
  readonly effectiveFrom: string;
}

/** One person's row, named for the screen. */
export type WorkloadHoursPerson = WorkloadHoursView['people'][number];

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/workload-hours`;
}

export async function fetchWorkloadHours(
  client: ApiClient,
  organizationSlug: string,
): Promise<WorkloadHoursView> {
  const { data } = await client.request<WorkloadHoursView>({ path: base(organizationSlug) });
  return data;
}

export async function setWorkloadCapacity(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  weeklyHours: number,
): Promise<WorkloadCapacityView> {
  const { data } = await client.request<WorkloadCapacityView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/capacity/${encodeURIComponent(membershipId)}`,
    body: { weeklyHours },
  });
  return data;
}
