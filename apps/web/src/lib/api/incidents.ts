import type { ClockStatus, IncidentSeverity, Jurisdiction } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * A17 · Incidents. Two readers of the one register (`apps/api/.../platform-admin/incidents`):
 *
 * - the workspace owner's page, `GET /v1/organizations/:orgSlug/admin/incidents` (`org.manage`):
 *   only the public fields, and only incidents that are published or were announced to this
 *   workspace;
 * - the platform register, `/v1/platform/incidents…` (`platform.settings.edit`): create, edit,
 *   publish and resolve, with the legal notice clocks.
 */

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export const INCIDENT_STATUS_ORDER: readonly IncidentStatus[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
];

/** One row of the workspace page. Paired Exact with the API's `WorkspaceIncidentView`. */
export interface WorkspaceIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly affectsWorkspace: boolean;
}

export interface IncidentClockView {
  readonly jurisdiction: Jurisdiction;
  readonly dueAt: string;
  readonly basis: string;
  readonly status: ClockStatus;
}

export interface IncidentClocksView {
  readonly authority: readonly IncidentClockView[];
  readonly customers: { readonly dueAt: string; readonly status: ClockStatus } | null;
  readonly subjectsWithoutUndueDelay: boolean;
}

/** One register row. Paired Exact with the API's `PlatformIncidentView`. */
export interface PlatformIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly severity: IncidentSeverity;
  readonly startedAt: string;
  readonly detectedAt: string | null;
  readonly containedAt: string | null;
  readonly resolvedAt: string | null;
  readonly affectedOrgIds: readonly string[];
  readonly dataCategories: readonly string[];
  readonly countries: readonly string[];
  readonly personalData: boolean;
  readonly notifiedAuthorityAt: string | null;
  readonly notifiedCustomersAt: string | null;
  readonly postmortemUrl: string | null;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly clocks: IncidentClocksView;
}

/** The editable register fields (POST creates, PUT merges). */
export interface PlatformIncidentInput {
  readonly title: string;
  readonly component: string;
  readonly body: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly personalData: boolean;
  readonly countries: readonly string[];
  readonly affectedOrgIds: readonly string[];
  readonly notifiedAuthorityAt: string | null;
  readonly notifiedCustomersAt: string | null;
  readonly reason?: string;
}

export const workspaceIncidentsKey = (organizationSlug: string) =>
  ['admin-incidents', organizationSlug] as const;

export const PLATFORM_INCIDENTS_QUERY_KEY = ['platform', 'incidents'] as const;

export async function fetchWorkspaceIncidents(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkspaceIncidentView[]> {
  const { data } = await client.request<{ readonly incidents: readonly WorkspaceIncidentView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/incidents`,
  });
  return data.incidents;
}

export async function fetchPlatformIncidents(
  client: ApiClient,
): Promise<readonly PlatformIncidentView[]> {
  const { data } = await client.request<{ readonly incidents: readonly PlatformIncidentView[] }>({
    path: '/v1/platform/incidents',
  });
  return data.incidents;
}

export async function createPlatformIncident(
  client: ApiClient,
  input: PlatformIncidentInput,
): Promise<PlatformIncidentView> {
  const { data } = await client.request<PlatformIncidentView>({
    method: 'POST',
    path: '/v1/platform/incidents',
    body: input,
  });
  return data;
}

export async function updatePlatformIncident(
  client: ApiClient,
  id: string,
  input: PlatformIncidentInput,
): Promise<PlatformIncidentView> {
  const { data } = await client.request<PlatformIncidentView>({
    method: 'PUT',
    path: `/v1/platform/incidents/${encodeURIComponent(id)}`,
    body: input,
  });
  return data;
}

/** Publish / unpublish on the status page, or resolve (refused while a notice is owed). */
export async function platformIncidentAction(
  client: ApiClient,
  id: string,
  action: 'publish' | 'unpublish' | 'resolve',
  reason: string | null,
): Promise<PlatformIncidentView> {
  const { data } = await client.request<PlatformIncidentView>({
    method: 'POST',
    path: `/v1/platform/incidents/${encodeURIComponent(id)}/${action}`,
    body: reason === null ? {} : { reason },
  });
  return data;
}

/** The capsule state a status draws as (shape + colour + word). */
export function incidentCapsule(
  status: IncidentStatus,
): 'current' | 'waiting' | 'done' | 'neutral' {
  if (status === 'resolved') return 'done';
  if (status === 'monitoring') return 'waiting';
  if (status === 'investigating') return 'current';
  return 'neutral';
}

/** The earliest open notice deadline, or null when nothing is owed. */
export function nextOpenClock(incident: PlatformIncidentView): string | null {
  const due: string[] = [];
  if (incident.notifiedAuthorityAt === null) {
    for (const clock of incident.clocks.authority) due.push(clock.dueAt);
  }
  if (incident.clocks.customers !== null && incident.notifiedCustomersAt === null) {
    due.push(incident.clocks.customers.dueAt);
  }
  return due.sort()[0] ?? null;
}
