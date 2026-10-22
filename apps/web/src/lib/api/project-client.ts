import type { ApiClient } from './client';
import type { ProjectShare } from './clients';

/**
 * The client a project is shared with — BK1 / PRJ-02 (New project client picker) and the
 * "Share with client" dialog on the project's Members screen (Figma t5-c / t5-d).
 *
 * - `GET client-organization-options` (`project.create`, so a manager can call it): id and name of
 *   every active client company — the picker's list.
 * - `POST client-organizations` (`org.manage`): a new client company, from the picker's
 *   "Add a new client" row. The screen only offers that row to a role that holds `org.manage`.
 * - `PUT projects/:id/client` (`project.manage`): set the project's client, or `null` for none,
 *   replacing any existing share. 422 when the company is archived.
 * - `GET client-memberships?clientOrganizationId=&status=active` (`client_member.manage`): the
 *   company's active people, shown read-only — the API shares the whole company, not people.
 *
 * Hand-written and paired with the API projections in the `e2e/contracts` shape check.
 */

/** One row of the picker. Paired Exact with the API `ClientOrganizationOption`. */
export interface ClientOrganizationOption {
  readonly id: string;
  readonly name: string;
}

/** A client company as `POST client-organizations` answers. Paired with `ClientOrganizationView`. */
export interface ClientOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** One person in a client company. Paired Exact with the API `ClientMembershipView`. */
export interface ClientMembershipView {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function orgPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

export async function listClientOrganizationOptions(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ClientOrganizationOption[]> {
  const { data } = await client.request<{
    clientOrganizations: readonly ClientOrganizationOption[];
  }>({
    path: `${orgPath(organizationSlug)}/client-organization-options`,
  });
  return data.clientOrganizations;
}

export async function createClientOrganization(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<ClientOrganizationView> {
  const { data } = await client.request<ClientOrganizationView>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/client-organizations`,
    body: { name },
  });
  return data;
}

export async function setProjectClient(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  clientOrganizationId: string | null,
): Promise<readonly ProjectShare[]> {
  const { data } = await client.request<{ clients: readonly ProjectShare[] }>({
    method: 'PUT',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/client`,
    body: { clientOrganizationId },
  });
  return data.clients;
}

export async function listClientPeople(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<readonly ClientMembershipView[]> {
  const query = `clientOrganizationId=${encodeURIComponent(clientOrganizationId)}&status=active`;
  const { data } = await client.request<{ clientMemberships: readonly ClientMembershipView[] }>({
    path: `${orgPath(organizationSlug)}/client-memberships?${query}`,
  });
  return data.clientMemberships;
}

export { listProjectShares } from './clients';
export { getPortalSettings, updatePortalSettings } from './portal-settings';
export type { PortalSettingsView, SavePortalSettingsInput } from './portal-settings';
