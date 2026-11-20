import type { ApiClient } from './client';
import type { ImportedCopyReply } from './uploads';

/**
 * The team side of BG2 (0211): a project's deliverables, their versions, and "Send for approval".
 *
 * Every route is under `/v1/organizations/:org/deliverables` and every capability behind it is
 * internal-only, so a client principal never reaches these calls. The view types below mirror the
 * API's `deliverables.service.ts` views field for field and are paired `Exact` in
 * `e2e/contracts/api-web-shapes.ts`.
 */

export type DeliverableState = 'draft' | 'in_review' | 'changes_requested' | 'approved';

/** The approval state machine's states (`@tmanage/domain` `APPROVAL_STATES`). */
export type DeliverableApprovalState =
  | 'draft'
  | 'requested'
  | 'viewed'
  | 'approved'
  | 'changes_requested'
  | 'expired'
  | 'cancelled'
  | 'invalidated';

export interface DeliverableVersionView {
  readonly id: string;
  readonly versionNo: number | null;
  readonly fileAssetId: string | null;
  readonly fileVersionId: string | null;
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  /** UX-1: when the client got this version in the portal, or null while only the team sees it. */
  readonly sharedWithClientAt: string | null;
  /** The newest approval on this version, if it was ever sent. */
  readonly approval: {
    readonly id: string;
    readonly state: DeliverableApprovalState;
    readonly reviewerIds: readonly string[];
    readonly feedback: string | null;
    readonly decidedAt: string | null;
    /** QA-FIX-O H1: who was asked, at which address, and what happened to their e-mail. */
    readonly reviewers: readonly ApprovalReviewerView[];
    /** QA-FIX-O H1: the API's decision whether "Resend email" may be offered now. */
    readonly canResendEmail: boolean;
  } | null;
}

/** QA-FIX-O H1. What happened to one approver's approval-request e-mail. */
export type ApprovalEmailState = 'not_requested' | 'queued' | 'sent' | 'failed' | 'not_sent';

/** Why an e-mail was not sent; null when unknown or not applicable. */
export type ApprovalEmailCause = 'mail_off' | 'no_access' | 'no_transport';

/** QA-FIX-O H1. One approver of an approval, as the deliverable page shows them. */
export interface ApprovalReviewerView {
  readonly userId: string;
  /** Null when the person no longer belongs to a client of the project. */
  readonly displayName: string | null;
  /** Shown only to people who may send for approval; null otherwise or when unknown. */
  readonly email: string | null;
  readonly emailState: ApprovalEmailState;
  readonly emailCause: ApprovalEmailCause | null;
  readonly emailRequestedAt: string | null;
  readonly emailSettledAt: string | null;
}

export interface DeliverableView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: DeliverableState;
  readonly latestVersionNo: number | null;
  /** UX-1: whether the client can open this deliverable in the portal. */
  readonly sharedWithClient: boolean;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliverableDetailView extends DeliverableView {
  readonly versions: readonly DeliverableVersionView[];
}

export interface ApproverView {
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationName: string;
}

export interface SendForApprovalView {
  readonly approvalId: string;
  readonly deliverableVersionId: string;
  readonly state: DeliverableApprovalState;
  readonly reviewerIds: readonly string[];
}

export interface SendForApprovalInput {
  readonly approverIds: readonly string[];
  /** "Decision needed by", `YYYY-MM-DD`, or `null`. */
  readonly dueDate: string | null;
  /** "What should they check?" — the client sees it. */
  readonly checkNote: string | null;
  /** "Email the approver now". */
  readonly notify: boolean;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/deliverables`;
}

export async function listDeliverables(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly DeliverableView[]> {
  const { data } = await client.request<{ deliverables: readonly DeliverableView[] }>({
    path: `${base(organizationSlug)}?projectId=${encodeURIComponent(projectId)}`,
  });
  return data.deliverables;
}

export async function createDeliverable(
  client: ApiClient,
  organizationSlug: string,
  input: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string | null;
  },
): Promise<DeliverableView> {
  const { data } = await client.request<DeliverableView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function getDeliverable(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<DeliverableDetailView> {
  const { data } = await client.request<DeliverableDetailView>({
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}`,
  });
  return data;
}

export async function addDeliverableVersion(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  input: { readonly fileAssetId: string | null; readonly note: string | null },
): Promise<DeliverableVersionView> {
  const { data } = await client.request<DeliverableVersionView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/versions`,
    body: input,
  });
  return data;
}

/** FIX6 C1. The picked drive file the next version should use: provider ids only, never a link. */
export type CloudPick =
  | { readonly provider: 'google_drive'; readonly fileId: string }
  | { readonly provider: 'onedrive'; readonly driveId: string; readonly itemId: string };

/**
 * FIX6 C1. Copy a picked Google Drive or OneDrive file into TManage for this deliverable. The
 * server fetches it with the company connection and checks it like an upload; add the version
 * with {@link addDeliverableVersion} once the copy is usable (`importCloudFileFor`).
 */
export async function importCloudFileForDeliverable(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  pick: CloudPick,
): Promise<ImportedCopyReply> {
  const route = pick.provider === 'google_drive' ? 'drive-files' : 'onedrive-files';
  const { data } = await client.request<ImportedCopyReply>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/${route}`,
    body:
      pick.provider === 'google_drive'
        ? { fileId: pick.fileId }
        : { driveId: pick.driveId, itemId: pick.itemId },
  });
  return data;
}

export async function listApprovers(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<readonly ApproverView[]> {
  const { data } = await client.request<{ approvers: readonly ApproverView[] }>({
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/approvers`,
  });
  return data.approvers;
}

/** QA-FIX-O H1. "Resend email": mail the approvers of a pending approval again. */
export async function resendApprovalEmail(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  approvalId: string,
): Promise<DeliverableVersionView> {
  const { data } = await client.request<DeliverableVersionView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/approvals/${encodeURIComponent(approvalId)}/resend-email`,
  });
  return data;
}

export async function sendForApproval(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  versionId: string,
  input: SendForApprovalInput,
): Promise<SendForApprovalView> {
  const { data } = await client.request<SendForApprovalView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/versions/${encodeURIComponent(versionId)}/send`,
    body: input,
  });
  return data;
}

/**
 * UX-1 "Share with client": put the newest version in the client portal, with no approval and no
 * e-mail. The API checks `deliverable.publish` and whether the file may reach a client.
 */
export async function shareWithClient(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  versionId: string,
): Promise<{ readonly deliverableVersionId: string; readonly sharedWithClientAt: string }> {
  const { data } = await client.request<{
    readonly deliverableVersionId: string;
    readonly sharedWithClientAt: string;
  }>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/versions/${encodeURIComponent(versionId)}/share`,
  });
  return data;
}

/**
 * FIX6 item 8: delete a deliverable made by mistake (soft; it leaves the team list and the client
 * portal). The API allows the owner or a project manager, and never once the client approved it.
 */
export async function deleteDeliverable(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/delete`,
  });
}

/** FIX6 item 8: Undo a delete. */
export async function restoreDeliverable(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(deliverableId)}/restore`,
  });
}
