import type { ApiClient } from './client';

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
  /** The newest approval on this version, if it was ever sent. */
  readonly approval: {
    readonly id: string;
    readonly state: DeliverableApprovalState;
    readonly reviewerIds: readonly string[];
    readonly feedback: string | null;
    readonly decidedAt: string | null;
  } | null;
}

export interface DeliverableView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: DeliverableState;
  readonly latestVersionNo: number | null;
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
