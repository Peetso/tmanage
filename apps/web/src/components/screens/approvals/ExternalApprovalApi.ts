import type { ApiClient } from '../../../lib/api/client';

/**
 * 52-18 — the account-less approver. Member side:
 * `POST|GET /v1/organizations/:org/deliverables/:d/versions/:v/external-approvals`
 * (`deliverable.publish`). Outsider side: the 56-07 link `GET|POST /v1/public/links/:token…`
 * with no session. Shapes mirror the API's `ExternalApproverView`, `SentExternalApproval` and
 * `OutsiderLinkView` for the `deliverable_version` target.
 */

export interface ExternalApprover {
  readonly id: string;
  readonly linkId: string;
  readonly email: string;
  readonly name: string | null;
  readonly message: string | null;
  readonly language: string;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly linkStatus: string;
  readonly expiresAt: string | null;
  readonly decision: string | null;
  readonly comment: string | null;
  readonly typedName: string | null;
  readonly emailVerified: boolean;
  readonly decidedAt: string | null;
}

export interface SentExternalApproval {
  readonly approver: ExternalApprover;
  readonly url: string;
  readonly mailed: boolean;
}

export interface SendExternalApprovalBody {
  readonly email: string;
  readonly name?: string;
  readonly message?: string;
  readonly expiresInDays: number;
  readonly language: 'en' | 'ar';
}

export interface ApproverProjection {
  readonly title: string;
  readonly versionNo: number | null;
  readonly hashTail?: string;
  readonly file: {
    readonly name: string;
    readonly mimeType: string | null;
    readonly sizeBytes: number | null;
  } | null;
}

export type ApproverLinkView =
  | { readonly state: 'expired' | 'revoked' | 'superseded' }
  | { readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }
  | {
      readonly state: 'active';
      readonly kind: string;
      readonly organizationName: string;
      readonly language: string;
      readonly decisions: readonly string[];
      readonly codeRequiredFor: readonly string[];
      readonly versionHash: string | null;
      readonly projection: ApproverProjection;
      readonly audienceHint: string | null;
    };

export type ApproverDecision = 'approve' | 'request_changes';

function memberPath(organizationSlug: string, deliverableId: string, versionId: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}/deliverables/` +
    `${encodeURIComponent(deliverableId)}/versions/${encodeURIComponent(versionId)}/external-approvals`
  );
}

function linkPath(token: string): string {
  return `/v1/public/links/${encodeURIComponent(token)}`;
}

export async function listExternalApprovers(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  versionId: string,
): Promise<readonly ExternalApprover[]> {
  const { data } = await client.request<{ readonly approvers: readonly ExternalApprover[] }>({
    path: memberPath(organizationSlug, deliverableId, versionId),
  });
  return data.approvers;
}

export async function sendExternalApproval(
  client: ApiClient,
  organizationSlug: string,
  deliverableId: string,
  versionId: string,
  body: SendExternalApprovalBody,
): Promise<SentExternalApproval> {
  const { data } = await client.request<SentExternalApproval>({
    method: 'POST',
    path: memberPath(organizationSlug, deliverableId, versionId),
    body,
  });
  return data;
}

export async function openApproverLink(
  client: ApiClient,
  token: string,
): Promise<ApproverLinkView> {
  const { data } = await client.request<ApproverLinkView>({
    path: linkPath(token),
    authentication: 'none',
  });
  return data;
}

export async function requestApproverCode(client: ApiClient, token: string): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${linkPath(token)}/code`,
    body: {},
    authentication: 'none',
  });
}

export async function decideAsApprover(
  client: ApiClient,
  token: string,
  body: {
    readonly decision: ApproverDecision;
    readonly versionHash: string | null;
    readonly code: string;
    readonly name?: string;
    readonly comment?: string;
  },
): Promise<{ readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }> {
  const { data } = await client.request<{
    readonly state: 'decided';
    readonly decision: string;
    readonly decidedAt: string;
  }>({
    method: 'POST',
    path: `${linkPath(token)}/decision`,
    body,
    authentication: 'none',
  });
  return data;
}
