import type { ApiClient } from './client';

/**
 * People teams — x262, the "teams" surface of module 14 (38-MODULE-MAP §People "Directory, teams,
 * profile"; planning PEO-03 "Team detail"). Reading the team list and a team's detail is behind
 * `work.read` on the server (the internal-read capability the directory and profile reuse, which no
 * client role holds); creating a team and assigning/unassigning members is behind `org.manage`. A
 * caller without the capability gets the ordinary 403 the shared client turns into an error, and a
 * cross-tenant or unknown team id gets a 404.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projections in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies.
 */

/** A team as a list row: id, name, member count, and when it was created. */
export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly createdAt: string;
}

/** One member of a team — the non-sensitive header the directory also exposes. */
export interface TeamMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  /** Work area: how many open work items (not done or archived) this member does. */
  readonly openWorkCount: number;
}

/** One team with its full member roster — the team-detail read. */
export interface TeamDetailView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly members: readonly TeamMemberView[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/teams`;
}

/** The organization's teams, each with a member count. */
export async function listTeams(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly teams: readonly TeamView[] }> {
  const { data } = await client.request<{ teams: readonly TeamView[] }>({
    path: base(organizationSlug),
  });
  return data;
}

/** One team with its members. A cross-tenant or unknown id is a 404. */
export async function fetchTeam(
  client: ApiClient,
  organizationSlug: string,
  teamId: string,
): Promise<TeamDetailView> {
  const { data } = await client.request<TeamDetailView>({
    path: `${base(organizationSlug)}/${encodeURIComponent(teamId)}`,
  });
  return data;
}

/** Define a new team. A duplicate name is a 409. */
export async function createTeam(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<TeamView> {
  const { data } = await client.request<TeamView>({
    method: 'POST',
    path: base(organizationSlug),
    body: { name },
  });
  return data;
}

/** Assign a member to a team. Idempotent; an unknown team or non-member is a 404. */
export async function assignMember(
  client: ApiClient,
  organizationSlug: string,
  teamId: string,
  membershipId: string,
): Promise<void> {
  await client.request<void>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(
      membershipId,
    )}`,
  });
}

/** Unassign a member from a team. Idempotent. */
export async function unassignMember(
  client: ApiClient,
  organizationSlug: string,
  teamId: string,
  membershipId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(
      membershipId,
    )}`,
  });
}

/** Fix lane C. Delete a team (204). Its members stay in the workspace; only the grouping goes. */
export async function deleteTeam(
  client: ApiClient,
  organizationSlug: string,
  teamId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(teamId)}`,
  });
}

/** Work area: rename a team. A taken name is a 409, an unknown id a 404. */
export async function renameTeam(
  client: ApiClient,
  organizationSlug: string,
  teamId: string,
  name: string,
): Promise<TeamView> {
  const { data } = await client.request<TeamView>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(teamId)}`,
    body: { name },
  });
  return data;
}
