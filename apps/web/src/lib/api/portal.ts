import type { ApiClient } from './client';

/**
 * The client portal's endpoints — CLIENT-002, behind `CL-01` and `CL-02`.
 *
 * A separate module from `work-items.ts` and `projects.ts`, deliberately, and the separation is
 * the same one the API makes: these are the **client projection**, not the internal record with
 * fewer fields. `25-AUTH-AND-TENANT-ISOLATION` §7 forbids building the client view by deleting
 * fields from the internal one, and a shared type here would be the first step back towards
 * exactly that.
 *
 * What is absent from these types is the point. There is no owner, no internal state, no
 * version, no audience. A screen cannot render what it was never given.
 */

export interface PortalProject {
  readonly id: string;
  readonly name: string;
  /** `12-PERMISSION-MATRIX` §4's "milestone state". The project's own status until milestones exist. */
  readonly status: string;
  /** A promise to the client. */
  readonly committedAt: string | null;
  /** The team's current estimate. Never presented as a promise. */
  readonly forecastAt: string | null;
}

/**
 * `waiting_on_you` is the whole of `CL-02`.
 *
 * The API collapses the internal lifecycle to three words on purpose: a client reading
 * `internal_review` would learn their deliverable is being argued about inside the agency.
 */
export type PortalProgress = 'waiting_on_you' | 'in_progress' | 'done';

export interface PortalWorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly progress: PortalProgress;
  readonly dueAt: string | null;
  readonly updatedAt: string;
}

export async function listPortalProjects(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PortalProject[]> {
  const { data } = await client.request<{ projects: readonly PortalProject[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects`,
  });
  return data.projects;
}

export async function listPortalWorkItems(
  client: ApiClient,
  organizationSlug: string,
  projectId?: string,
): Promise<readonly PortalWorkItem[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<{ workItems: readonly PortalWorkItem[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/work-items${suffix}`,
  });
  return data.workItems;
}

export interface InviteClientMemberInput {
  readonly email: string;
  readonly role: string;
}

/**
 * `CL-11`. A client admin inviting into their own client organization.
 *
 * There is no client organization on this input and there is none on the request either: the
 * API takes it from the session. A client admin cannot name a sibling client because no field
 * exists to name one in.
 */
export async function inviteClientMember(
  client: ApiClient,
  organizationSlug: string,
  input: InviteClientMemberInput,
): Promise<{ readonly token: string }> {
  const { data } = await client.request<{ token: string }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/client-members`,
    body: input,
  });
  return data;
}
