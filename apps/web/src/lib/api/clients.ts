import type { ApiClient } from './client';
import type { InvitationSummary, IssuedInvitation } from './invitations';

/**
 * The client-organization endpoints (CLIENT-001 + BK1) the internal screens use: whether a
 * project is shared (`GET projects/:id/clients`, `project.manage`), and the Clients screen's
 * companies, their people, their invitations and new shares (Q1, Figma t5-a / t5-b).
 *
 * Issuing an invitation stays in `invitations.ts` (`POST /invitations` with
 * `clientOrganizationId`); the per-company read and the resend live here because only the
 * Clients screen asks for them.
 */

function orgPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

export interface ProjectShare {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly createdAt: string;
}

export async function listProjectShares(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectShare[]> {
  const { data } = await client.request<{ clients: readonly ProjectShare[] }>({
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/clients`,
  });
  return data.clients;
}

/** `POST projects/:projectId/clients` — share one project with one client company. */
export async function addProjectShare(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  clientOrganizationId: string,
): Promise<ProjectShare> {
  const { data } = await client.request<ProjectShare>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/clients`,
    body: { clientOrganizationId },
  });
  return data;
}

export interface ClientOrganization {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** `GET client-organizations` (`org.manage`), archived companies included so they can be shown. */
export async function listClientOrganizations(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ClientOrganization[]> {
  const { data } = await client.request<{
    clientOrganizations: readonly ClientOrganization[];
  }>({
    path: `${orgPath(organizationSlug)}/client-organizations?includeArchived=true`,
  });
  return data.clientOrganizations;
}

/** `POST client-organizations` — a new client company by name. */
export async function createClientOrganization(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<ClientOrganization> {
  const { data } = await client.request<ClientOrganization>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/client-organizations`,
    body: { name },
  });
  return data;
}

/** BK1: `GET client-organizations/:id/invitations?status=` — one company's invitations. */
export async function listClientInvitations(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
  status: readonly InvitationSummary['status'][] = ['pending'],
): Promise<readonly InvitationSummary[]> {
  const { data } = await client.request<{ invitations: readonly InvitationSummary[] }>({
    path: `${orgPath(organizationSlug)}/client-organizations/${encodeURIComponent(clientOrganizationId)}/invitations?status=${encodeURIComponent(status.join(','))}`,
  });
  return data.invitations;
}

export interface ClientMembership {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Only from {@link listClientPeople}: the member's name and email. */
  readonly displayName?: string;
  readonly email?: string;
}

/** `GET client-memberships?clientOrganizationId=` — the people of one client company. */
export async function listClientMemberships(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<readonly ClientMembership[]> {
  const { data } = await client.request<{ clientMemberships: readonly ClientMembership[] }>({
    path: `${orgPath(organizationSlug)}/client-memberships?clientOrganizationId=${encodeURIComponent(clientOrganizationId)}`,
  });
  return data.clientMemberships;
}

/** `POST invitations/:id/reissues` — resend: revokes the old invitation and issues a new token. */
export async function reissueClientInvitation(
  client: ApiClient,
  organizationSlug: string,
  invitationId: string,
): Promise<IssuedInvitation> {
  const { data } = await client.request<IssuedInvitation>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/invitations/${encodeURIComponent(invitationId)}/reissues`,
    body: {},
  });
  return data;
}

/**
 * 2026-10-31 live-test fix (Clients · company detail): the people of one client company with
 * their names and emails — `GET client-memberships?clientOrganizationId=&withPeople=true`.
 */
export async function listClientPeople(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<readonly ClientMembership[]> {
  const { data } = await client.request<{ clientMemberships: readonly ClientMembership[] }>({
    path: `${orgPath(organizationSlug)}/client-memberships?clientOrganizationId=${encodeURIComponent(clientOrganizationId)}&withPeople=true`,
  });
  return data.clientMemberships;
}

/** `GET client-organizations/:id` — one client company. */
export async function getClientOrganization(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<ClientOrganization> {
  const { data } = await client.request<ClientOrganization>({
    path: `${orgPath(organizationSlug)}/client-organizations/${encodeURIComponent(clientOrganizationId)}`,
  });
  return data;
}

/** `PATCH client-organizations/:id` — rename, guarded by the row's `updatedAt`. */
export async function renameClientOrganization(
  client: ApiClient,
  organizationSlug: string,
  organization: Pick<ClientOrganization, 'id' | 'updatedAt'>,
  name: string,
): Promise<ClientOrganization> {
  const { data } = await client.request<ClientOrganization>({
    method: 'PATCH',
    path: `${orgPath(organizationSlug)}/client-organizations/${encodeURIComponent(organization.id)}`,
    body: { name, updatedAt: organization.updatedAt },
  });
  return data;
}

/** `DELETE client-organizations/:id` — archive (the row stays, marked archived). */
export async function archiveClientOrganization(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<ClientOrganization> {
  const { data } = await client.request<ClientOrganization>({
    method: 'DELETE',
    path: `${orgPath(organizationSlug)}/client-organizations/${encodeURIComponent(clientOrganizationId)}`,
  });
  return data;
}
