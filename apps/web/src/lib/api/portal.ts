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

/**
 * The internal edit/unpublish response — x201.
 *
 * Distinct from {@link PortalUpdate}: this is the **internal** compose surface's view (behind
 * `project.manage`, never the client's read), so it carries `updatedAt` — the confirmation that
 * the edit or unpublish landed — which the client projection has no reason to see. It still leaks
 * no author, the same way `PortalUpdate` does not.
 */
export interface UpdateEdit {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A partial edit of an existing update. Either field may be sent; at least one must be. */
export interface EditProjectUpdateInput {
  readonly title?: string;
  readonly body?: string;
}

/**
 * Edit an update's title/body — x201. On the internal `projects` path behind `project.manage`. The
 * API answers 404 for an update the caller cannot manage or that is not in the named project.
 */
export async function editProjectUpdate(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  updateId: string,
  input: EditProjectUpdateInput,
): Promise<UpdateEdit> {
  const { data } = await client.request<UpdateEdit>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates/${encodeURIComponent(updateId)}`,
    body: input,
  });
  return data;
}

/**
 * Unpublish an update so it disappears from the client portal — x201. No body; the id is the whole
 * request. The returned row's `published` is `false`.
 */
export async function unpublishProjectUpdate(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  updateId: string,
): Promise<UpdateEdit> {
  const { data } = await client.request<UpdateEdit>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates/${encodeURIComponent(updateId)}/unpublish`,
  });
  return data;
}

/**
 * A comment on a project update as the **internal** compose surface is told it — SEC / Portal update
 * comments (x203). Carries `createdByUserId`: an internal manager may see who posted it. Never
 * fetched by a client screen.
 */
export interface UpdateComment {
  readonly id: string;
  readonly projectId: string;
  readonly updateId: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/**
 * A comment as the **portal** is told it — SEC / Portal update comments (x203).
 *
 * What is absent is the point, the same way it is for `PortalUpdate`: there is no author.
 * 12-PERMISSION-MATRIX §4 excludes staff from the client projection, so which member of the agency
 * posted the comment is not a field the client is given.
 */
export interface ClientUpdateComment {
  readonly id: string;
  readonly projectId: string;
  readonly updateId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** The full internal comment list for one update — behind `project.manage`, on the `projects` path. */
export async function listProjectUpdateComments(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  updateId: string,
): Promise<readonly UpdateComment[]> {
  const { data } = await client.request<{ comments: readonly UpdateComment[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates/${encodeURIComponent(updateId)}/comments`,
  });
  return data.comments;
}

export interface PostUpdateCommentInput {
  readonly body: string;
}

/**
 * The internal write — a project manager posting a comment on an update. On the internal `projects`
 * path behind `project.manage`; the tenant and the author come from the session, never this body.
 */
export async function postProjectUpdateComment(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  updateId: string,
  input: PostUpdateCommentInput,
): Promise<UpdateComment> {
  const { data } = await client.request<UpdateComment>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates/${encodeURIComponent(updateId)}/comments`,
    body: input,
  });
  return data;
}

/**
 * The comments on one of the client's published updates.
 *
 * The project and update are named in the path. The API answers 404 — not an empty list — for a
 * project the client cannot read or an update that is not theirs / not published, so the caller must
 * treat a not-found as "not yours", never as "no comments".
 */
export async function listPortalUpdateComments(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  updateId: string,
): Promise<readonly ClientUpdateComment[]> {
  const { data } = await client.request<{ comments: readonly ClientUpdateComment[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/updates/${encodeURIComponent(updateId)}/comments`,
  });
  return data.comments;
}

/**
 * A message as the **portal** is told it — SEC / Client portal messages (x322).
 *
 * What is absent is the point, the same way it is for `ClientUpdateComment`: there is no author, no
 * scope id and no tenant id. The client posts to and reads their own thread; the projection carries
 * only what the screen renders.
 */
export interface ClientMessage {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * A message as **staff** are shown it — the studio's inbound list on the portal admin. Carries which
 * client organization sent it and which contact authored it, behind `client_member.manage`.
 */
export interface AdminClientMessage {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly authorUserId: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface PostClientMessageInput {
  readonly subject: string;
  readonly body: string;
}

/**
 * Post a message to the studio from the portal — the client write. Behind `client_projection.read`;
 * the tenant, the client-org scope and the author come from the session, never this body.
 */
export async function postClientMessage(
  client: ApiClient,
  organizationSlug: string,
  input: PostClientMessageInput,
): Promise<ClientMessage> {
  const { data } = await client.request<ClientMessage>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/messages`,
    body: input,
  });
  return data;
}

/** The caller's own message thread — behind `client_projection.read`, on the `/portal` path. */
export async function listClientMessages(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ClientMessage[]> {
  const { data } = await client.request<{ messages: readonly ClientMessage[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/messages`,
  });
  return data.messages;
}

/**
 * The inbound messages for one client organization — staff read, behind `client_member.manage`. The
 * API resolves the client-org scope inside the acting tenant, so a cross-tenant id is a 404.
 */
export async function listInboundClientMessages(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
): Promise<readonly AdminClientMessage[]> {
  const { data } = await client.request<{ messages: readonly AdminClientMessage[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/messages/admin?clientOrganizationId=${encodeURIComponent(clientOrganizationId)}`,
  });
  return data.messages;
}

/** The milestone states a client is shown — 12-PERMISSION-MATRIX §4's "milestone state". */
export type MilestoneStatus = 'planned' | 'met' | 'missed';

/**
 * A milestone as the portal is told it — SEC / Portal milestones (x139).
 *
 * What is absent is the point, the same way it is for `PortalUpdate`: there is no author and no
 * publish flag. §4 excludes staff from the client projection, and a client only ever receives
 * published milestones, so neither is a field the client is given.
 */
export interface ClientMilestone {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** A 'YYYY-MM-DD' target day, or null when the date is not yet committed. */
  readonly dueOn: string | null;
  readonly status: MilestoneStatus;
  readonly createdAt: string;
}

/**
 * A milestone as an internal manager is shown it — the full record behind `project.manage`.
 *
 * `createdByUserId` and `published` are here because the internal compose/list surface renders
 * them; the client read never returns them.
 */
export interface ProjectMilestone {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: MilestoneStatus;
  readonly published: boolean;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/**
 * The published milestones for one of the client's projects — SEC / Portal milestones (x139).
 *
 * The project is named in the path. The API answers 404 — not an empty list — for a project the
 * client cannot read, so the caller must treat a not-found as "not yours", never as "no milestones".
 */
export async function listPortalMilestones(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ClientMilestone[]> {
  const { data } = await client.request<{ milestones: readonly ClientMilestone[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/milestones`,
  });
  return data.milestones;
}

/** The full internal milestones list for a project — behind `project.manage`, on the `projects` path. */
export async function listProjectMilestones(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectMilestone[]> {
  const { data } = await client.request<{ milestones: readonly ProjectMilestone[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/milestones`,
  });
  return data.milestones;
}

export interface CreateProjectMilestoneInput {
  readonly title: string;
  /** A 'YYYY-MM-DD' target day, or null. */
  readonly dueOn: string | null;
  readonly status: MilestoneStatus;
  /** Optional; the API defaults to `true` — a milestone created here is meant to be seen. */
  readonly published?: boolean;
}

/**
 * The internal write — a manager creating a milestone on a client's timeline.
 *
 * On the internal `projects` path, not `/portal`: creating is behind `project.manage`, which no
 * client role holds. The tenant and the author come from the session, never this body.
 */
export async function createProjectMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectMilestoneInput,
): Promise<ProjectMilestone> {
  const { data } = await client.request<ProjectMilestone>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/milestones`,
    body: input,
  });
  return data;
}

/**
 * A milestone after an internal edit or completion — SEC / Portal milestone lifecycle (x202).
 *
 * It is `ProjectMilestone` plus `updatedAt`: the edit/complete transitions record when they
 * happened, and for a completed milestone that instant is its completion date (there is no separate
 * `completed_at` column). Behind `project.manage`, on the internal `projects` path — never `/portal`,
 * so it carries the full internal record.
 */
export interface MilestoneEdit {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: MilestoneStatus;
  readonly published: boolean;
  readonly createdByUserId: string;
  readonly createdAt: string;
  /** An ISO-8601 instant — the last edit, and for a completed milestone its completion date. */
  readonly updatedAt: string;
}

/** A partial edit of a milestone — provide at least one field. Identity and publish are never here. */
export interface EditProjectMilestoneInput {
  readonly title?: string;
  /** A 'YYYY-MM-DD' target day, or null to clear the committed date. */
  readonly dueOn?: string | null;
}

/**
 * Edit a milestone's title and/or due date — SEC / Portal milestone lifecycle (x202).
 *
 * On the internal `projects` path behind `project.manage`; the tenant comes from the session and a
 * milestone the caller cannot manage answers 404, never 403.
 */
export async function editProjectMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  milestoneId: string,
  input: EditProjectMilestoneInput,
): Promise<MilestoneEdit> {
  const { data } = await client.request<MilestoneEdit>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
    body: input,
  });
  return data;
}

/** Mark a milestone complete (`status = met`) — SEC / Portal milestone lifecycle (x202). */
export async function completeProjectMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  milestoneId: string,
): Promise<MilestoneEdit> {
  const { data } = await client.request<MilestoneEdit>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/complete`,
  });
  return data;
}

/** The risk severities a client is shown — 12-PERMISSION-MATRIX §4's "published risk". */
export type RiskSeverity = 'low' | 'medium' | 'high';
/** The risk lifecycle states a client is shown. */
export type RiskStatus = 'open' | 'mitigated' | 'closed';

/**
 * A risk as the portal is told it — SEC / Portal risks (x140).
 *
 * What is absent is the point, the same way it is for `PortalUpdate` and `ClientMilestone`: there is
 * no title, no internal note, no author and no publish flag. §4 excludes staff and the internal note
 * from the client projection, and a client only ever receives published risks — so the client is
 * shown the client-facing summary, the severity and the status, and nothing else.
 */
export interface ClientRisk {
  readonly id: string;
  readonly projectId: string;
  readonly severity: RiskSeverity;
  readonly status: RiskStatus;
  readonly clientSummary: string;
  readonly createdAt: string;
}

/**
 * A risk as an internal manager is shown it — the full record behind `project.manage`.
 *
 * `title`, `internalNote`, `createdByUserId` and `published` are here because the internal
 * compose/list surface renders them; the client read never returns them.
 */
export interface ProjectRisk {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly severity: RiskSeverity;
  readonly status: RiskStatus;
  readonly internalNote: string | null;
  readonly clientSummary: string;
  readonly published: boolean;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/**
 * The published risks for one of the client's projects — SEC / Portal risks (x140).
 *
 * The project is named in the path. The API answers 404 — not an empty list — for a project the
 * client cannot read, so the caller must treat a not-found as "not yours", never as "no risks".
 */
export async function listPortalRisks(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ClientRisk[]> {
  const { data } = await client.request<{ risks: readonly ClientRisk[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/risks`,
  });
  return data.risks;
}

/** The full internal risks list for a project — behind `project.manage`, on the `projects` path. */
export async function listProjectRisks(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectRisk[]> {
  const { data } = await client.request<{ risks: readonly ProjectRisk[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/risks`,
  });
  return data.risks;
}

export interface CreateProjectRiskInput {
  readonly title: string;
  readonly severity: RiskSeverity;
  readonly status: RiskStatus;
  /** Optional internal-only detail; stored as null when omitted or empty. */
  readonly internalNote?: string | null;
  readonly clientSummary: string;
  /** Optional; the API defaults to `true` — a risk recorded here is meant to be seen. */
  readonly published?: boolean;
}

/**
 * The internal write — a manager recording a risk on a client's project.
 *
 * On the internal `projects` path, not `/portal`: recording is behind `project.manage`, which no
 * client role holds. The tenant and the author come from the session, never this body.
 */
export async function createProjectRisk(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectRiskInput,
): Promise<ProjectRisk> {
  const { data } = await client.request<ProjectRisk>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/risks`,
    body: input,
  });
  return data;
}

/**
 * A member of a project as the portal is told them — x142, `22-SCREEN-BY-SCREEN` §1 People.
 *
 * What is absent is the point, the same way it is for `PortalUpdate`: there is no email, no id,
 * no "last seen". `12-PERMISSION-MATRIX` §4 excludes staff from the client projection and gives
 * the client "approved contacts" — a name and a role, which is all a screen could render even if
 * it wanted more.
 */
export interface PortalPerson {
  readonly displayName: string;
  readonly role: string;
}

/**
 * The client-visible team of one of the client's projects.
 *
 * The project is named in the path. The API answers 404 — not an empty list — for a project the
 * client cannot read, so the caller must treat a not-found as "not yours", never as "no people".
 */
export async function listPortalPeople(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly PortalPerson[]> {
  const { data } = await client.request<{ people: readonly PortalPerson[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/people`,
  });
  return data.people;
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
  /** R4 slice 8. The proofing viewer can show this type (the row's "Review" button). */
  readonly reviewable: boolean;
  /** R4 slice 8. Open comments the client can see on this file. */
  readonly openComments: number;
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

/**
 * A file shared with the client on one of their projects — FILE-003 · WEB-006.
 *
 * The client projection of a `file_assets` row, built field by field like the others. There is no
 * `objectKey` (the storage literal), no owner, no internal status: a screen renders what it was
 * given, and it was given only what a client may see. `id` is the argument to the download door
 * ({@link portalFileDownloadPath}).
 */
export interface PortalFile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly uploadedAt: string;
  /**
   * C4. `clean` once the virus scan cleared it. Before that, the company owner's policy decides:
   * `not_scanned` downloads, labelled; `being_checked` cannot be downloaded until the scan is done.
   */
  readonly scanStatus: PortalFileScanStatus;
  /** R4 slice 8. The proofing viewer can show this type (the row's "Review" button). */
  readonly reviewable: boolean;
  /** R4 slice 8. Open comments the client can see on this file. */
  readonly openComments: number;
}

/** C4. Mirrors the API's `PortalFileScanStatus`. */
export type PortalFileScanStatus = 'clean' | 'not_scanned' | 'being_checked';

/**
 * The downloadable files on one of the client's projects.
 *
 * The project is named in the path. The API answers 404 — not an empty list — for a project the
 * client cannot read, so a not-found is "not yours", never "no files". Only files the download
 * door would treat as the client's are listed: a rejected or infected file never appears, and one
 * still waiting for its scan carries the owner's policy in `scanStatus`.
 */
export async function listPortalFiles(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly PortalFile[]> {
  const { data } = await client.request<{ files: readonly PortalFile[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/projects/${encodeURIComponent(projectId)}/files`,
  });
  return data.files;
}

/**
 * The path of the existing authenticated download door for one file (FILE-002 slice C).
 *
 * A `GET` the browser reaches with the session cookie; a safe method, so no CSRF token. The screen
 * builds an anchor to `${apiBaseUrl()}${this}` — the same route `listPortalFiles` promises the file
 * is servable on, so the list and the download can never name different things.
 */
export function portalFileDownloadPath(organizationSlug: string, fileAssetId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/files/${encodeURIComponent(fileAssetId)}/content`;
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
