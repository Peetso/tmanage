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

/**
 * `23-ERD` §6's lifecycle as the client is told it — `22-SCREEN-BY-SCREEN` §6 CL-06's
 * "submitted/clarifying/accepted/deferred/declined/planned/delivered".
 *
 * `triage` is absent because the client is never shown it: a studio that has opened a request
 * and not answered it reads as `submitted`. `withdrawn` is present because the client causes it.
 */
export type ClientRequestStatus =
  | 'submitted'
  | 'clarifying'
  | 'accepted'
  | 'deferred'
  | 'declined'
  | 'planned'
  | 'delivered'
  | 'withdrawn';

/**
 * A request, as its author sees it.
 *
 * No linked work item, no person, no internal state. `canWithdraw` is the one field that looks
 * like a permission and is not: it is the state machine's answer to "is withdrawal still legal
 * from here", and the screen needs it because `status` cannot answer — `submitted` and `triage`
 * are the same word to a client and only one of them has an arrow to `withdrawn`.
 */
export interface ClientRequest {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly category: string;
  readonly description: string;
  readonly urgencyReason: string | null;
  /** What was asked for, as `YYYY-MM-DD`. Never a commitment — not called `dueAt` on purpose. */
  readonly desiredAt: string | null;
  readonly status: ClientRequestStatus;
  readonly clarificationQuestion: string | null;
  readonly clientVisibleReason: string | null;
  readonly clientSafeScopeSummary: string | null;
  readonly commitment: 'committed' | 'unscheduled' | null;
  readonly committedAt: string | null;
  readonly canWithdraw: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmitClientRequestInput {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly category?: string;
  readonly urgencyReason?: string;
  /** A `YYYY-MM-DD` calendar date. The API refuses an instant — a date with no time has no zone to shift in. */
  readonly desiredAt?: string;
}

export async function submitClientRequest(
  client: ApiClient,
  organizationSlug: string,
  input: SubmitClientRequestInput,
): Promise<ClientRequest> {
  const { data } = await client.request<ClientRequest>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/requests`,
    body: input,
  });
  return data;
}

export async function listClientRequests(
  client: ApiClient,
  organizationSlug: string,
  projectId?: string,
): Promise<readonly ClientRequest[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<{ requests: readonly ClientRequest[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/requests${suffix}`,
  });
  return data.requests;
}

export async function getClientRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<ClientRequest> {
  const { data } = await client.request<ClientRequest>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/requests/${encodeURIComponent(requestId)}`,
  });
  return data;
}

/**
 * Withdraw. The route names its one destination, so there is no state to send and none to get
 * wrong; the version is the concurrency token the API refuses the write without.
 */
export async function withdrawClientRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
  version: number,
): Promise<ClientRequest> {
  const { data } = await client.request<ClientRequest>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/requests/${encodeURIComponent(requestId)}/withdrawal`,
    body: { version },
  });
  return data;
}
