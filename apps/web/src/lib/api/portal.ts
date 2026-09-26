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

/**
 * A project update as the portal is told it — `CL-03`.
 *
 * What is absent is the point, the same way it is for `PortalProject` and `PortalWorkItem`: there
 * is no author. `12-PERMISSION-MATRIX` §4 excludes staff from the client projection, so which
 * member of the agency typed the update is not a field the client is given. `published` is here
 * because the internal compose surface renders it — a client read only ever returns `true`.
 */
export interface PortalUpdate {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly published: boolean;
  readonly createdAt: string;
}

/**
 * The published updates timeline for one of the client's projects.
 *
 * The project is named in the path. The API answers 404 — not an empty list — for a project the
 * client cannot read, so the caller must treat a not-found as "not yours", never as "no updates".
 */
export async function listPortalUpdates(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly PortalUpdate[]> {
  const { data } = await client.request<{ updates: readonly PortalUpdate[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/updates`,
  });
  return data.updates;
}

export interface PostProjectUpdateInput {
  readonly title: string;
  readonly body: string;
  /** Optional; the API defaults to `true` — an update posted to the portal is meant to be seen. */
  readonly published?: boolean;
}

/**
 * The internal write — a project manager posting an update to a client's timeline.
 *
 * On the internal `projects` path, not `/portal`: posting is behind `project.manage`, which no
 * client role holds. The tenant and the author come from the session, never this body.
 */
export async function postProjectUpdate(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: PostProjectUpdateInput,
): Promise<PortalUpdate> {
  const { data } = await client.request<PortalUpdate>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates`,
    body: input,
  });
  return data;
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

/**
 * One published deliverable version, as the client is allowed to see it — CLIENT-002 (x114).
 *
 * Every content field is the x97 client-projection allowlist (`12-PERMISSION-MATRIX` §1) and no
 * more: no owner, no internal state, no draft, no content hash. `id` is the frozen version's own
 * id and `deliverableId` is what {@link listPortalDeliverableFiles} names. The absence is the
 * point, exactly as `PortalWorkItem`'s is — a screen cannot render what it was never given.
 */
export interface PortalDeliverable {
  readonly id: string;
  readonly deliverableId: string;
  readonly publishedAt: string;
  /** `12-PERMISSION-MATRIX` §1's "public/client title". */
  readonly title: string;
  readonly summary: string | null;
  /** `12-PERMISSION-MATRIX` §1's "milestone state". */
  readonly milestoneState: string | null;
  /** An ISO calendar date, or null. */
  readonly forecastDate: string | null;
  /** The client-visible risk, never the internal rationale. */
  readonly publishedRisk: string | null;
  readonly decision: string | null;
  readonly approvedContacts: readonly string[];
}

/**
 * One client-visible file attached to a deliverable — CLIENT-002 (x114).
 *
 * The metadata a list needs and no internal handle: no object key, no owner, no status. The
 * bytes are a later ticket (the portal download proxy); this says which files exist and how big.
 */
export interface PortalDeliverableFile {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
  readonly updatedAt: string;
}

export async function listPortalDeliverables(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly PortalDeliverable[]> {
  const { data } = await client.request<{ deliverables: readonly PortalDeliverable[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/deliverables`,
  });
  return data.deliverables;
}

export async function listPortalDeliverableFiles(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<readonly PortalDeliverableFile[]> {
  const { data } = await client.request<{ files: readonly PortalDeliverableFile[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/deliverables/${encodeURIComponent(deliverableId)}/files`,
  });
  return data.files;
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

// ─────────────────────────────────────────────────────────────────────────────
// The client inbox — INBOX-001's second half.

export type PortalInboxMode = 'all' | 'unread';

/**
 * One request and every notification the client has about it.
 *
 * `status` is the client-safe word `CL-06` uses, never an internal state; `requestId` is the
 * link target. There is no `objectType` because the portal has one bundle kind, and no
 * person because the projection has none.
 */
export interface PortalInboxBundle {
  readonly bundleId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ClientRequestStatus;
  readonly count: number;
  readonly unreadCount: number;
  readonly types: readonly string[];
  readonly latestAt: string;
  readonly action: { readonly kind: 'open' };
}

export interface PortalInboxPage {
  readonly items: readonly PortalInboxBundle[];
  readonly nextCursor: string | null;
}

/** The page the screen asks for — the API's default, for the internal inbox's reason. */
export const DEFAULT_PORTAL_INBOX_PAGE = 100;

export interface ListPortalInboxQuery {
  readonly mode?: PortalInboxMode;
  readonly before?: string;
  readonly limit?: number;
}

export async function listPortalInbox(
  client: ApiClient,
  organizationSlug: string,
  query: ListPortalInboxQuery = {},
): Promise<PortalInboxPage> {
  const parameters = new URLSearchParams();
  if (query.mode) parameters.set('mode', query.mode);
  if (query.before) parameters.set('before', query.before);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<PortalInboxPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/inbox${suffix}`,
  });
  return data;
}

export async function markPortalBundleRead(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<{ readonly bundleId: string; readonly marked: number }> {
  const { data } = await client.request<{ readonly bundleId: string; readonly marked: number }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/inbox/${encodeURIComponent(bundleId)}/read`,
  });
  return data;
}
